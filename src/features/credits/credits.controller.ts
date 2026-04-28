import { Request, Response, NextFunction } from "express";
import { getCurrentUserId } from "../auth/auth.middleware";
import { AppError } from "../../shared/middleware/error.middleware";
import { prisma } from "../../shared/lib/prisma";
import * as creditsService from "./credits.service";

/**
 * GET /api/credits/balance
 * Returns the authenticated user's credit balance.
 */
export async function getBalance(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const clerkId = getCurrentUserId(req);
    const user = await prisma.user.findUnique({ where: { clerkId } });
    if (!user) return next(new AppError(404, "User not found"));

    const balance = await creditsService.getCreditBalance(user.id);
    return res.json({ success: true, data: balance });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/credits/ledger
 * Returns paginated ledger entries for the authenticated user.
 * Query params: page (default 1), limit (default 20, max 100)
 */
export async function getLedger(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const clerkId = getCurrentUserId(req);
    const user = await prisma.user.findUnique({ where: { clerkId } });
    if (!user) return next(new AppError(404, "User not found"));

    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
    const skip = (page - 1) * limit;

    const [entries, total] = await Promise.all([
      prisma.creditLedger.findMany({
        where: { userId: user.id },
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
      }),
      prisma.creditLedger.count({ where: { userId: user.id } }),
    ]);

    return res.json({
      success: true,
      data: entries,
      pagination: { total, page, limit, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/credits/brackets
 * Returns all active bracket configurations (public — no auth required).
 */
export async function getBrackets(
  _req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const brackets = await creditsService.getActiveBrackets();
    return res.json({ success: true, data: brackets });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/credits/plans
 * Returns default credit purchase plans for interview sessions.
 * Query params: currency (INR | USD | GBP, default INR)
 */
export async function getPlans(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const currency = req.query.currency as string | undefined;
    const plans = creditsService.getInterviewCreditPlans(currency);
    return res.json({
      success: true,
      data: plans,
      feature: "INTERVIEW_SESSION",
    });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/credits/purchase/order
 * Creates Razorpay order and a pending credit purchase record.
 */
export async function createPurchaseOrder(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const clerkId = getCurrentUserId(req);
    const user = await prisma.user.findUnique({ where: { clerkId } });
    if (!user) return next(new AppError(404, "User not found"));

    const { packCode, currency } = (req.body ?? {}) as {
      packCode?: string;
      currency?: string;
    };

    if (!packCode) {
      return next(new AppError(400, "packCode is required"));
    }

    const order = await creditsService.createPurchaseOrder(user.id, packCode, currency);

    return res.status(201).json({
      success: true,
      data: order,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/credits/purchase/verify
 * Verifies Razorpay payment signature and credits user balance.
 */
export async function verifyPurchase(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const clerkId = getCurrentUserId(req);
    const user = await prisma.user.findUnique({ where: { clerkId } });
    if (!user) return next(new AppError(404, "User not found"));

    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
    } = (req.body ?? {}) as {
      razorpay_order_id?: string;
      razorpay_payment_id?: string;
      razorpay_signature?: string;
    };

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return next(
        new AppError(
          400,
          "razorpay_order_id, razorpay_payment_id and razorpay_signature are required",
        ),
      );
    }

    const result = await creditsService.verifyAndConfirmPurchase(
      user.id,
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
    );

    return res.json({
      success: true,
      data: result,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/credits/purchases
 * Returns the authenticated user's purchase history.
 */
export async function getPurchases(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const clerkId = getCurrentUserId(req);
    const user = await prisma.user.findUnique({ where: { clerkId } });
    if (!user) return next(new AppError(404, "User not found"));

    const purchases = await prisma.creditPurchase.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: "desc" },
    });

    return res.json({ success: true, data: purchases });
  } catch (err) {
    next(err);
  }
}
