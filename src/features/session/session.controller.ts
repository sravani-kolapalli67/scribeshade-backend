import { Request, Response } from "express";
import * as sessionService from "./session.service";

/**
 * Handles the creation of a new session.
 */
export async function createSession(req: Request, res: Response) {
  try {
    const body = req.body || {};

    // Map fields from the request body (handles FormData string-to-boolean conversion)
    const data = {
      userId: body.userId,
      companyName: body.companyName,
      jobDescription: body.jobDescription,
      resumeId: body.resumeId,
      language: body.language,
      extraContext: body.extraContext,
      simpleLanguage: body.simpleLanguage === "true",
      autoGenerateResponse: body.autoGenerateAI === "true",
      saveTranscription: body.saveTranscript === "true",
      mode: body.jobInputMode || "manual",
      free: body.free === "true",
      DocumentId: "", // Update if you implement doc storage
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
  } catch (error) {
    console.error("Create Session Error:", error);
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

    const sessions = await sessionService.getSessionsByUser(userId);
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

    return res.json(session);
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
    return res
      .status(500)
      .json({ error: error.message || "Internal server error" });
  }
}

/**
 * Activates a session.
 */
export async function activateSession(req: Request, res: Response) {
  try {
    const id = req.params.id as string;
    const session = await sessionService.activateSession(id);

    return res.json({
      success: true,
      sessionId: session.id,
      startedAt: session.startedAt,
      timer: 0,
    });
  } catch (error: any) {
    console.error("Activate Session Error:", error);
    return res
      .status(500)
      .json({ error: error.message || "Internal server error" });
  }
}

/**
 * Deactivates a session.
 */
export async function deactivateSession(req: Request, res: Response) {
  try {
    const id = req.params.id as string;
    await sessionService.deactivateSession(id);
    return res.json({ success: true });
  } catch (error: any) {
    console.error("Deactivate Session Error:", error);
    return res
      .status(500)
      .json({ error: error.message || "Internal server error" });
  }
}

/**
 * Analyzes a screen screenshot and streams the AI response.
 */
export async function analyzeScreen(req: Request, res: Response) {
  try {
    const id = req.params.id as string;
    const file = req.file;

    if (!file) {
      return res.status(400).json({ error: "No screenshot provided" });
    }

    const result = await sessionService.analyzeScreen(id, file);

    // If we hit the rate limit fallback, it returns an object with a text string
    // if (result && !(Symbol.asyncIterator in Object(result)) && (result as any).text) {
    //   res.setHeader("Content-Type", "text/plain; charset=utf-8");
    //   return res.send((result as any).text);
    // }

    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Transfer-Encoding", "chunked");

    let fullResponse = "";
    for await (const chunk of result as any) {
      if (chunk.text) {
        fullResponse += chunk.text;
        res.write(chunk.text);
      }
    }

    if (fullResponse) {
      await sessionService.appendMessage(id, "AI_ASSISTANT", fullResponse);
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
 * Generates an AI answer based on a transcript and streams the response.
 */
export async function getAIAnswer(req: Request, res: Response) {
  try {
    const id = req.params.id as string;
    const { transcript } = req.body;

    if (!transcript) {
      return res.status(400).json({ error: "No transcript provided" });
    }

    const result = await sessionService.getAIAnswer(id, transcript);

    // Set headers for streaming
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Transfer-Encoding", "chunked");

    let fullResponse = "";
    for await (const chunk of result as any) {
      if (chunk.text) {
        fullResponse += chunk.text;
        res.write(chunk.text);
      }
    }

    if (fullResponse) {
      await sessionService.appendMessage(id, "AI_ASSISTANT", fullResponse);
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
    const { role, content } = req.body;

    if (!role || !content) {
      return res.status(400).json({ error: "role and content are required" });
    }

    const updatedSession = await sessionService.appendMessage(
      id,
      role as any,
      content,
    );
    return res.json({ success: true, messages: updatedSession.messages });
  } catch (error: any) {
    console.error("Save Message Error:", error);
    return res
      .status(500)
      .json({ error: error.message || "Internal server error" });
  }
}

