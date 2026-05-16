import { Request, Response, NextFunction } from "express";
import { AskAiService } from "./ask-ai.service";
import { AppError } from "../../shared/middleware/error.middleware";
import { prisma } from "../../shared/lib/prisma";

const askAiService = new AskAiService();

/**
 * Resolves the internal database user ID from the session.
 * We trust the sessionId to ground the request to the correct owner.
 */
async function resolveUserIdFromSession(sessionId: string) {
  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    select: { userId: true }
  });
  
  if (!session) {
    console.error(`[AskAI] Session ${sessionId} not found in database`);
    throw new AppError(404, "Session not found in ScribeShade database");
  }
  
  return session.userId;
}

export const askQuestion = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { sessionId } = req.params as { sessionId: string };
    const { query } = req.body;
    
    console.log(`[AskAI] Querying for session: ${sessionId}`);
    const userId = await resolveUserIdFromSession(sessionId);
    await askAiService.askQuestion(sessionId, userId, query, res);
  } catch (error) {
    next(error);
  }
};

export const getHistory = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { sessionId } = req.params as { sessionId: string };
    
    console.log(`[AskAI] Fetching history for session: ${sessionId}`);
    const userId = await resolveUserIdFromSession(sessionId);
    const history = await askAiService.getChatHistory(sessionId, userId);
    res.json({ success: true, data: history });
  } catch (error) {
    next(error);
  }
};

export const clearHistory = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { sessionId } = req.params as { sessionId: string };
    
    console.log(`[AskAI] Clearing history for session: ${sessionId}`);
    const userId = await resolveUserIdFromSession(sessionId);
    await askAiService.clearChat(sessionId, userId);
    res.json({ success: true, message: "Chat history cleared" });
  } catch (error) {
    next(error);
  }
};

export const indexSession = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { sessionId } = req.params as { sessionId: string };
    
    console.log(`[AskAI] Indexing session: ${sessionId}`);
    const userId = await resolveUserIdFromSession(sessionId);
    const result = await askAiService.indexSession(sessionId, userId);
    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
};
