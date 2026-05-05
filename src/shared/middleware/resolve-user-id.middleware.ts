import { Request, Response, NextFunction } from "express";
import { prisma } from "../lib/prisma";

/**
 * Middleware: resolveUserId
 *
 * Transparently converts a Clerk ID (user_xxx) in `req.query.userId` or
 * `req.body.userId` to the internal DB UUID before the request reaches any
 * controller.  The frontend never needs to know the internal UUID.
 *
 * - Non-Clerk values (already a UUID, or absent) are left unchanged.
 * - If the Clerk ID is not found in the DB the value is left as-is so the
 *   downstream handler can return an appropriate empty result or error.
 */
export async function resolveUserId(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const clerkId =
      (req.query.userId as string | undefined) ||
      (req.body?.userId as string | undefined);

    if (clerkId?.startsWith("user_")) {
      const user = await prisma.user.findUnique({ where: { clerkId } });
      if (user) {
        // Patch both locations so every downstream read sees the UUID
        if (req.query.userId) {
          (req.query as Record<string, string>).userId = user.id;
        }
        if (req.body?.userId) {
          req.body.userId = user.id;
        }
      }
    }
  } catch {
    // Never block the request — let the controller handle downstream errors
  }

  next();
}
