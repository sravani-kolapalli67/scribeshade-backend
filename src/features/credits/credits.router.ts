import { Router } from "express";
import { requireAuth } from "../auth/auth.middleware";
import * as creditsController from "./credits.controller";

const router = Router();

// Public
router.get("/brackets", creditsController.getBrackets);
router.get("/plans", creditsController.getPlans);

// Authenticated
router.get("/balance", requireAuth, creditsController.getBalance);
router.get("/ledger", requireAuth, creditsController.getLedger);
router.get("/purchases", requireAuth, creditsController.getPurchases);
router.post("/purchase/order", requireAuth, creditsController.createPurchaseOrder);
router.post("/purchase/verify", requireAuth, creditsController.verifyPurchase);

export { router as creditsRouter };
