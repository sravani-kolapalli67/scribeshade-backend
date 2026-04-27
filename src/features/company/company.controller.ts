import { Request, Response } from "express";
import * as companyService from "./company.service";

/**
 * Handles the request to list all companies.
 */
export async function listCompanies(req: Request, res: Response) {
  try {
    const companies = await companyService.listCompanies();
    return res.json(companies);
  } catch (error: any) {
    console.error("List Companies Error:", error);
    return res
      .status(500)
      .json({ error: error.message || "Internal server error" });
  }
}

/**
 * Handles the request to get a single company by ID or Slug.
 */
export async function getCompany(req: Request, res: Response) {
  try {
    const { identifier } = req.params;

    // Try by ID first, then by Slug
    let company = await companyService.getCompanyById(identifier);
    if (!company) {
      company = await companyService.getCompanyBySlug(identifier);
    }

    if (!company) {
      return res.status(404).json({ error: "Company not found" });
    }

    return res.json(company);
  } catch (error: any) {
    console.error("Get Company Error:", error);
    return res
      .status(500)
      .json({ error: error.message || "Internal server error" });
  }
}
