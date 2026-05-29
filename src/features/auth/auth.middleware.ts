import { clerkMiddleware, getAuth } from "@clerk/express";
import { NextFunction, Request, Response } from "express";
import { AppError } from "../../shared/middleware/error.middleware";

// Test mode bypass key - ONLY for testing purposes
const TEST_BYPASS_KEY = process.env.TEST_BYPASS_KEY || "test-bypass-key-scribeshade-2026";
const IS_TEST_MODE = process.env.NODE_ENV === "development" || process.env.ENABLE_TEST_BYPASS === "true";

// Global middleware — attaches Clerk auth state to every request
// Bypasses Clerk auth if TEST_BYPASS_KEY header is present (test mode only)
export const clerkAuth = (req: Request, res: Response, next: NextFunction) => {
  // Check for test bypass in development/test mode BEFORE Clerk middleware
  if (IS_TEST_MODE && req.headers["x-test-bypass-key"] === TEST_BYPASS_KEY) {
    console.log("⚠️  TEST MODE: Clerk auth bypassed via test key");
    // Attach mock auth data to request
    (req as any).auth = {
      userId: req.headers["x-test-user-id"] || "test-user-id-bypass",
      claims: null,
    };
    return next();
  }

  // Otherwise, use normal Clerk middleware
  return clerkMiddleware()(req, res, next);
};

// Route-level guard — rejects requests without a valid Clerk session
// Bypasses auth if TEST_BYPASS_KEY header is present (test mode only)
export const requireAuth = (
  req: Request,
  _res: Response,
  next: NextFunction,
) => {
  try {
    // Check for test bypass in development/test mode
    if (IS_TEST_MODE && req.headers["x-test-bypass-key"] === TEST_BYPASS_KEY) {
      console.log("⚠️  TEST MODE: Auth bypassed via test key");
      return next();
    }

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
// Returns test user ID if bypass key is present (test mode only)
export const getCurrentUserId = (req: Request): string => {
  try {
    // Check for test bypass in development/test mode
    if (IS_TEST_MODE && req.headers["x-test-bypass-key"] === TEST_BYPASS_KEY) {
      console.log("⚠️  TEST MODE: Using test user ID via bypass key");
      // Return a test user ID or look up from header
      const testUserId = req.headers["x-test-user-id"] as string;
      if (testUserId) {
        return testUserId;
      }
      // Return a default test user ID if not provided
      return "test-user-id-bypass";
    }

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
