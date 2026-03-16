import { NextFunction, Request, Response } from "express";
import { getCurrentUserId } from "../auth/auth.middleware";
import { UserService } from "./user.service";

export class UserController {
  static async getMe(req: Request, res: Response, next: NextFunction) {
    try {
      const clerkId = getCurrentUserId(req);
      const user = await UserService.getUserProfile(clerkId);
      res.json(user);
    } catch (error) {
      next(error);
    }
  }

  static async sync(req: Request, res: Response, next: NextFunction) {
    try {
      const clerkId = getCurrentUserId(req);
      const { email, name } = req.body;
      const user = await UserService.syncUser(clerkId, email, name);
      res.json(user);
    } catch (error) {
      next(error);
    }
  }
}
