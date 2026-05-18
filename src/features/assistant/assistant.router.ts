import { Router } from "express";
import { requireAuth } from "../auth/auth.middleware";
import * as controller from "./assistant.controller";

const router = Router();

router.use(requireAuth);

router.post("/", controller.createChat);
router.get("/", controller.listChats);
router.get("/sessions", controller.getUserSessions);
router.patch("/:chatId/title", controller.renameChat);
router.delete("/:chatId", controller.deleteChat);
router.get("/:chatId/messages", controller.getMessages);
router.post("/:chatId/query", controller.sendMessage);
router.post("/:chatId/session", controller.setSessionScope);

export { router as assistantRouter };
