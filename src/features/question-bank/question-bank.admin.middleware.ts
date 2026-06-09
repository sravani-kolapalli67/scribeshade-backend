import { getAuth } from "@clerk/express";
import { NextFunction, Request, Response } from "express";
import { AppError } from "../../shared/middleware/error.middleware";
import { getCurrentUserId } from "../auth/auth.middleware";

function adminClerkIds(): Set<string> {
  return new Set(
    (process.env.QUESTION_BANK_ADMIN_CLERK_IDS || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
}

function claimValue(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const stringValue = value.find((entry) => typeof entry === "string");
    return typeof stringValue === "string" ? stringValue : undefined;
  }
  return undefined;
}

export function requireQuestionBankAdmin(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  try {
    const clerkId = getCurrentUserId(req);
    const allowedIds = adminClerkIds();
    if (allowedIds.has(clerkId)) {
      next();
      return;
    }

    const auth = getAuth(req);
    const claims = auth.sessionClaims as Record<string, unknown> | undefined;
    const role = claimValue(claims?.role || claims?.adminRole || claims?.["https://scribeshade.com/role"]);

    if (role === "admin" || role === "question_bank_admin") {
      next();
      return;
    }

    next(new AppError(403, "Question Bank admin access required"));
  } catch (error) {
    next(error);
  }
}
