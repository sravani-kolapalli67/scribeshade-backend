import { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import { env } from "../../config/env";

export class AppError extends Error {
  constructor(public statusCode: number, message: string) {
    super(message);
    this.name = "AppError";
  }
}

export const errorMiddleware = (
  err: any,
  req: Request,
  res: Response,
  next: NextFunction
) => {
  console.error(`[Error] ${err.name}: ${err.message}`);

  if (err instanceof ZodError) {
    return res.status(400).json({
      error: "Validation Error",
      details: err.flatten(),
    });
  }

  if (err instanceof AppError) {
    return res.status(err.statusCode).json({
      error: err.message,
    });
  }

  // Clerk specific errors usually have a name or status
  if (err.clerkError || err.name?.includes("Clerk")) {
    return res.status(err.status || 401).json({
      error: "Authentication Error",
      message: err.message,
    });
  }

  const statusCode = err.status || err.statusCode || 500;
  const message =
    env.NODE_ENV === "production" && statusCode === 500
      ? "Internal Server Error"
      : err.message;

  return res.status(statusCode).json({
    error: message,
    ...(env.NODE_ENV === "development" && { stack: err.stack }),
  });
};
