import { Router } from "express";
import { requireAuth } from "../auth/auth.middleware";
import { requireQuestionBankAdmin } from "./question-bank.admin.middleware";
import * as controller from "./question-bank.controller";

const router = Router();

router.use(requireAuth);

router.get("/explore/companies", controller.listExploreCompanies);
router.get("/explore/roles", controller.listExploreRoles);
router.get("/explore/technologies", controller.listExploreTechnologies);
router.get("/companies/:companySlug", controller.getCompany);
router.get("/questions", controller.listQuestions);
router.get("/questions/:questionId", controller.getQuestion);
router.get("/my/questions", controller.getMyQuestions);
router.post("/questions/:questionId/save", controller.saveQuestion);
router.delete("/questions/:questionId/save", controller.unsaveQuestion);

router.get(
  "/admin/moderation",
  requireQuestionBankAdmin,
  controller.getModerationQueue,
);
router.patch(
  "/admin/questions/:questionId/moderation",
  requireQuestionBankAdmin,
  controller.updateModeration,
);

export { router as questionBankRouter };
