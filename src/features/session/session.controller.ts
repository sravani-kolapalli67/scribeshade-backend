import { Request, Response } from "express";
import * as sessionService from "./session.service";
import { prisma } from "../../shared/lib/prisma";
import { SessionStatus } from "@prisma/client";
import { AppError } from "../../shared/middleware/error.middleware";
import { normalizeAIAnswerRequestBody } from "./ai-answer.dto";

/**
 * Handles the creation of a new session.
 */
export async function createSession(req: Request, res: Response) {
  try {
    const body = req.body || {};

    // Map fields from the request body (handles FormData string-to-boolean conversion as well as raw JSON)
    // Parse projectIds — may arrive as a JSON string (FormData) or array (JSON body)
    let projectIds: string[] = [];
    if (body.projectIds) {
      if (Array.isArray(body.projectIds)) {
        projectIds = body.projectIds;
      } else if (typeof body.projectIds === "string") {
        try { projectIds = JSON.parse(body.projectIds); } catch { /* ignore */ }
      }
    }

    const data = {
      userId: body.userId,
      companyName: body.companyName || body.company,
      jobDescription: body.jobDescription,
      resumeId: body.resumeId,
      language: body.language,
      extraContext: `${body.instructions || ""}\n${body.extraContext || ""}`.trim(),
      simpleLanguage: body.simpleLanguage === "true" || body.simpleLanguage === true,
      autoGenerateResponse: body.autoGenerateAI === "true" || body.autoGenerateAI === true,
      saveTranscription: body.saveTranscript === "true" || body.saveTranscript === true,
      mode: body.jobInputMode || "manual",
      free: body.free === "true" || body.free === true,
      DocumentId: body.DocumentId || body.documentId || "",
      projectIds,
    };

    if (!data.userId) {
      return res.status(400).json({ error: "userId is required" });
    }

    const session = await sessionService.createSession(data);

    return res.status(201).json({
      success: true,
      sessionId: session.id,
      data: session,
    });
  } catch (error: any) {
    console.error("Create Session Error:", error);
    if (error?.statusCode) {
      return res.status(error.statusCode).json({ error: error.message });
    }
    return res.status(500).json({
      success: false,
      error: "Internal server error",
    });
  }
}

/**
 * Lists all sessions for a user.
 */
export async function listSessions(req: Request, res: Response) {
  try {
    const userId = req.query.userId as string;
    if (!userId) {
      return res.status(400).json({ error: "userId is required" });
    }

    const filters = {
      search: req.query.search as string | undefined,
      from_date: req.query.from_date as string | undefined,
      to_date: req.query.to_date as string | undefined,
    };

    const sessions = await sessionService.getSessionsByUser(userId, filters);
    return res.json(sessions);
  } catch (error: any) {
    console.error("List Sessions Error:", error);
    return res
      .status(500)
      .json({ error: error.message || "Internal server error" });
  }
}

/**
 * Gets a specific session by ID.
 */
export async function getSession(req: Request, res: Response) {
  try {
    const id = req.params.id as string;
    if (!id) {
      return res.status(400).json({ error: "id is required" });
    }

    const session = await sessionService.getSessionById(id);
    if (!session) {
      return res.status(404).json({ error: "Session not found" });
    }

    // Strip transcript AND messages from response when user has opted out of transcript saving.
    // This prevents any data from being exposed or restored on page reload.
    const responseData =
      session.saveTranscription === false
        ? { ...session, transcript: [], messages: [] }
        : session;

    return res.json(responseData);
  } catch (error: any) {
    console.error("Get Session Error:", error);
    return res
      .status(500)
      .json({ error: error.message || "Internal server error" });
  }
}

/**
 * Deletes a session.
 */
export async function deleteSession(req: Request, res: Response) {
  try {
    const id = req.params.id as string;
    if (!id) {
      return res.status(400).json({ error: "id is required" });
    }

    const session = await sessionService.deleteSession(id);
    return res.json(session);
  } catch (error: any) {
    console.error("Delete Session Error:", error);
    const status = error instanceof AppError ? error.statusCode : 500;
    return res
      .status(status)
      .json({ error: error.message || "Internal server error" });
  }
}

/**
 * Activates a session.
 */
export async function activateSession(req: Request, res: Response) {
  try {
    const id = req.params.id as string;
    const body = req.body ?? {};
    const session = await sessionService.activateSession(id, {
      language:
        typeof body.language === "string" && body.language.trim().length > 0
          ? body.language.trim()
          : undefined,
      simpleLanguage:
        body.simpleLanguage === undefined
          ? undefined
          : body.simpleLanguage === "true" || body.simpleLanguage === true,
    });

    if (!session) {
      return res.status(404).json({ error: "Session not found" });
    }

    return res.json({
      success: true,
      sessionId: session.id,
      startedAt: session.startedAt,
      creditsHeld: session.creditsHeld,
      maxAllowedMinutes: session.maxAllowedMinutes,
      timer: 0,
    });
  } catch (error: any) {
    console.error("Activate Session Error:", error);
    const status = error?.statusCode ?? 500;
    return res.status(status).json({ error: error.message || "Internal server error" });
  }
}

/**
 * Deactivates a session.
 */
export async function deactivateSession(req: Request, res: Response) {
  try {
    const id = req.params.id as string;
    const { aiUsage, transcript } = req.body ?? {};
    const session = await sessionService.deactivateSession(id, aiUsage, transcript);

    // Auto-trigger analytics generation in the background.
    // Skip for ephemeral sessions — the user opted out of all transcript-related persistence.
    if (transcript && session.saveTranscription !== false) {
      sessionService.generateSessionFeedback(id, transcript).catch((err) => {
        console.error(`Background analytics generation failed for session ${id}:`, err);
      });
    }

    return res.json({ success: true, sessionId: id, status: session.status });
  } catch (error: any) {
    console.error("Deactivate Session Error:", error);
    const status = error?.statusCode ?? 500;
    return res.status(status).json({ error: error.message || "Internal server error" });
  }
}

/**
 * POST /api/session/:id/heartbeat
 * Body: { elapsedMinutes: number }
 * Frontend calls this every 60 s while session is ACTIVE to enforce maxAllowedMinutes.
 * Also stamps lastHeartbeatAt so the watchdog can detect stale/abandoned sessions.
 */
export async function sessionHeartbeat(req: Request, res: Response) {
  try {
    const id = req.params.id as string;

    const session = await prisma.session.findUnique({ where: { id } });
    if (!session || session.status !== SessionStatus.ACTIVE) {
      return res.json({ action: "NONE" });
    }

    // Stamp the heartbeat timestamp so the watchdog knows this session is alive
    await prisma.session.update({
      where: { id },
      data: { lastHeartbeatAt: new Date() },
    });

    // 1. Calculate actual elapsed minutes on the backend to prevent frontend manipulation
    const now = new Date();
    const startedAt = session.startedAt || session.createdAt;
    
    // total duration in seconds since start
    const totalElapsedSeconds = Math.floor((now.getTime() - startedAt.getTime()) / 1000);
    // subtract paused time
    const activeSeconds = Math.max(0, totalElapsedSeconds - session.pausedDurationSeconds);
    const backendElapsedMinutes = Math.floor(activeSeconds / 60);

    // 2. We can still accept elapsedMinutes from frontend as a secondary signal, but trust backend more
    const { elapsedMinutes } = (req.body ?? {}) as { elapsedMinutes?: number };
    const effectiveElapsed = Math.max(backendElapsedMinutes, elapsedMinutes || 0);

    const max = session.maxAllowedMinutes ?? Infinity;

    // 3. Enforce exhaustion
    if (effectiveElapsed >= max) {
      console.log(`[Heartbeat] Session ${id} exhausted. Elapsed: ${effectiveElapsed}, Max: ${max}`);
      await sessionService.creditExhaustionClose(id, session.userId);
      return res.json({ action: "CREDIT_EXHAUSTED", elapsedMinutes: effectiveElapsed });
    }

    // 4. Send warning if 1 minute remaining
    if (effectiveElapsed >= max - 1) {
      const { sseManager } = await import("../../shared/lib/sse");
      sseManager.notify(id, "CREDIT_WARNING", {
        remainingMinutes: max - effectiveElapsed,
        sessionId: id,
      });

      return res.json({
        action: "CREDIT_WARNING",
        remainingMinutes: max - effectiveElapsed,
        elapsedMinutes: effectiveElapsed,
      });
    }

    return res.json({ 
      action: "NONE", 
      remainingMinutes: max - effectiveElapsed,
      elapsedMinutes: effectiveElapsed
    });
  } catch (error: any) {
    console.error("Heartbeat Error:", error);
    return res
      .status(500)
      .json({ error: error.message || "Internal server error" });
  }
}

/**
 * GET /api/session/:id/events
 * Establishes an SSE connection for real-time session updates.
 */
export async function subscribeToEvents(req: Request, res: Response) {
  const id = req.params.id as string;

  // Set SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // Disable proxy buffering
  if (typeof (res as any).flushHeaders === "function") {
    (res as any).flushHeaders();
  }

  // Send initial keep-alive
  res.write(": connected\n\n");

  const { sseManager } = await import("../../shared/lib/sse");
  sseManager.addClient(id, res);
}

/**
 * Analyzes a screen screenshot and streams the raw AI response.
 */
export async function analyzeScreen(req: Request, res: Response) {
  try {
    const id = req.params.id as string;
    const file = req.file;
    const aiModel = req.body.aiModel;

    if (!file) {
      return res.status(400).json({ error: "No screenshot provided" });
    }

    const result = await sessionService.analyzeScreen(id, file, aiModel);

    // Set streaming headers (Plain text for easier frontend consumption)
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Transfer-Encoding", "chunked");
    res.setHeader("X-Accel-Buffering", "no");

    for await (const chunk of result as any) {
      if (chunk.text) {
        // Send raw text tokens directly
        res.write(chunk.text);
        
        if ((res as any).flush) {
          (res as any).flush();
        }
      }
    }

    res.end();
  } catch (error) {
    console.error("Analyze Screen Error:", error);
    if (!res.headersSent) {
      res.status(500).json({ error: "Failed to analyze screen" });
    } else {
      res.end();
    }
  }
}

export async function transcribe(req: Request, res: Response) {
  try {
    const file = req.file;
    if (!file) {
      return res.status(400).json({ error: "No audio provided" });
    }
    const result = await sessionService.transcribe(file);
    return res.json(result);
  } catch (error: any) {
    console.error("Transcribe Error:", error);
    return res
      .status(500)
      .json({ error: error.message || "Internal server error" });
  }
}

/**
 * Generates an AI answer based on a transcript and streams the raw AI response.
 */
export async function getAIAnswer(req: Request, res: Response) {
  try {
    const id = req.params.id as string;
    const { isCustomQuery, isRegenerate, regenerate, snapshotId, aiModel } = req.body;
    const isRegen = !!isRegenerate || !!regenerate;
    const normalized = normalizeAIAnswerRequestBody(req.body);
    const resolvedQuestion = normalized.resolvedQuestion;

    if (!resolvedQuestion && !snapshotId) {
      return res.status(400).json({ error: "No transcript or snapshotId provided" });
    }

    if (process.env.NODE_ENV !== "production") {
      const payloadKeys = Object.keys(req.body || {});
      console.log("[AI Answer Debug][BE] Raw request body:", req.body);
      console.log("[AI Answer Debug][BE] Normalized request object:", normalized);
      console.log("[AI Answer Debug] Request snapshot:", {
        isRegenerate: isRegen,
        regenerateTargetAnswerId:
          req.body?.regenerateTargetAnswerId || null,
        regenerateInstructionApplied: !!req.body?.regenerateInstruction,
        sourcePlatform: normalized.liveContextMetadata?.sourcePlatform || "unknown",
        payloadKeysReceived: payloadKeys,
        resolvedQuestion,
        resolvedFrom: normalized.resolvedFrom || "none",
        resolvedQuestionLength: resolvedQuestion?.length || 0,
        recentTranscriptWindowCount:
          normalized.liveContextMetadata?.recentTranscriptWindow?.length || 0,
        previousAiAnswerPresent:
          !!normalized.liveContextMetadata?.previousAiAnswer,
        selectedAnswerIdFromFrontend:
          normalized.liveContextMetadata?.selectedAnswerId || null,
        selectedAnswerQuestionPresent:
          !!normalized.liveContextMetadata?.selectedAnswerQuestion,
        selectedAnswerTextPresent:
          !!normalized.liveContextMetadata?.selectedAnswerText,
        selectedAnswerCodeBlocksCount:
          normalized.liveContextMetadata?.selectedAnswerCodeBlocks?.length || 0,
        answerMode: normalized.liveContextMetadata?.answerMode || "auto",
      });
      console.log("[AI Answer Debug][BE] Processing pipeline:", {
        step1: "normalizeAIAnswerRequestBody",
        step2: "resolvedQuestion priority: patchedTranscript > currentQuestion > transcript",
        step3: "sessionService.getAIAnswer(sessionId, resolvedQuestion, ...flags)",
      });
    }

    const result = await sessionService.getAIAnswer(
      id,
      resolvedQuestion || "",
      !!isCustomQuery,
      isRegen,
      aiModel,
      snapshotId,
      normalized.liveContextMetadata,
    );

    // Set streaming headers
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Transfer-Encoding", "chunked");
    res.setHeader("X-Accel-Buffering", "no");

    for await (const chunk of result as any) {
      if (chunk.text) {
        res.write(chunk.text);
        
        if ((res as any).flush) {
          (res as any).flush();
        }
      }
    }

    res.end();
  } catch (error: any) {
    console.error("AI Answer Error:", error);
    if (!res.headersSent) {
      res.status(500).json({ error: error.message || "Internal server error" });
    } else {
      res.end();
    }
  }
}

/**
 * Manually saves a message to the session history.
 */
export async function saveMessage(req: Request, res: Response) {
  try {
    const id = req.params.id as string;
    const { role, question, answer, time, messageId } = req.body;

    if (!role || !question) {
      return res.status(400).json({ error: "role and question are required" });
    }

    const updatedSession = await sessionService.appendMessage(
      id,
      role as any,
      question,
      answer ?? "",
      time,
      undefined,
      messageId
    );
    // appendMessage returns undefined for ephemeral sessions (saveTranscription === false).
    // Respond with an empty messages array so the client behaves consistently.
    return res.json({ success: true, messages: updatedSession?.messages ?? [] });
  } catch (error: any) {
    console.error("Save Message Error:", error);
    return res
      .status(500)
      .json({ error: error.message || "Internal server error" });
  }
}

export async function patchTranscriptMessage(req: Request, res: Response) {
  try {
    const id = req.params.id as string;
    const messageId = req.params.messageId as string;
    const { patchedText, originalText, patchedAt, patchedByUser, sender, timestamp } = req.body ?? {};

    if (!id || !messageId || !patchedText) {
      return res.status(400).json({ error: "session id, messageId and patchedText are required" });
    }

    const updated = await sessionService.patchTranscriptMessage(id, messageId, {
      patchedText,
      originalText,
      patchedAt,
      patchedByUser,
      sender,
      timestamp,
    });

    return res.json({ success: true, data: updated });
  } catch (error: any) {
    console.error("Patch Transcript Message Error:", error);
    return res.status(500).json({ error: error.message || "Internal server error" });
  }
}

/**
 * Gets or generates analytics for a specific session.
 */
export async function getExistingAnalytics(req: Request, res: Response) {
  try {
    const id = req.params.id as string;
    const existing = await prisma.sessionFeedback.findUnique({ where: { sessionId: id } });
    if (!existing) return res.status(404).json({ error: "No analytics found" });
    return res.json(existing);
  } catch (error: any) {
    console.error("Get Existing Analytics Error:", error);
    return res.status(500).json({ error: error.message || "Internal server error" });
  }
}

export async function getSessionAnalytics(req: Request, res: Response) {
  try {
    const id = req.params.id as string;
    const force = req.query.force === "true";

    if (!id) {
      return res.status(400).json({ error: "id is required" });
    }

    if (!force) {
      // 1. Check if SessionFeedback already exists
      const existingFeedback = await prisma.sessionFeedback.findUnique({
        where: { sessionId: id },
      });

      if (existingFeedback) {
        return res.json(existingFeedback);
      }
    }

    // 2. Generate new feedback if it doesn't exist or force is true
    const newFeedback = await sessionService.generateSessionFeedback(id);
    return res.json(newFeedback);

  } catch (error: any) {
    console.error("Get Session Analytics Error:", error);
    return res
      .status(500)
      .json({ error: error.message || "Internal server error" });
  }
}

/**
 * Explicitly triggers the generation of analytics for a session.
 * Allows passing a transcript in the body for immediate analysis.
 */
export async function generateSessionAnalytics(req: Request, res: Response) {
  try {
    const id = req.params.id as string;
    const { transcript } = req.body;

    if (!id) {
      return res.status(400).json({ error: "id is required" });
    }

    const feedback = await sessionService.generateSessionFeedback(id, transcript);
    return res.json({
      success: true,
      data: feedback
    });
  } catch (error: any) {
    console.error("Generate Session Analytics Error:", error);
    return res
      .status(500)
      .json({ error: error.message || "Internal server error" });
  }
}
