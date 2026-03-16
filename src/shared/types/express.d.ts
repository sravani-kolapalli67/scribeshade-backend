import { AuthObject } from "@clerk/express";

declare global {
  namespace Express {
    interface Request {
      auth: AuthObject;
    }
  }
}
