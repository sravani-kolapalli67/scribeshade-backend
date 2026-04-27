import { Router } from "express";
import * as qaController from "./qa.controller";

const router = Router();

/**
 * @route POST /qa
 * @desc Create a new QA record
 */
router.post("/", qaController.createQA);

/**
 * @route GET /qa/shared
 * @desc List all publicly shared QA records
 */
router.get("/shared", qaController.listSharedQAs);

/**
 * @route GET /qa/session/:sessionId
 * @desc List all QA records for a specific session
 */
router.get("/session/:sessionId", qaController.listQAsBySession);

/**
 * @route GET /qa/company/:companyId
 * @desc List all QA records for a specific company
 */
router.get("/company/:companyId", qaController.listQAsByCompany);

/**
 * @route GET /qa/user/:userId
 * @desc List all QA records for a specific user
 */
router.get("/user/:userId", qaController.listQAsByUser);

/**
 * @route GET /qa/:id
 * @desc Get a single QA record by ID
 */
router.get("/:id", qaController.getQA);

/**
 * @route PATCH /qa/:id
 * @desc Update a QA record (add/edit answer, metadata)
 */
router.patch("/:id", qaController.updateQA);

/**
 * @route DELETE /qa/:id
 * @desc Delete a QA record
 */
router.delete("/:id", qaController.deleteQA);

export { router as qaRouter };
