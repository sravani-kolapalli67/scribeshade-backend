import { NextFunction, Request, Response } from "express";
import { SessionAnswerRevisionSource } from "@prisma/client";
import { z } from "zod";
import { getCurrentUserId } from "../auth/auth.middleware";
import {
  applyAnswerEdit,
  createAnswerPreview,
  listAnswerRevisions,
  restoreAnswerRevision,
  StaleAnswerVersionError,
} from "./post-session-answer.service";
import { POST_SESSION_AI_MODES } from "./post-session-answer.types";

const previewSchema = z
  .object({
    mode: z.enum(POST_SESSION_AI_MODES),
    instruction: z.string().trim().max(1000).optional(),
    baseVersion: z.number().int().min(0),
  })
  .superRefine((value, context) => {
    if (value.mode === "custom" && !value.instruction) {
      context.addIssue({
        code: "custom",
        path: ["instruction"],
        message: "instruction is required for custom editing",
      });
    }
  });

const applySchema = z.object({
  answer: z.string().trim().min(1).max(50000),
  baseVersion: z.number().int().min(0),
  source: z.enum(["manual", "ai_rewrite", "ai_regenerate"]),
  aiMode: z.enum(POST_SESSION_AI_MODES).optional(),
  instruction: z.string().trim().max(1000).optional(),
  model: z.string().trim().max(200).optional(),
});

const restoreSchema = z.object({
  baseVersion: z.number().int().min(0),
});

const previewInFlight = new Set<string>();

function params(req: Request): {
  sessionId: string;
  messageId: string;
} {
  return {
    sessionId: String(req.params.sessionId || "").trim(),
    messageId: String(req.params.messageId || "").trim(),
  };
}

function sendStaleVersion(
  res: Response,
  error: StaleAnswerVersionError,
): Response {
  return res.status(409).json({
    error: error.message,
    code: "STALE_ANSWER_VERSION",
    latestAnswer: error.latestAnswer,
    latestVersion: error.latestVersion,
  });
}

export async function previewAnswerEdit(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<Response | void> {
  let lockKey: string | undefined;
  try {
    const { sessionId, messageId } = params(req);
    const clerkId = getCurrentUserId(req);
    const input = previewSchema.parse(req.body);
    lockKey = `${clerkId}:${sessionId}:${messageId}`;
    if (previewInFlight.has(lockKey)) {
      return res.status(409).json({
        error: "An AI preview is already running for this answer",
        code: "DUPLICATE_IN_FLIGHT",
      });
    }

    previewInFlight.add(lockKey);
    const preview = await createAnswerPreview(
      sessionId,
      messageId,
      clerkId,
      input.mode,
      input.instruction,
      input.baseVersion,
    );
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Transfer-Encoding", "chunked");
    res.setHeader("X-Accel-Buffering", "no");
    res.setHeader("X-AI-Model", preview.model);
    for await (const delta of preview.stream) {
      if (delta) res.write(delta);
    }
    return res.end();
  } catch (error) {
    if (error instanceof StaleAnswerVersionError) {
      return sendStaleVersion(res, error);
    }
    if (res.headersSent) {
      res.end();
      return;
    }
    next(error);
  } finally {
    if (lockKey) previewInFlight.delete(lockKey);
  }
}

export async function updateAnswer(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<Response | void> {
  try {
    const { sessionId, messageId } = params(req);
    const clerkId = getCurrentUserId(req);
    const input = applySchema.parse(req.body);
    const source =
      input.source === "manual"
        ? SessionAnswerRevisionSource.MANUAL
        : input.source === "ai_regenerate"
          ? SessionAnswerRevisionSource.AI_REGENERATE
          : SessionAnswerRevisionSource.AI_REWRITE;
    const result = await applyAnswerEdit(sessionId, messageId, clerkId, {
      ...input,
      source,
    });
    return res.json({ success: true, data: result });
  } catch (error) {
    if (error instanceof StaleAnswerVersionError) {
      return sendStaleVersion(res, error);
    }
    next(error);
  }
}

export async function getAnswerRevisions(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<Response | void> {
  try {
    const { sessionId, messageId } = params(req);
    const clerkId = getCurrentUserId(req);
    const result = await listAnswerRevisions(
      sessionId,
      messageId,
      clerkId,
    );
    return res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
}

export async function restoreRevision(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<Response | void> {
  try {
    const { sessionId, messageId } = params(req);
    const revisionId = String(req.params.revisionId || "").trim();
    const clerkId = getCurrentUserId(req);
    const input = restoreSchema.parse(req.body);
    const result = await restoreAnswerRevision(
      sessionId,
      messageId,
      revisionId,
      clerkId,
      input.baseVersion,
    );
    return res.json({ success: true, data: result });
  } catch (error) {
    if (error instanceof StaleAnswerVersionError) {
      return sendStaleVersion(res, error);
    }
    next(error);
  }
}
