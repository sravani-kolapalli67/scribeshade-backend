import { Router } from "express";
import * as policyController from "./policy.controller";

const router = Router();

// Publicly accessible
router.get("/", policyController.getPolicy);

// Protected - only authenticated users can update policy (ideally admin only)
router.post("/", policyController.updatePolicy);

export { router as policyRouter };
