/**
 * idempotency.middleware.ts
 *
 * Extracts the `Idempotency-Key` header (or `X-Idempotency-Key` fallback),
 * validates it as a UUID, and attaches it to `req.idempotencyKey` for
 * downstream handlers. The key is OPTIONAL — handlers that need strict
 * idempotency should reject when missing.
 *
 * Why a UUID? Stable, collision-free, easy to generate on web + native
 * clients via `crypto.randomUUID()`.
 */

import { NextFunction, Request, Response } from "express";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      idempotencyKey?: string | null;
    }
  }
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function idempotencyKeyMiddleware(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  const raw =
    (req.header("idempotency-key") || req.header("x-idempotency-key") || "")
      .trim()
      .toLowerCase();

  if (!raw) {
    req.idempotencyKey = null;
    return next();
  }

  if (!UUID_RE.test(raw)) {
    // Don't 400 — just ignore bad keys so legacy clients keep working. The
    // wrapper will treat the request as non-idempotent.
    req.idempotencyKey = null;
    return next();
  }

  req.idempotencyKey = raw;
  return next();
}
