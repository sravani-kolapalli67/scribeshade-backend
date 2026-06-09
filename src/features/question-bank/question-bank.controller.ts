import { NextFunction, Request, Response } from "express";
import { QuestionBankModerationStatus } from "@prisma/client";
import { prisma } from "../../shared/lib/prisma";
import { AppError } from "../../shared/middleware/error.middleware";
import { getCurrentUserId } from "../auth/auth.middleware";
import {
  exploreCompanies,
  exploreRoles,
  exploreTechnologies,
  getCompanyDetail,
  getPublicQuestionDetail,
  listModerationQueue,
  listMyQuestions,
  listPublicQuestions,
  parseDifficulty,
  parseQuestionType,
  saveQuestionForUser,
  unsaveQuestionForUser,
  updateModerationStatus,
} from "./question-bank.service";
import type { ExploreQuery, QuestionBankListQuery } from "./question-bank.types";

function parsePage(value: unknown): number {
  const page = Number(value);
  if (!Number.isFinite(page) || page < 1) return 1;
  return Math.floor(page);
}

function parseLimit(value: unknown): number {
  const limit = Number(value);
  if (!Number.isFinite(limit) || limit < 1) return 20;
  return Math.min(100, Math.floor(limit));
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function requiredParam(value: unknown, name: string): string {
  const parsed = optionalString(value);
  if (!parsed) {
    throw new AppError(400, `${name} is required`);
  }
  return parsed;
}

function parseExploreSort(value: unknown): ExploreQuery["sort"] {
  if (value === "questions" || value === "name" || value === "recent") return value;
  return "recent";
}

function parseQuestionSort(value: unknown): QuestionBankListQuery["sort"] {
  if (value === "frequency" || value === "difficulty" || value === "recent") return value;
  return "recent";
}

function parseMinQuestions(value: unknown): number | undefined {
  const minQuestions = Number(value);
  if (!Number.isFinite(minQuestions) || minQuestions < 1) return undefined;
  return Math.floor(minQuestions);
}

function parseExploreQuery(req: Request): ExploreQuery {
  return {
    q: optionalString(req.query.q),
    industry: optionalString(req.query.industry),
    technology: optionalString(req.query.technology),
    role: optionalString(req.query.role),
    difficulty: parseDifficulty(req.query.difficulty),
    minQuestions: parseMinQuestions(req.query.minQuestions),
    page: parsePage(req.query.page),
    limit: parseLimit(req.query.limit),
    sort: parseExploreSort(req.query.sort),
  };
}

function parseQuestionQuery(req: Request): QuestionBankListQuery {
  return {
    q: optionalString(req.query.q),
    company: optionalString(req.query.company),
    role: optionalString(req.query.role),
    technology: optionalString(req.query.technology),
    topic: optionalString(req.query.topic),
    industry: optionalString(req.query.industry),
    questionType: parseQuestionType(req.query.questionType),
    difficulty: parseDifficulty(req.query.difficulty),
    page: parsePage(req.query.page),
    limit: parseLimit(req.query.limit),
    sort: parseQuestionSort(req.query.sort),
  };
}

async function getAuthenticatedUserId(req: Request): Promise<string> {
  const clerkId = getCurrentUserId(req);
  const user = await prisma.user.findUnique({
    where: { clerkId },
    select: { id: true },
  });
  if (!user) {
    throw new AppError(404, "User not found");
  }
  return user.id;
}

function parseModerationStatus(value: unknown): QuestionBankModerationStatus {
  if (typeof value !== "string") {
    throw new AppError(400, "moderationStatus is required");
  }
  const normalized = value.trim().replace(/[-\s]+/g, "_").toUpperCase();
  const match = Object.values(QuestionBankModerationStatus).find((entry) => entry === normalized);
  if (!match) {
    throw new AppError(400, "moderationStatus is not supported");
  }
  return match;
}

export async function listExploreCompanies(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<Response | void> {
  try {
    const result = await exploreCompanies(parseExploreQuery(req));
    return res.json({ success: true, data: result.companies, pagination: result.pagination });
  } catch (error) {
    next(error);
  }
}

export async function listExploreRoles(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<Response | void> {
  try {
    const result = await exploreRoles(parseExploreQuery(req));
    return res.json({ success: true, data: result.roles, pagination: result.pagination });
  } catch (error) {
    next(error);
  }
}

export async function listExploreTechnologies(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<Response | void> {
  try {
    const result = await exploreTechnologies(parseExploreQuery(req));
    return res.json({ success: true, data: result.technologies, pagination: result.pagination });
  } catch (error) {
    next(error);
  }
}

export async function getCompany(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<Response | void> {
  try {
    const companySlug = requiredParam(req.params.companySlug, "companySlug");
    const result = await getCompanyDetail(companySlug);
    return res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
}

export async function listQuestions(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<Response | void> {
  try {
    const result = await listPublicQuestions(parseQuestionQuery(req));
    return res.json({
      success: true,
      data: result.questions,
      analytics: result.analytics,
      pagination: result.pagination,
    });
  } catch (error) {
    next(error);
  }
}

export async function getQuestion(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<Response | void> {
  try {
    const questionId = requiredParam(req.params.questionId, "questionId");
    const result = await getPublicQuestionDetail(questionId);
    return res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
}

export async function getMyQuestions(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<Response | void> {
  try {
    const userId = await getAuthenticatedUserId(req);
    const result = await listMyQuestions(userId, parsePage(req.query.page), parseLimit(req.query.limit));
    return res.json({ success: true, data: result.questions, pagination: result.pagination });
  } catch (error) {
    next(error);
  }
}

export async function saveQuestion(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<Response | void> {
  try {
    const userId = await getAuthenticatedUserId(req);
    const questionId = requiredParam(req.params.questionId, "questionId");
    await saveQuestionForUser(userId, questionId);
    return res.status(201).json({ success: true });
  } catch (error) {
    next(error);
  }
}

export async function unsaveQuestion(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<Response | void> {
  try {
    const userId = await getAuthenticatedUserId(req);
    const questionId = requiredParam(req.params.questionId, "questionId");
    await unsaveQuestionForUser(userId, questionId);
    return res.json({ success: true });
  } catch (error) {
    next(error);
  }
}

export async function getModerationQueue(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<Response | void> {
  try {
    const result = await listModerationQueue(parsePage(req.query.page), parseLimit(req.query.limit));
    return res.json({ success: true, data: result.questions, pagination: result.pagination });
  } catch (error) {
    next(error);
  }
}

export async function updateModeration(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<Response | void> {
  try {
    const body = req.body || {};
    const questionId = requiredParam(req.params.questionId, "questionId");
    await updateModerationStatus({
      questionId,
      moderationStatus: parseModerationStatus(body.moderationStatus),
      adminOverride: body.adminOverride === true,
    });
    return res.json({ success: true });
  } catch (error) {
    next(error);
  }
}
