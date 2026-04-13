import { clerkMiddleware, getAuth } from "@clerk/express";
import { NextFunction, Request, Response } from "express";
import { AppError } from "../../shared/middleware/error.middleware";

// Global middleware — attaches Clerk auth state to every request
export const clerkAuth = clerkMiddleware();

// Route-level guard — rejects requests without a valid Clerk session
export const requireAuth = (
  req: Request,
  _res: Response,
  next: NextFunction,
) => {
  try {
    const { userId } = getAuth(req);
    // console.log("🚀 ~ userId:", userId);
    if (!userId) {
      return next(new AppError(401, "Unauthorized: Authentication required"));
    }
    next();
  } catch (err) {
    next(new AppError(401, "Unauthorized: Invalid or expired token"));
  }
};

// Helper — extracts userId from request or throws if missing
export const getCurrentUserId = (req: Request): string => {
  try {
    const { userId } = getAuth(req);
    if (!userId) {
      throw new AppError(401, "Unauthorized: Authentication required");
    }
    console.log("🚀 ~ userId:", userId);
    return userId;
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError(401, "Unauthorized: Failed to parse authentication");
  }
};
