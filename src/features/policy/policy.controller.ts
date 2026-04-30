import { Request, Response, NextFunction } from "express";
import * as policyService from "./policy.service";
import { AppError } from "../../shared/middleware/error.middleware";

/**
 * GET /api/policy
 * Returns the latest privacy policy and terms and conditions.
 */
export async function getPolicy(
  _req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const policy = await policyService.getPolicy();
    if (!policy) {
      return res.json({
        success: true,
        data: {
          privacyPolicy: "",
          termsAndConditions: "",
        },
      });
    }
    return res.json({ success: true, data: policy });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/policy
 * Creates or updates the privacy policy and terms and conditions.
 */
export async function updatePolicy(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const { privacyPolicy, termsAndConditions } = (req.body ?? {}) as {
      privacyPolicy?: string;
      termsAndConditions?: string;
    };

    if (privacyPolicy === undefined || termsAndConditions === undefined) {
      return next(
        new AppError(
          400,
          "Both privacyPolicy and termsAndConditions are required",
        ),
      );
    }

    const policy = await policyService.updatePolicy({
      privacyPolicy,
      termsAndConditions,
    });

    return res.status(201).json({
      success: true,
      data: policy,
    });
  } catch (err) {
    next(err);
  }
}
