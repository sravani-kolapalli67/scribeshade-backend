import { prisma } from "../../shared/lib/prisma";
import { CreateQAData, UpdateQAData } from "./qa.types";

/**
 * Creates a new QA record.
 */
export async function createQA(data: CreateQAData) {
  return prisma.qA.create({
    data: {
      messageId: data.messageId,
      userId: data.userId,
      companyId: data.companyId,
      sessionId: data.sessionId ?? null,
      ques: data.ques,
      answer: data.answer ?? null,
      difficulty: data.difficulty ?? "Easy",
      industry: data.industry ?? "DSA",
      language: data.language ?? "General",
      isShared: data.isShared ?? false,
    },
  });
}

/**
 * Returns all QA records for a given session.
 */
export async function getQAsBySession(sessionId: string) {
  return prisma.qA.findMany({
    where: { sessionId },
    orderBy: { createdAt: "asc" },
  });
}

/**
 * Returns all QA records for a given company.
 */
export async function getQAsByCompany(companyId: string) {
  return prisma.qA.findMany({
    where: { companyId },
    orderBy: { createdAt: "desc" },
  });
}

/**
 * Returns all QA records for a given user.
 */
export async function getQAsByUser(userId: string) {
  return prisma.qA.findMany({
    where: { userId },
    include: {
      company: {
        select: { id: true, name: true, logo: true, slug: true },
      },
      session: {
        select: { id: true, createdAt: true, mode: true },
      },
    },
    orderBy: { createdAt: "desc" },
  });
}

/**
 * Returns all publicly shared QA records.
 */
export async function getSharedQAs() {
  return prisma.qA.findMany({
    where: { isShared: true },
    orderBy: { createdAt: "desc" },
  });
}

/**
 * Returns a single QA record by ID.
 */
export async function getQAById(id: string) {
  return prisma.qA.findUnique({
    where: { id },
  });
}

/**
 * Updates an existing QA record (e.g. adds/edits the answer or metadata).
 */
export async function updateQA(id: string, data: UpdateQAData) {
  return prisma.qA.update({
    where: { id },
    data: {
      ...(data.answer !== undefined && { answer: data.answer }),
      ...(data.difficulty !== undefined && { difficulty: data.difficulty }),
      ...(data.industry !== undefined && { industry: data.industry }),
      ...(data.language !== undefined && { language: data.language }),
      ...(data.isShared !== undefined && { isShared: data.isShared }),
    },
  });
}

/**
 * Deletes a QA record by ID.
 */
export async function deleteQA(id: string) {
  return prisma.qA.delete({
    where: { id },
  });
}
