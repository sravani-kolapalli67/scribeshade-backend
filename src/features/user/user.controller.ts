// import { NextFunction, Request, Response } from "express";
// import { getCurrentUserId } from "../auth/auth.middleware";
// import { NextFunction, Request, Response } from "express";
import { NextFunction, Request, Response } from "express";
import { getCurrentUserId } from "../auth/auth.middleware";
import { getUserProfile, syncUser as syncUserInService } from "./user.service";

export async function getMe(req: Request, res: Response, next: NextFunction) {
  try {
    const clerkId = getCurrentUserId(req);
    const user = await getUserProfile(clerkId);
    res.json(user);
  } catch (error) {
    next(error);
  }
}

export async function sync(req: Request, res: Response, next: NextFunction) {
  try {
    const clerkId = getCurrentUserId(req);
    const { email, name } = req.body;
    const user = await syncUserInService(clerkId, email, name);
    res.json(user);
  } catch (error) {
    next(error);
  }
}
