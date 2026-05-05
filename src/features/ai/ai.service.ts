import { OpenRouter } from "@openrouter/sdk";
import { Prisma } from "@prisma/client";
import { AppError } from "../../shared/middleware/error.middleware";
import { prisma } from "../../shared/lib/prisma";
import type {
  ProjectGenerationRequest,
  ProjectGenerationResponse,
  SkillMismatchResult,
} from "./ai.types";

type CreditUsageDelegate = {
  count: (args: unknown) => Promise<number>;
  create: (args: unknown) => Promise<unknown>;
};

const PROJECT_GENERATION_COST = new Prisma.Decimal("4.00");
const PROJECT_GENERATION_MODEL =
  process.env.OPENROUTER_MODEL || "google/gemini-1.5-pro";

const ai = process.env.OPENROUTER_API_KEY
  ? new OpenRouter({ apiKey: process.env.OPENROUTER_API_KEY })
  : null;

const KNOWN_TECH = [
  "react",
  "next.js",
  "node.js",
  "express",
  "typescript",
  "javascript",
  "postgresql",
  "mysql",
  "mongodb",
  "redis",
  "docker",
  "kubernetes",
  "aws",
  "gcp",
  "azure",
  "python",
  "java",
  "go",
  "tailwind",
  "graphql",
  "rest",
  "prisma",
  "fastapi",
  "django",
  "flask",
  "ci/cd",
  "github actions",
  "jenkins",
];

const ROLE_CATEGORY_MAP: Record<string, string[]> = {
  frontend: ["Web App", "Mobile App", "CLI Tool"],
  backend: ["API Service", "Data Pipeline", "DevOps/Infrastructure"],
  fullstack: ["Web App", "API Service", "DevOps/Infrastructure"],
  devops: ["DevOps/Infrastructure", "API Service", "Data Pipeline"],
  data: ["Data Pipeline", "ML Model", "API Service"],
  ml: ["ML Model", "Data Pipeline", "API Service"],
  mobile: ["Mobile App", "API Service", "Web App"],
};

function normalizeSkill(value: string): string {
  return value.trim().toLowerCase();
}

function unique(values: string[]): string[] {
  return [...new Set(values.map(normalizeSkill).filter(Boolean))];
}

function collectSkillsFromUnknown(value: unknown): string[] {
  if (!value) return [];

  if (typeof value === "string") {
    return extractSkillsFromText(value);
  }

  if (Array.isArray(value)) {
    return value.flatMap((item) => collectSkillsFromUnknown(item));
  }

  if (typeof value === "object") {
    const objectValue = value as Record<string, unknown>;
    return Object.entries(objectValue).flatMap(([key, nested]) => {
      if (key.toLowerCase().includes("skill")) {
        return collectSkillsFromUnknown(nested);
      }
      return collectSkillsFromUnknown(nested);
    });
  }

  return [];
}

export function extractSkillsFromText(text: string): string[] {
  const normalizedText = text.toLowerCase();
  return KNOWN_TECH.filter((skill) => normalizedText.includes(skill));
}

export function extractSkillsFromResumeArtifacts(
  parsedData: unknown,
  metadataIndex: unknown,
  resumeContext: string | null | undefined,
): string[] {
  return unique([
    ...collectSkillsFromUnknown(parsedData),
    ...collectSkillsFromUnknown(metadataIndex),
    ...extractSkillsFromText(resumeContext || ""),
  ]);
}

export function getProjectCategories(roleType?: string) {
  const normalized = (roleType || "").toLowerCase().replace(/\s+/g, "");
  const categories = ROLE_CATEGORY_MAP[normalized] || [
    "Web App",
    "API Service",
    "Data Pipeline",
    "Mobile App",
    "DevOps/Infrastructure",
    "ML Model",
    "CLI Tool",
  ];

  return {
    role_type: roleType || "general",
    categories,
  };
}

export function computeSkillMismatch(
  requestedSkills: string[],
  knownSkills: string[],
): SkillMismatchResult {
  const requested = unique(requestedSkills);
  const known = unique(knownSkills);

  if (!requested.length) {
    return {
      mismatchRatio: 0,
      scopeLimited: false,
      allowedSkills: known,
    };
  }

  const missing = requested.filter((skill) => !known.includes(skill));
  const mismatchRatio = missing.length / requested.length;
  const scopeLimited = mismatchRatio > 0.4;

  const overlap = requested.filter((skill) => known.includes(skill));
  const allowedSkills = unique(scopeLimited ? [...overlap, ...known] : known);

  return {
    mismatchRatio,
    scopeLimited,
    allowedSkills,
  };
}

export function detectCredibilityWarning(
  experienceLevel: ProjectGenerationRequest["experience_level"],
  narrativeBundle: string,
) {
  const text = narrativeBundle.toLowerCase();
  const hasExtremePercent = /(\d{3,}|1000)%/.test(text);
  const hasHugeUsers = /(\d+\s?m\b|\d+\s?million\s+users)/.test(text);

  if (
    (experienceLevel === "fresher" || experienceLevel === "junior") &&
    (hasExtremePercent || hasHugeUsers)
  ) {
    return {
      warning: true,
      message:
        "Some outcomes may seem ambitious for your experience level. Review before adding.",
    };
  }

  return { warning: false, message: undefined as string | undefined };
}

function parseFirstJsonObject(text: string): Record<string, unknown> {
  const cleaned = text.replace(/^```json\s*/i, "").replace(/```\s*$/, "").trim();
  try {
    return JSON.parse(cleaned) as Record<string, unknown>;
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) {
      throw new AppError(502, "AI returned invalid JSON payload");
    }
    return JSON.parse(match[0]) as Record<string, unknown>;
  }
}

function buildPrompt(input: {
  roleType: string;
  jdText: string;
  experienceLevel: string;
  knownSkills: string[];
  categories: string[];
}) {
  return `You are an expert engineering interview coach and resume strategist.

Generate exactly one project idea in strict JSON with these keys only:
project_title, narrative, star_story, architecture, ascii_diagram, thirty_sec_summary, memory_hooks, credibility_score

Rules:
1) Output valid JSON only, no markdown.
2) Keep it realistic and human-like.
3) Use only known skill stack where possible.
4) star_story must include situation, task, action, result.
5) architecture must include frontend, backend, database, infrastructure.
6) memory_hooks must have 2-4 concise strings.
7) credibility_score must be integer from 0 to 100.

Input role type: ${input.roleType}
Experience level: ${input.experienceLevel}
Known skills: ${input.knownSkills.join(", ")}
Allowed categories: ${input.categories.join(", ")}
Job description: ${input.jdText || "(not provided)"}
`;
}

async function callProjectModel(prompt: string) {
  if (!ai) {
    throw new AppError(500, "OPENROUTER_API_KEY environment variable is not defined");
  }

  const send = async () =>
    ai.chat.send({
      chatRequest: {
        model: PROJECT_GENERATION_MODEL,
        messages: [
          { role: "system", content: "You are a precise JSON generator." },
          { role: "user", content: prompt },
        ],
        stream: false,
      },
    });

  try {
    const response = await send();
    const content = response.choices?.[0]?.message?.content;
    if (!content) throw new AppError(502, "AI returned empty response");
    return parseFirstJsonObject(content);
  } catch (firstErr) {
    try {
      const retry = await send();
      const content = retry.choices?.[0]?.message?.content;
      if (!content) throw new AppError(502, "AI returned empty response");
      return parseFirstJsonObject(content);
    } catch {
      throw new AppError(503, "AI model temporarily unavailable");
    }
  }
}

async function assertRateLimit(userId: string, resumeId?: string, sessionKey?: string) {
  const windowStart = new Date(Date.now() - 60 * 60 * 1000);
  const metadataContains = sessionKey
    ? { path: ["sessionKey"], equals: sessionKey }
    : undefined;

  const creditUsage = (prisma as unknown as { creditUsage?: CreditUsageDelegate })
    .creditUsage;

  if (!creditUsage) {
    throw new AppError(500, "CreditUsage model is unavailable in Prisma client");
  }

  const count = await creditUsage.count({
    where: {
      userId,
      operation: "PROJECT_GENERATION",
      createdAt: { gte: windowStart },
      ...(resumeId ? { resumeId } : {}),
      ...(metadataContains ? { metadata: metadataContains } : {}),
    },
  });

  if (count >= 5) {
    throw new AppError(429, "Rate limit exceeded: max 5 generations per session window");
  }
}

async function deductCreditsAndLog(input: {
  userId: string;
  resumeId?: string;
  roleType: string;
  model: string;
  mismatchRatio: number;
  scopeLimited: boolean;
  sessionKey?: string;
}) {
  await prisma.$transaction(async (tx) => {
    const balance = await tx.userCreditBalance.findUnique({
      where: { userId: input.userId },
    });

    if (!balance) throw new AppError(402, "INSUFFICIENT_CREDITS");

    const before = new Prisma.Decimal(balance.totalAvailable.toString());
    if (before.lt(PROJECT_GENERATION_COST)) {
      throw new AppError(402, "INSUFFICIENT_CREDITS");
    }

    const after = before.minus(PROJECT_GENERATION_COST);

    await tx.userCreditBalance.update({
      where: { userId: input.userId },
      data: {
        totalAvailable: after,
      },
    });

    await tx.creditLedger.create({
      data: {
        userId: input.userId,
        type: "DEBIT",
        amount: PROJECT_GENERATION_COST,
        balanceBefore: before,
        balanceAfter: after,
        reason: "PROJECT_GENERATION",
      },
    });

    const creditUsage = (tx as unknown as { creditUsage?: CreditUsageDelegate })
      .creditUsage;

    if (!creditUsage) {
      throw new AppError(500, "CreditUsage model is unavailable in Prisma client");
    }

    await creditUsage.create({
      data: {
        userId: input.userId,
        resumeId: input.resumeId,
        operation: "PROJECT_GENERATION",
        creditsUsed: PROJECT_GENERATION_COST,
        aiModel: input.model,
        cached: false,
        metadata: {
          roleType: input.roleType,
          mismatchRatio: Number(input.mismatchRatio.toFixed(2)),
          scopeLimited: input.scopeLimited,
          sessionKey: input.sessionKey || null,
        },
      },
    });
  });
}

export async function generateProjectGeneration(
  dbUserId: string,
  payload: ProjectGenerationRequest,
): Promise<ProjectGenerationResponse> {
  const resume = payload.resume_id
    ? await prisma.resume.findFirst({
        where: { id: payload.resume_id, userId: dbUserId },
      })
    : null;

  const resumeCompat = resume as
    | (Record<string, unknown> & {
        id: string;
        resumeContext?: string | null;
        parsedData?: unknown;
        metadataIndex?: unknown;
      })
    | null;

  const extracted = extractSkillsFromResumeArtifacts(
    resumeCompat?.parsedData,
    resumeCompat?.metadataIndex,
    (resumeCompat?.resumeContext as string | null | undefined) || null,
  );

  const allKnownSkills = unique([...(payload.resume_skills || []), ...extracted]);

  if (allKnownSkills.length < 2) {
    throw new AppError(400, "At least 2 skills are required to generate a project");
  }

  const requestedSkills = unique([
    ...extractSkillsFromText(payload.jd_text || ""),
    ...extractSkillsFromText(payload.role_type || ""),
  ]);

  const mismatch = computeSkillMismatch(requestedSkills, allKnownSkills);
  await assertRateLimit(dbUserId, payload.resume_id, payload.session_key);

  const categories = getProjectCategories(payload.role_type).categories;
  const prompt = buildPrompt({
    roleType: payload.role_type,
    jdText: payload.jd_text || "",
    experienceLevel: payload.experience_level,
    knownSkills: mismatch.scopeLimited ? mismatch.allowedSkills : allKnownSkills,
    categories,
  });

  const aiResponse = await callProjectModel(prompt);

  const projectTitle = String(aiResponse.project_title || "Project");
  const narrative = String(aiResponse.narrative || "");
  const starStoryRaw = (aiResponse.star_story || {}) as Record<string, unknown>;
  const architectureRaw = (aiResponse.architecture || {}) as Record<string, unknown>;
  const memoryHooksRaw = Array.isArray(aiResponse.memory_hooks)
    ? aiResponse.memory_hooks
    : [];

  const combinedText = [
    narrative,
    String(starStoryRaw.result || ""),
    String(aiResponse.thirty_sec_summary || ""),
  ].join(" ");

  const warning = detectCredibilityWarning(payload.experience_level, combinedText);

  const credibilityScore = Math.max(
    0,
    Math.min(
      100,
      Number(aiResponse.credibility_score || 82) -
        (mismatch.scopeLimited ? 8 : 0) -
        (warning.warning ? 10 : 0),
    ),
  );

  await deductCreditsAndLog({
    userId: dbUserId,
    resumeId: payload.resume_id,
    roleType: payload.role_type,
    model: PROJECT_GENERATION_MODEL,
    mismatchRatio: mismatch.mismatchRatio,
    scopeLimited: mismatch.scopeLimited,
    sessionKey: payload.session_key,
  });

  const response: ProjectGenerationResponse = {
    project_title: projectTitle,
    narrative,
    star_story: {
      situation: String(starStoryRaw.situation || ""),
      task: String(starStoryRaw.task || ""),
      action: String(starStoryRaw.action || ""),
      result: String(starStoryRaw.result || ""),
    },
    architecture: {
      frontend: String(architectureRaw.frontend || ""),
      backend: String(architectureRaw.backend || ""),
      database: String(architectureRaw.database || ""),
      infrastructure: String(architectureRaw.infrastructure || ""),
    },
    ascii_diagram: String(aiResponse.ascii_diagram || ""),
    thirty_sec_summary: String(aiResponse.thirty_sec_summary || ""),
    memory_hooks: memoryHooksRaw.map(String),
    credibility_score: credibilityScore,
    credibility_warning: warning.warning,
    warning_message: warning.message,
    scope_limited: mismatch.scopeLimited,
    credits_consumed: Number(PROJECT_GENERATION_COST),
  };

  if (resumeCompat) {
    const parsedData =
      (resumeCompat.parsedData as Record<string, unknown> | null) || {};
    const currentProjects = Array.isArray(parsedData.projects)
      ? parsedData.projects
      : [];

    await (prisma.resume as unknown as { update: (args: unknown) => Promise<unknown> }).update(
      {
        where: { id: resumeCompat.id },
        data: {
          parsedData: {
            ...parsedData,
            projects: [...currentProjects, response],
          },
        },
      },
    );
  }

  return response;
}
