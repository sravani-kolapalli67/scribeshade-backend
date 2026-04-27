import { Router } from "express";
import * as companyController from "./company.controller";

const router = Router();

/**
 * @route GET /company
 * @desc Get all companies
 */
router.get("/", companyController.listCompanies);

/**
 * @route GET /company/:identifier
 * @desc Get a single company by ID or Slug
 */
router.get("/:identifier", companyController.getCompany);

export { router as companyRouter };
