import { NextFunction, Request, Response } from "express";
import { AppError } from "../../shared/middleware/error.middleware";
import { prisma } from "../../shared/lib/prisma";
import { getCurrentUserId } from "../auth/auth.middleware";
import { projectGenerationRequestSchema } from "./ai.types";
import * as aiService from "./ai.service";

export async function generateProjectGeneration(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const clerkId = getCurrentUserId(req);
    const user = await prisma.user.findUnique({ where: { clerkId } });
    if (!user) {
      return next(new AppError(404, "User not found"));
    }

    const payload = projectGenerationRequestSchema.parse(req.body ?? {});
    const data = await aiService.generateProjectGeneration(user.id, payload);

    return res.json({ success: true, data });
  } catch (error) {
    return next(error);
  }
}

export async function getProjectCategories(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const roleType = (req.query.role_type as string | undefined) || "general";
    const data = aiService.getProjectCategories(roleType);
    return res.json({ success: true, data });
  } catch (error) {
    return next(error);
  }
}
