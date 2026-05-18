import { Request, Response, NextFunction } from "express";
import { AssistantService } from "./assistant.service";
import { getCurrentUserId } from "../auth/auth.middleware";
import { AppError } from "../../shared/middleware/error.middleware";
import { prisma } from "../../shared/lib/prisma";

const assistantService = new AssistantService();

async function resolveDbUserId(req: Request): Promise<string> {
  const clerkId = getCurrentUserId(req);
  if (!clerkId) throw new AppError(401, "Unauthorized");
  const user = await prisma.user.findUnique({
    where: { clerkId },
    select: { id: true },
  });
  if (!user) throw new AppError(404, "User not found");
  return user.id;
}

export const createChat = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = await resolveDbUserId(req);
    const { title } = req.body;
    const chat = await assistantService.createChat(userId, title);
    res.json({ success: true, data: chat });
  } catch (err) {
    next(err);
  }
};

export const listChats = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = await resolveDbUserId(req);
    const chats = await assistantService.listChats(userId);
    res.json({ success: true, data: chats });
  } catch (err) {
    next(err);
  }
};

export const renameChat = async (req: Request<{ chatId: string }>, res: Response, next: NextFunction) => {
  try {
    const userId = await resolveDbUserId(req);
    const { chatId } = req.params;
    const { title } = req.body;
    if (!title?.trim()) throw new AppError(400, "Title is required");
    const chat = await assistantService.renameChat(chatId, userId, title.trim());
    res.json({ success: true, data: chat });
  } catch (err) {
    next(err);
  }
};

export const deleteChat = async (req: Request<{ chatId: string }>, res: Response, next: NextFunction) => {
  try {
    const userId = await resolveDbUserId(req);
    const { chatId } = req.params;
    await assistantService.deleteChat(chatId, userId);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
};

export const getMessages = async (req: Request<{ chatId: string }>, res: Response, next: NextFunction) => {
  try {
    const userId = await resolveDbUserId(req);
    const { chatId } = req.params;
    const messages = await assistantService.getMessages(chatId, userId);
    res.json({ success: true, data: messages });
  } catch (err) {
    next(err);
  }
};

export const sendMessage = async (req: Request<{ chatId: string }>, res: Response, next: NextFunction) => {
  try {
    const userId = await resolveDbUserId(req);
    const { chatId } = req.params;
    const { query, aiModel } = req.body;
    if (!query?.trim()) throw new AppError(400, "Query is required");
    await assistantService.sendMessage(chatId, userId, query.trim(), aiModel, res);
  } catch (err) {
    next(err);
  }
};

export const getUserSessions = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const clerkId = getCurrentUserId(req);
    if (!clerkId) throw new AppError(401, "Unauthorized");
    const user = await prisma.user.findUnique({ where: { clerkId }, select: { id: true } });
    if (!user) {
      return res.json({ success: true, data: [] });
    }
    const sessions = await assistantService.getUserSessions(user.id);
    res.json({ success: true, data: sessions });
  } catch (err) {
    next(err);
  }
};

export const setSessionScope = async (req: Request<{ chatId: string }>, res: Response, next: NextFunction) => {
  try {
    const userId = await resolveDbUserId(req);
    const { chatId } = req.params;
    const { sessionId } = req.body;
    const chat = await assistantService.setSessionScope(chatId, userId, sessionId ?? null);
    res.json({ success: true, data: chat });
  } catch (err) {
    next(err);
  }
};
