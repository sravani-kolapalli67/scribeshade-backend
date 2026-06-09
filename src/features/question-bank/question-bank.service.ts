import crypto from "crypto";
import {
  Prisma,
  QuestionBankDifficulty,
  QuestionBankModerationStatus,
  QuestionBankPrivacyRisk,
  QuestionBankQuestionType,
  QuestionBankSourceType,
  QuestionBankVisibility,
  QuestionBankVisibilityClass,
} from "@prisma/client";
import { prisma } from "../../shared/lib/prisma";
import { AppError } from "../../shared/middleware/error.middleware";
import type {
  CompanyExploreItem,
  DifficultyMix,
  ExploreQuery,
  Pagination,
  PublicQuestion,
  QuestionBankAnalytics,
  QuestionBankListQuery,
  RoleExploreItem,
  SanitizedExtractedQuestion,
  TechnologyExploreItem,
} from "./question-bank.types";

const PUBLIC_MODERATION_STATUSES: QuestionBankModerationStatus[] = [
  QuestionBankModerationStatus.APPROVED,
  QuestionBankModerationStatus.AUTO_APPROVED,
];

const PUBLIC_QUESTION_INCLUDE = {
  company: { select: { name: true, slug: true } },
  role: { select: { name: true, slug: true } },
  cluster: { select: { id: true, publicEligible: true } },
} satisfies Prisma.QuestionBankQuestionInclude;

type PublicQuestionRecord = Prisma.QuestionBankQuestionGetPayload<{
  include: typeof PUBLIC_QUESTION_INCLUDE;
}>;

type QuestionSourceCounts = {
  sourceCount: number;
  contributorCount: number;
  sourceSessionCount: number;
};

type StoredQuestionInput = {
  question: SanitizedExtractedQuestion;
  companyName: string;
  roleName: string;
  sourceUserId: string;
  sourceSessionId: string;
  sourceQaId?: string;
  contributionOptIn: boolean;
};

function normalizeSpaces(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

export function slugify(value: string): string {
  return normalizeSpaces(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function normalizeQuestionText(value: string): string {
  const normalized = normalizeSpaces(value);
  if (!normalized) return "";
  const punctuated = /[?.!]$/.test(normalized) ? normalized : `${normalized}?`;
  return punctuated.replace(/\s+([?.!,])/g, "$1");
}

function normalizeLookupName(value: string): string {
  return slugify(value).replace(/-/g, " ");
}

function canonicalQuestionHash(question: string, companySlug: string, roleSlug: string): string {
  const canonical = [
    normalizeQuestionText(question).toLowerCase(),
    companySlug,
    roleSlug,
  ].join("|");
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

function sourceKey(input: {
  sessionId: string;
  qaId?: string;
  canonicalHash: string;
}): string {
  return crypto
    .createHash("sha256")
    .update([input.sessionId, input.qaId || "session", input.canonicalHash].join("|"))
    .digest("hex");
}

function displayTitleFromQuestion(question: string): string {
  const cleaned = normalizeQuestionText(question);
  if (cleaned.length <= 120) return cleaned;
  return `${cleaned.slice(0, 117).trim()}...`;
}

function publicQuestionWhere(): Prisma.QuestionBankQuestionWhereInput {
  return {
    visibility: QuestionBankVisibility.PUBLIC_AGGREGATED,
    visibilityClass: QuestionBankVisibilityClass.VALID_INTERVIEW_QUESTION,
    privacyRisk: { not: QuestionBankPrivacyRisk.HIGH },
    moderationStatus: { in: PUBLIC_MODERATION_STATUSES },
    cluster: { is: { publicEligible: true } },
  };
}

function toPagination(total: number, page: number, limit: number): Pagination {
  return {
    total,
    page,
    limit,
    pages: Math.ceil(total / limit),
  };
}

function toPublicDifficulty(difficulty: QuestionBankDifficulty): PublicQuestion["difficulty"] {
  if (difficulty === QuestionBankDifficulty.EASY) return "easy";
  if (difficulty === QuestionBankDifficulty.MEDIUM) return "medium";
  if (difficulty === QuestionBankDifficulty.HARD) return "hard";
  return "expert";
}

function toPublicQuestionType(questionType: QuestionBankQuestionType): string {
  return questionType.toLowerCase();
}

function mapPublicQuestion(question: PublicQuestionRecord): PublicQuestion {
  return {
    id: question.id,
    title: question.displayTitle,
    normalizedQuestion: question.normalizedQuestion,
    company: question.company
      ? { name: question.company.name, slug: question.company.slug }
      : undefined,
    role: question.role ? { name: question.role.name, slug: question.role.slug } : undefined,
    industry: question.industry || undefined,
    technologies: question.technologies,
    topics: question.topics,
    questionType: toPublicQuestionType(question.questionType),
    difficulty: toPublicDifficulty(question.difficulty),
    complexityScore: question.complexityScore,
    frequencyCount: question.frequencyCount,
    sourceCount: question.sourceCount,
    lastSeenAt: question.lastSeenAt.toISOString(),
    answerGuideAvailable: question.answerGuideAvailable,
  };
}

function difficultyMix(questions: PublicQuestionRecord[]): DifficultyMix {
  const total = questions.length;
  if (total === 0) {
    return { easy: 0, medium: 0, hard: 0, expert: 0 };
  }

  const counts = questions.reduce(
    (accumulator, question) => {
      const difficulty = toPublicDifficulty(question.difficulty);
      return {
        ...accumulator,
        [difficulty]: accumulator[difficulty] + 1,
      };
    },
    { easy: 0, medium: 0, hard: 0, expert: 0 },
  );

  return {
    easy: Math.round((counts.easy / total) * 100),
    medium: Math.round((counts.medium / total) * 100),
    hard: Math.round((counts.hard / total) * 100),
    expert: Math.round((counts.expert / total) * 100),
  };
}

function topValues(values: string[], limit: number): string[] {
  const counts = values.reduce<Record<string, number>>((accumulator, value) => {
    const normalized = normalizeSpaces(value);
    if (!normalized) return accumulator;
    return {
      ...accumulator,
      [normalized]: (accumulator[normalized] || 0) + 1,
    };
  }, {});

  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([value]) => value);
}

function analyticsFromQuestions(questions: PublicQuestionRecord[]): QuestionBankAnalytics {
  const topics = questions.flatMap((question) => question.topics);
  const technologies = questions.flatMap((question) => question.technologies);
  const typeDistribution = questions.reduce<Record<string, number>>((accumulator, question) => {
    const questionType = toPublicQuestionType(question.questionType);
    return {
      ...accumulator,
      [questionType]: (accumulator[questionType] || 0) + 1,
    };
  }, {});

  return {
    totalValidQuestions: questions.length,
    uniqueTopics: new Set(topics.map((topic) => topic.toLowerCase())).size,
    topTechnologies: topValues(technologies, 8),
    topTopics: topValues(topics, 8),
    difficultyMix: difficultyMix(questions),
    questionTypeDistribution: typeDistribution,
    mostRepeatedQuestions: [...questions]
      .sort((a, b) => b.frequencyCount - a.frequencyCount || b.lastSeenAt.getTime() - a.lastSeenAt.getTime())
      .slice(0, 5)
      .map((question) => ({
        id: question.id,
        title: question.displayTitle,
        frequencyCount: question.frequencyCount,
      })),
  };
}

function questionSearchWhere(query: QuestionBankListQuery): Prisma.QuestionBankQuestionWhereInput {
  const filters: Prisma.QuestionBankQuestionWhereInput[] = [publicQuestionWhere()];

  if (query.company) {
    filters.push({ company: { is: { slug: slugify(query.company) } } });
  }

  if (query.role) {
    filters.push({ role: { is: { slug: slugify(query.role) } } });
  }

  if (query.technology) {
    filters.push({ technologies: { has: normalizeSpaces(query.technology) } });
  }

  if (query.topic) {
    filters.push({ topics: { has: normalizeSpaces(query.topic) } });
  }

  if (query.industry) {
    filters.push({ industry: { equals: query.industry, mode: "insensitive" } });
  }

  if (query.questionType) {
    filters.push({ questionType: query.questionType });
  }

  if (query.difficulty) {
    filters.push({ difficulty: query.difficulty });
  }

  if (query.q) {
    const search = normalizeSpaces(query.q);
    filters.push({
      OR: [
        { normalizedQuestion: { contains: search, mode: "insensitive" } },
        { displayTitle: { contains: search, mode: "insensitive" } },
        { industry: { contains: search, mode: "insensitive" } },
        { company: { is: { name: { contains: search, mode: "insensitive" } } } },
        { company: { is: { aliases: { has: search } } } },
        { role: { is: { name: { contains: search, mode: "insensitive" } } } },
        { technologies: { has: search } },
        { topics: { has: search } },
      ],
    });
  }

  return { AND: filters };
}

function questionOrderBy(sort: QuestionBankListQuery["sort"]): Prisma.QuestionBankQuestionOrderByWithRelationInput[] {
  if (sort === "frequency") {
    return [{ frequencyCount: "desc" }, { lastSeenAt: "desc" }];
  }

  if (sort === "difficulty") {
    return [{ complexityScore: "desc" }, { frequencyCount: "desc" }];
  }

  return [{ lastSeenAt: "desc" }, { frequencyCount: "desc" }];
}

function paged<T>(items: T[], page: number, limit: number): T[] {
  const start = (page - 1) * limit;
  return items.slice(start, start + limit);
}

export function parseDifficulty(value: unknown): QuestionBankDifficulty | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const normalized = value.trim().replace(/[-\s]+/g, "_").toUpperCase();
  if (normalized === "EASY") return QuestionBankDifficulty.EASY;
  if (normalized === "MEDIUM") return QuestionBankDifficulty.MEDIUM;
  if (normalized === "HARD") return QuestionBankDifficulty.HARD;
  if (normalized === "EXPERT") return QuestionBankDifficulty.EXPERT;
  throw new AppError(400, "difficulty must be easy, medium, hard, or expert");
}

export function parseQuestionType(value: unknown): QuestionBankQuestionType | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const normalized = value.trim().replace(/[-\s]+/g, "_").toUpperCase();
  const match = Object.values(QuestionBankQuestionType).find((entry) => entry === normalized);
  if (!match) {
    throw new AppError(400, "questionType is not supported");
  }
  return match;
}

export async function listPublicQuestions(query: QuestionBankListQuery): Promise<{
  questions: PublicQuestion[];
  analytics: QuestionBankAnalytics;
  pagination: Pagination;
}> {
  const where = questionSearchWhere(query);
  const [questions, total, analyticsQuestions] = await Promise.all([
    prisma.questionBankQuestion.findMany({
      where,
      include: PUBLIC_QUESTION_INCLUDE,
      orderBy: questionOrderBy(query.sort),
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    }),
    prisma.questionBankQuestion.count({ where }),
    prisma.questionBankQuestion.findMany({
      where,
      include: PUBLIC_QUESTION_INCLUDE,
      orderBy: [{ frequencyCount: "desc" }],
      take: 1000,
    }),
  ]);

  return {
    questions: questions.map(mapPublicQuestion),
    analytics: analyticsFromQuestions(analyticsQuestions),
    pagination: toPagination(total, query.page, query.limit),
  };
}

export async function getPublicQuestionDetail(questionId: string): Promise<{
  question: PublicQuestion;
  similarQuestions: PublicQuestion[];
  answerGuide?: {
    approach: string[];
    keyPoints: string[];
    commonMistakes: string[];
  };
}> {
  const question = await prisma.questionBankQuestion.findFirst({
    where: {
      id: questionId,
      ...publicQuestionWhere(),
    },
    include: PUBLIC_QUESTION_INCLUDE,
  });

  if (!question) {
    throw new AppError(404, "Question not found");
  }

  const similarQuestions = question.clusterId
    ? await prisma.questionBankQuestion.findMany({
        where: {
          id: { not: question.id },
          clusterId: question.clusterId,
          ...publicQuestionWhere(),
        },
        include: PUBLIC_QUESTION_INCLUDE,
        orderBy: [{ frequencyCount: "desc" }, { lastSeenAt: "desc" }],
        take: 5,
      })
    : [];

  const answerGuide =
    question.answerGuide &&
    typeof question.answerGuide === "object" &&
    !Array.isArray(question.answerGuide)
      ? (question.answerGuide as {
          approach: string[];
          keyPoints: string[];
          commonMistakes: string[];
        })
      : undefined;

  return {
    question: mapPublicQuestion(question),
    similarQuestions: similarQuestions.map(mapPublicQuestion),
    answerGuide,
  };
}

export async function exploreCompanies(query: ExploreQuery): Promise<{
  companies: CompanyExploreItem[];
  pagination: Pagination;
}> {
  const questions = await prisma.questionBankQuestion.findMany({
    where: questionSearchWhere({
      q: query.q,
      role: query.role,
      technology: query.technology,
      industry: query.industry,
      difficulty: query.difficulty,
      page: 1,
      limit: 1000,
      sort: "recent",
    }),
    include: PUBLIC_QUESTION_INCLUDE,
    orderBy: [{ lastSeenAt: "desc" }],
    take: 5000,
  });

  const groups = new Map<string, PublicQuestionRecord[]>();
  for (const question of questions) {
    if (!question.company) continue;
    const existing = groups.get(question.company.slug) || [];
    groups.set(question.company.slug, [...existing, question]);
  }

  const minQuestions = query.minQuestions || 0;
  const items = Array.from(groups.entries())
    .map(([slug, group]) => {
      const first = group[0];
      if (!first.company) return null;
      const item: CompanyExploreItem = {
        id: first.companyId || slug,
        name: first.company.name,
        slug: first.company.slug,
        industry: first.industry || undefined,
        availableRoles: new Set(group.map((question) => question.role?.slug).filter(Boolean)).size,
        validQuestions: group.length,
        topTechnologies: topValues(group.flatMap((question) => question.technologies), 5),
        difficultyMix: difficultyMix(group),
        lastUpdatedAt: group.reduce((latest, question) => {
          return question.lastSeenAt > latest ? question.lastSeenAt : latest;
        }, group[0].lastSeenAt).toISOString(),
      };
      return item;
    })
    .filter((item): item is CompanyExploreItem => item !== null && item.validQuestions >= minQuestions)
    .sort((a, b) => {
      if (query.sort === "name") return a.name.localeCompare(b.name);
      if (query.sort === "questions") return b.validQuestions - a.validQuestions || a.name.localeCompare(b.name);
      return b.lastUpdatedAt.localeCompare(a.lastUpdatedAt);
    });

  return {
    companies: paged(items, query.page, query.limit),
    pagination: toPagination(items.length, query.page, query.limit),
  };
}

export async function exploreRoles(query: ExploreQuery): Promise<{
  roles: RoleExploreItem[];
  pagination: Pagination;
}> {
  const questions = await prisma.questionBankQuestion.findMany({
    where: questionSearchWhere({
      q: query.q,
      technology: query.technology,
      industry: query.industry,
      difficulty: query.difficulty,
      page: 1,
      limit: 1000,
      sort: "recent",
    }),
    include: PUBLIC_QUESTION_INCLUDE,
    orderBy: [{ lastSeenAt: "desc" }],
    take: 5000,
  });

  const groups = new Map<string, PublicQuestionRecord[]>();
  for (const question of questions) {
    if (!question.role) continue;
    const existing = groups.get(question.role.slug) || [];
    groups.set(question.role.slug, [...existing, question]);
  }

  const minQuestions = query.minQuestions || 0;
  const items = Array.from(groups.entries())
    .map(([slug, group]) => {
      const first = group[0];
      if (!first.role) return null;
      return {
        id: first.roleId || slug,
        name: first.role.name,
        slug: first.role.slug,
        companiesSeenIn: new Set(group.map((question) => question.company?.slug).filter(Boolean)).size,
        questionCount: group.length,
        topTechnologies: topValues(group.flatMap((question) => question.technologies), 5),
        mostAskedTopics: topValues(group.flatMap((question) => question.topics), 5),
        difficultyMix: difficultyMix(group),
      };
    })
    .filter((item): item is RoleExploreItem => item !== null && item.questionCount >= minQuestions)
    .sort((a, b) => {
      if (query.sort === "name") return a.name.localeCompare(b.name);
      return b.questionCount - a.questionCount || a.name.localeCompare(b.name);
    });

  return {
    roles: paged(items, query.page, query.limit),
    pagination: toPagination(items.length, query.page, query.limit),
  };
}

export async function exploreTechnologies(query: ExploreQuery): Promise<{
  technologies: TechnologyExploreItem[];
  pagination: Pagination;
}> {
  const questions = await prisma.questionBankQuestion.findMany({
    where: questionSearchWhere({
      q: query.q,
      role: query.role,
      industry: query.industry,
      difficulty: query.difficulty,
      page: 1,
      limit: 1000,
      sort: "recent",
    }),
    include: PUBLIC_QUESTION_INCLUDE,
    orderBy: [{ lastSeenAt: "desc" }],
    take: 5000,
  });

  const groups = new Map<string, PublicQuestionRecord[]>();
  const names = new Map<string, string>();
  for (const question of questions) {
    for (const technology of question.technologies) {
      const slug = slugify(technology);
      const existing = groups.get(slug) || [];
      groups.set(slug, [...existing, question]);
      names.set(slug, technology);
    }
  }

  const technologyRows = await prisma.questionBankTechnology.findMany({
    where: { slug: { in: Array.from(groups.keys()) } },
  });
  const categories = new Map(technologyRows.map((technology) => [technology.slug, technology.category]));
  const minQuestions = query.minQuestions || 0;

  const items = Array.from(groups.entries())
    .map(([slug, group]) => ({
      id: slug,
      name: names.get(slug) || slug,
      slug,
      category: categories.get(slug) || "general",
      relatedRoles: new Set(group.map((question) => question.role?.slug).filter(Boolean)).size,
      relatedCompanies: new Set(group.map((question) => question.company?.slug).filter(Boolean)).size,
      questionCount: group.length,
      commonQuestionTypes: topValues(group.map((question) => toPublicQuestionType(question.questionType)), 5),
      difficultyMix: difficultyMix(group),
    }))
    .filter((item) => item.questionCount >= minQuestions)
    .sort((a, b) => {
      if (query.sort === "name") return a.name.localeCompare(b.name);
      return b.questionCount - a.questionCount || a.name.localeCompare(b.name);
    });

  return {
    technologies: paged(items, query.page, query.limit),
    pagination: toPagination(items.length, query.page, query.limit),
  };
}

export async function getCompanyDetail(companySlug: string): Promise<{
  company: { id: string; name: string; slug: string; industry?: string };
  roles: Array<{ id: string; name: string; slug: string; questionCount: number }>;
  topTechnologies: string[];
  analytics: QuestionBankAnalytics;
}> {
  const company = await prisma.questionBankCompany.findUnique({
    where: { slug: slugify(companySlug) },
  });
  if (!company) {
    throw new AppError(404, "Company not found");
  }

  const questions = await prisma.questionBankQuestion.findMany({
    where: {
      ...publicQuestionWhere(),
      companyId: company.id,
    },
    include: PUBLIC_QUESTION_INCLUDE,
    orderBy: [{ frequencyCount: "desc" }, { lastSeenAt: "desc" }],
    take: 1000,
  });

  const roleGroups = new Map<string, PublicQuestionRecord[]>();
  for (const question of questions) {
    if (!question.role) continue;
    const existing = roleGroups.get(question.role.slug) || [];
    roleGroups.set(question.role.slug, [...existing, question]);
  }

  const roles = Array.from(roleGroups.entries()).map(([slug, group]) => {
    const first = group[0];
    return {
      id: first.roleId || slug,
      name: first.role?.name || slug,
      slug,
      questionCount: group.length,
    };
  });

  return {
    company: {
      id: company.id,
      name: company.name,
      slug: company.slug,
      industry: company.industry || undefined,
    },
    roles,
    topTechnologies: topValues(questions.flatMap((question) => question.technologies), 8),
    analytics: analyticsFromQuestions(questions),
  };
}

export async function saveQuestionForUser(userId: string, questionId: string): Promise<void> {
  const question = await prisma.questionBankQuestion.findFirst({
    where: { id: questionId, ...publicQuestionWhere() },
    select: { id: true },
  });

  if (!question) {
    throw new AppError(404, "Question not found");
  }

  await prisma.questionBankSavedQuestion.upsert({
    where: { userId_questionId: { userId, questionId } },
    create: { userId, questionId },
    update: {},
  });
}

export async function unsaveQuestionForUser(userId: string, questionId: string): Promise<void> {
  await prisma.questionBankSavedQuestion.deleteMany({
    where: { userId, questionId },
  });
}

export async function listMyQuestions(userId: string, page: number, limit: number): Promise<{
  questions: Array<{
    id: string;
    question: string;
    title: string;
    company?: string;
    role?: string;
    sessionDate?: string;
    technologies: string[];
    topics: string[];
    difficulty: PublicQuestion["difficulty"];
    contributionEnabled: boolean;
    visibility: string;
  }>;
  pagination: Pagination;
}> {
  const where: Prisma.QuestionBankSourceWhereInput = { sourceUserId: userId };
  const [sources, total] = await Promise.all([
    prisma.questionBankSource.findMany({
      where,
      include: {
        question: {
          include: {
            company: { select: { name: true } },
            role: { select: { name: true } },
          },
        },
        sourceSession: { select: { createdAt: true } },
      },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.questionBankSource.count({ where }),
  ]);

  return {
    questions: sources.map((source) => ({
      id: source.question.id,
      question: source.question.normalizedQuestion,
      title: source.question.displayTitle,
      company: source.question.company?.name,
      role: source.question.role?.name,
      sessionDate: source.sourceSession?.createdAt.toISOString(),
      technologies: source.question.technologies,
      topics: source.question.topics,
      difficulty: toPublicDifficulty(source.question.difficulty),
      contributionEnabled: source.contributionOptIn,
      visibility: source.question.visibility.toLowerCase(),
    })),
    pagination: toPagination(total, page, limit),
  };
}

export async function listModerationQueue(page: number, limit: number): Promise<{
  questions: Array<{
    id: string;
    normalizedQuestion: string;
    displayTitle: string;
    company?: string;
    role?: string;
    technologies: string[];
    topics: string[];
    visibilityClass: string;
    privacyRisk: string;
    moderationStatus: string;
    sourceCount: number;
    contributorCount: number;
    createdAt: string;
  }>;
  pagination: Pagination;
}> {
  const where: Prisma.QuestionBankQuestionWhereInput = {
    moderationStatus: {
      in: [
        QuestionBankModerationStatus.PENDING,
        QuestionBankModerationStatus.NEEDS_REVIEW,
      ],
    },
  };

  const [questions, total] = await Promise.all([
    prisma.questionBankQuestion.findMany({
      where,
      include: {
        company: { select: { name: true } },
        role: { select: { name: true } },
      },
      orderBy: { createdAt: "asc" },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.questionBankQuestion.count({ where }),
  ]);

  return {
    questions: questions.map((question) => ({
      id: question.id,
      normalizedQuestion: question.normalizedQuestion,
      displayTitle: question.displayTitle,
      company: question.company?.name,
      role: question.role?.name,
      technologies: question.technologies,
      topics: question.topics,
      visibilityClass: question.visibilityClass.toLowerCase(),
      privacyRisk: question.privacyRisk.toLowerCase(),
      moderationStatus: question.moderationStatus.toLowerCase(),
      sourceCount: question.sourceCount,
      contributorCount: question.contributorCount,
      createdAt: question.createdAt.toISOString(),
    })),
    pagination: toPagination(total, page, limit),
  };
}

export async function updateModerationStatus(input: {
  questionId: string;
  moderationStatus: QuestionBankModerationStatus;
  adminOverride: boolean;
}): Promise<void> {
  const question = await prisma.questionBankQuestion.findUnique({
    where: { id: input.questionId },
    select: { id: true, clusterId: true },
  });
  if (!question) {
    throw new AppError(404, "Question not found");
  }

  await prisma.questionBankQuestion.update({
    where: { id: input.questionId },
    data: {
      moderationStatus: input.moderationStatus,
      visibility:
        input.moderationStatus === QuestionBankModerationStatus.REJECTED
          ? QuestionBankVisibility.ADMIN_HIDDEN
          : QuestionBankVisibility.PRIVATE,
    },
  });

  if (question.clusterId) {
    await prisma.questionBankCluster.update({
      where: { id: question.clusterId },
      data: { adminOverride: input.adminOverride },
    });
    await refreshQuestionBankCluster(question.clusterId);
  }
}

async function upsertCompany(name: string, industry: string | undefined): Promise<string | undefined> {
  const cleaned = normalizeSpaces(name);
  if (!cleaned) return undefined;
  const slug = slugify(cleaned);
  const existingCompany = await prisma.company.findUnique({ where: { slug } });
  const company = await prisma.questionBankCompany.upsert({
    where: { slug },
    create: {
      existingCompanyId: existingCompany?.id,
      name: cleaned,
      slug,
      aliases: [],
      industry,
      normalizedName: normalizeLookupName(cleaned),
    },
    update: {
      name: cleaned,
      ...(industry ? { industry } : {}),
      ...(existingCompany ? { existingCompanyId: existingCompany.id } : {}),
      normalizedName: normalizeLookupName(cleaned),
    },
  });
  return company.id;
}

async function upsertRole(name: string): Promise<string | undefined> {
  const cleaned = normalizeSpaces(name);
  if (!cleaned) return undefined;
  const slug = slugify(cleaned);
  const role = await prisma.questionBankRole.upsert({
    where: { slug },
    create: {
      name: cleaned,
      slug,
      normalizedName: normalizeLookupName(cleaned),
    },
    update: {
      name: cleaned,
      normalizedName: normalizeLookupName(cleaned),
    },
  });
  return role.id;
}

async function upsertTechnologies(technologies: string[]): Promise<void> {
  const uniqueTechnologies = Array.from(new Set(technologies.map(normalizeSpaces).filter(Boolean)));
  await Promise.all(
    uniqueTechnologies.map((technology) =>
      prisma.questionBankTechnology.upsert({
        where: { slug: slugify(technology) },
        create: {
          name: technology,
          slug: slugify(technology),
          aliases: [],
          category: "general",
        },
        update: { name: technology },
      }),
    ),
  );
}

async function countEligibleSourcesForQuestion(questionId: string): Promise<QuestionSourceCounts> {
  const sources = await prisma.questionBankSource.findMany({
    where: {
      questionId,
      contributionOptIn: true,
    },
    select: {
      id: true,
      sourceUserId: true,
      sourceSessionId: true,
    },
  });

  return {
    sourceCount: sources.length,
    contributorCount: new Set(sources.map((source) => source.sourceUserId).filter(Boolean)).size,
    sourceSessionCount: new Set(sources.map((source) => source.sourceSessionId).filter(Boolean)).size,
  };
}

export async function refreshQuestionBankCluster(clusterId: string): Promise<void> {
  const cluster = await prisma.questionBankCluster.findUnique({
    where: { id: clusterId },
    include: {
      questions: {
        select: {
          id: true,
          companyId: true,
          roleId: true,
          visibilityClass: true,
          privacyRisk: true,
          moderationStatus: true,
        },
      },
    },
  });
  if (!cluster) return;

  const sources = await prisma.questionBankSource.findMany({
    where: {
      clusterId,
      contributionOptIn: true,
      question: {
        visibilityClass: QuestionBankVisibilityClass.VALID_INTERVIEW_QUESTION,
        privacyRisk: { not: QuestionBankPrivacyRisk.HIGH },
        moderationStatus: { in: PUBLIC_MODERATION_STATUSES },
      },
    },
    select: {
      id: true,
      questionId: true,
      sourceUserId: true,
      sourceSessionId: true,
    },
  });

  const contributorCount = new Set(sources.map((source) => source.sourceUserId).filter(Boolean)).size;
  const sourceSessionCount = new Set(sources.map((source) => source.sourceSessionId).filter(Boolean)).size;
  const sourceCount = sources.length;
  const firstQuestion = cluster.questions[0];
  const companyRoleSourceCount = firstQuestion
    ? await prisma.questionBankSource.count({
        where: {
          contributionOptIn: true,
          question: {
            companyId: firstQuestion.companyId,
            roleId: firstQuestion.roleId,
            visibilityClass: QuestionBankVisibilityClass.VALID_INTERVIEW_QUESTION,
            privacyRisk: { not: QuestionBankPrivacyRisk.HIGH },
            moderationStatus: { in: PUBLIC_MODERATION_STATUSES },
          },
        },
      })
    : 0;

  const publicEligible =
    cluster.adminOverride || contributorCount >= 3 || companyRoleSourceCount >= 5;
  const publicReason = cluster.adminOverride
    ? "admin_override"
    : contributorCount >= 3
      ? "three_distinct_contributors"
      : companyRoleSourceCount >= 5
        ? "five_company_role_sources"
        : "privacy_threshold_not_met";

  await prisma.questionBankCluster.update({
    where: { id: clusterId },
    data: {
      frequencyCount: sourceCount,
      contributorCount,
      sourceSessionCount,
      publicEligible,
      publicReason,
    },
  });

  for (const question of cluster.questions) {
    const counts = await countEligibleSourcesForQuestion(question.id);
    const questionPublicEligible =
      publicEligible &&
      question.visibilityClass === QuestionBankVisibilityClass.VALID_INTERVIEW_QUESTION &&
      question.privacyRisk !== QuestionBankPrivacyRisk.HIGH &&
      PUBLIC_MODERATION_STATUSES.includes(question.moderationStatus);
    await prisma.questionBankQuestion.update({
      where: { id: question.id },
      data: {
        frequencyCount: counts.sourceCount,
        sourceCount: counts.sourceCount,
        contributorCount: counts.contributorCount,
        visibility: questionPublicEligible
          ? QuestionBankVisibility.PUBLIC_AGGREGATED
          : QuestionBankVisibility.PRIVATE,
      },
    });
  }
}

export async function refreshQuestionBankClusters(clusterIds: string[]): Promise<void> {
  const uniqueIds = Array.from(new Set(clusterIds.filter(Boolean)));
  for (const clusterId of uniqueIds) {
    await refreshQuestionBankCluster(clusterId);
  }
}

export async function removeSessionQuestionBankSources(sessionId: string): Promise<void> {
  const sources = await prisma.questionBankSource.findMany({
    where: { sourceSessionId: sessionId },
    select: { clusterId: true },
  });
  const clusterIds = sources.map((source) => source.clusterId).filter((value): value is string => Boolean(value));
  await prisma.questionBankSource.deleteMany({
    where: { sourceSessionId: sessionId },
  });
  await refreshQuestionBankClusters(clusterIds);
}

export async function storeExtractedQuestion(input: StoredQuestionInput): Promise<{
  questionId: string;
  clusterId: string;
  acceptedForPublicPool: boolean;
}> {
  const companyId = await upsertCompany(input.question.companyGuess || input.companyName, input.question.industry);
  const roleId = await upsertRole(input.question.roleGuess || input.roleName);
  if (!companyId || !roleId) {
    throw new AppError(400, "Question Bank source company and role are required");
  }
  const companySlug = slugify(input.question.companyGuess || input.companyName);
  const roleSlug = slugify(input.question.roleGuess || input.roleName);
  const normalizedQuestion = normalizeQuestionText(input.question.normalizedQuestion);
  const canonicalHash = canonicalQuestionHash(normalizedQuestion, companySlug, roleSlug);
  const technologies = Array.from(new Set(input.question.technologies.map(normalizeSpaces).filter(Boolean)));
  const topics = Array.from(new Set(input.question.topics.map(normalizeSpaces).filter(Boolean)));

  await upsertTechnologies(technologies);

  const cluster = await prisma.questionBankCluster.upsert({
    where: { canonicalHash },
    create: {
      canonicalQuestion: normalizedQuestion,
      canonicalHash,
      companyId,
      roleId,
      technologies,
      topics,
    },
    update: {
      canonicalQuestion: normalizedQuestion,
      companyId,
      roleId,
      technologies,
      topics,
    },
  });

  const question = await prisma.questionBankQuestion.upsert({
    where: {
      canonicalHash_companyId_roleId: {
        canonicalHash,
        companyId,
        roleId,
      },
    },
    create: {
      normalizedQuestion,
      displayTitle: input.question.displayTitle,
      canonicalHash,
      clusterId: cluster.id,
      companyId,
      roleId,
      industry: input.question.industry,
      questionType: input.question.questionType,
      difficulty: input.question.difficulty,
      complexityScore: input.question.complexityScore,
      technologies,
      topics,
      visibility: input.question.visibility,
      visibilityClass: input.question.visibilityClass,
      privacyRisk: input.question.privacyRisk,
      moderationStatus: input.question.moderationStatus,
      sourceType: input.question.sourceType,
      lastSeenAt: new Date(),
    },
    update: {
      normalizedQuestion,
      displayTitle: input.question.displayTitle,
      clusterId: cluster.id,
      companyId,
      roleId,
      industry: input.question.industry,
      questionType: input.question.questionType,
      difficulty: input.question.difficulty,
      complexityScore: input.question.complexityScore,
      technologies,
      topics,
      visibilityClass: input.question.visibilityClass,
      privacyRisk: input.question.privacyRisk,
      moderationStatus: input.question.moderationStatus,
      sourceType: input.question.sourceType,
      lastSeenAt: new Date(),
    },
  });

  await prisma.questionBankSource.upsert({
    where: {
      sourceKey: sourceKey({
        sessionId: input.sourceSessionId,
        qaId: input.sourceQaId,
        canonicalHash,
      }),
    },
    create: {
      sourceKey: sourceKey({
        sessionId: input.sourceSessionId,
        qaId: input.sourceQaId,
        canonicalHash,
      }),
      questionId: question.id,
      clusterId: cluster.id,
      sourceUserId: input.sourceUserId,
      sourceSessionId: input.sourceSessionId,
      sourceQaId: input.sourceQaId,
      sourceType: QuestionBankSourceType.SESSION_EXTRACTED,
      extractionConfidence: input.question.confidence,
      sanitizerVersion: "question-bank-2.0-v1",
      contributionOptIn: input.contributionOptIn,
    },
    update: {
      questionId: question.id,
      clusterId: cluster.id,
      sourceUserId: input.sourceUserId,
      sourceSessionId: input.sourceSessionId,
      sourceQaId: input.sourceQaId,
      extractionConfidence: input.question.confidence,
      contributionOptIn: input.contributionOptIn,
    },
  });

  await refreshQuestionBankCluster(cluster.id);

  return {
    questionId: question.id,
    clusterId: cluster.id,
    acceptedForPublicPool:
      input.question.visibilityClass === QuestionBankVisibilityClass.VALID_INTERVIEW_QUESTION &&
      input.question.privacyRisk !== QuestionBankPrivacyRisk.HIGH,
  };
}

export function buildSanitizedQuestion(input: {
  extracted: {
    rawDetectedQuestion: string;
    normalizedQuestion: string;
    visibilityClass: QuestionBankVisibilityClass;
    privacyRisk: QuestionBankPrivacyRisk;
    questionType: QuestionBankQuestionType;
    difficulty: QuestionBankDifficulty;
    complexityScore: number;
    technologies: string[];
    topics: string[];
    industry?: string;
    roleGuess?: string;
    companyGuess?: string;
    confidence: number;
    rejectReason?: string;
  };
  hardRejectReason?: string;
}): SanitizedExtractedQuestion {
  const normalizedQuestion = normalizeQuestionText(input.extracted.normalizedQuestion || input.extracted.rawDetectedQuestion);
  const hardRejected = Boolean(input.hardRejectReason);
  const visibilityClass = hardRejected
    ? QuestionBankVisibilityClass.UNSAFE_TO_PUBLISH
    : input.extracted.visibilityClass;
  const privacyRisk = hardRejected ? QuestionBankPrivacyRisk.HIGH : input.extracted.privacyRisk;
  const validPublicCandidate =
    visibilityClass === QuestionBankVisibilityClass.VALID_INTERVIEW_QUESTION &&
    privacyRisk !== QuestionBankPrivacyRisk.HIGH &&
    input.extracted.confidence >= 0.65;

  return {
    ...input.extracted,
    normalizedQuestion,
    displayTitle: displayTitleFromQuestion(normalizedQuestion),
    visibility: QuestionBankVisibility.PRIVATE,
    visibilityClass,
    privacyRisk,
    moderationStatus: validPublicCandidate
      ? QuestionBankModerationStatus.AUTO_APPROVED
      : QuestionBankModerationStatus.NEEDS_REVIEW,
    sourceType: QuestionBankSourceType.SESSION_EXTRACTED,
    rejectReason: input.hardRejectReason || input.extracted.rejectReason,
  };
}
