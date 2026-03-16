import { clerkMiddleware, getAuth } from "@clerk/express";
import { NextFunction, Request, Response } from "express";
import { AppError } from "../../shared/middleware/error.middleware";

// Export the global middleware
export const clerkAuth = clerkMiddleware();

// Route-level guard
export const requireAuth = (req: Request, res: Response, next: NextFunction) => {
  const { userId } = getAuth(req);
  if (!userId) {
    throw new AppError(401, "Unauthorized: Authentication required");
  }
  next();
};

// Helper for extracting userId safely
export const getCurrentUserId = (req: Request): string => {
  const { userId } = getAuth(req);
  if (!userId) {
    throw new AppError(401, "Unauthorized: Authentication required");
  }
  return userId;
};
