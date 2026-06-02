import crypto from "crypto";
import { prisma } from "../../shared/lib/prisma";
import { getUnifiedResumeContext } from "../resume/resume.service";
import { candidateDigestQueue } from "../jobs/queue";

export type CandidateProjectCard = {
  name: string;
  stack: string[];
  role: string;
  impact: string;
  architecture?: string;
};

export type CandidateContextDigestValue = {
  sessionId: string;
  sourceHash: string;
  resumeDigest: string;
  skills: string[];
  projectCards: CandidateProjectCard[];
  experienceFacts: string[];
  domainKeywords: string[];
  status: "READY" | "FALLBACK" | "FAILED";
};

type SessionDigestSource = {
  id: string;
  resumeId: string;
  documentId: string;
  projectIds: unknown;
  companyName: string;
  jobDescription: string;
  extraContext: string;
};

function normalizeSpaces(text: string): string {
  return (text || "").replace(/\s+/g, " ").trim();
}

function unique(values: string[], limit: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const normalized = normalizeSpaces(value);
    const key = normalized.toLowerCase();
    if (normalized.length < 2 || seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
    if (out.length >= limit) break;
  }
  return out;
}

function selectedProjectIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter(Boolean);
}

function hashDigestSource(source: SessionDigestSource): string {
  const payload = {
    resumeId: source.resumeId,
    documentId: source.documentId,
    projectIds: selectedProjectIds(source.projectIds),
    companyName: source.companyName,
    jobDescription: source.jobDescription,
    extraContext: source.extraContext,
  };
  return crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function extractSkills(text: string): string[] {
  const knownTerms = [
    "React", "React Native", "Node.js", "Express.js", "TypeScript", "JavaScript",
    "PostgreSQL", "MongoDB", "Redis", "Docker", "Kubernetes", "AWS", "Azure",
    "Python", "Java", "Spring", "GraphQL", "REST API", "Tauri", "Prisma",
    "BullMQ", "Deepgram", "OpenRouter", "RAG", "CI/CD",
  ];
  const matches = knownTerms.filter((term) =>
    new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text),
  );
  const skillSection = text.match(/(?:skills?|technical skills?)[:\s\n]+([\s\S]{0,900})/i)?.[1] || "";
  const sectionTerms = skillSection
    .split(/[,|•\n]/)
    .map((item) => item.replace(/[-:]/g, " ").trim())
    .filter((item) => item.length >= 2 && item.length <= 40);
  return unique([...matches, ...sectionTerms], 40);
}

function extractFacts(text: string): string[] {
  const sentences = normalizeSpaces(text)
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) =>
      sentence.length > 30 &&
      /\b(project|experience|built|implemented|developed|managed|led|improved|reduced|increased|migrated|designed)\b/i.test(sentence),
    );
  return unique(sentences.map((sentence) => sentence.slice(0, 220)), 12);
}

function summarizeResume(text: string): string {
  const cleaned = normalizeSpaces(text);
  if (!cleaned) return "No resume digest available.";
  const facts = extractFacts(cleaned);
  const skills = extractSkills(cleaned);
  const summary = [
    facts.length ? `Experience facts: ${facts.join(" ")}` : cleaned.slice(0, 1200),
    skills.length ? `Skills: ${skills.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  return summary.slice(0, 3200);
}

function extractStackFromProject(project: any): string[] {
  const sections = Array.isArray(project?.sections) ? project.sections : [];
  const tags = sections.find((section: any) => section?.type === "tech_tags")?.content;
  if (!Array.isArray(tags)) return [];
  return unique(
    tags.flatMap((category: any) =>
      Array.isArray(category?.tags)
        ? category.tags.map((tag: unknown) => String(tag || ""))
        : [],
    ),
    16,
  );
}

function extractProjectCards(projectRecords: any[]): CandidateProjectCard[] {
  const cards: CandidateProjectCard[] = [];
  for (const record of projectRecords) {
    const projects = Array.isArray(record.projects) ? record.projects : [];
    for (const project of projects) {
      const header = project?.projectHeader || {};
      const sections = Array.isArray(project?.sections) ? project.sections : [];
      const architectureSection = sections.find((section: any) =>
        section?.key === "architecture_diagram" ||
        section?.key === "architecture_tree" ||
        /architecture/i.test(String(section?.title || "")),
      );
      const metricsSection = sections.find((section: any) => section?.type === "metrics");
      const impact = Array.isArray(metricsSection?.content)
        ? metricsSection.content
            .slice(0, 2)
            .map((item: any) => `${item?.metric || "Metric"}: ${item?.value || ""}`)
            .join("; ")
        : "";
      cards.push({
        name: String(header.title || "Untitled project"),
        stack: extractStackFromProject(project),
        role: String(header.role || ""),
        impact,
        architecture:
          typeof architectureSection?.content === "string"
            ? architectureSection.content.slice(0, 600)
            : undefined,
      });
    }
  }
  return cards.slice(0, 8);
}

function digestFromRow(row: {
  sessionId: string;
  sourceHash: string;
  status: string;
  resumeDigest: string;
  skills: string[];
  projectCards: unknown;
  experienceFacts: unknown;
  domainKeywords: string[];
}): CandidateContextDigestValue {
  return {
    sessionId: row.sessionId,
    sourceHash: row.sourceHash,
    resumeDigest: row.resumeDigest,
    skills: row.skills,
    projectCards: Array.isArray(row.projectCards)
      ? (row.projectCards as CandidateProjectCard[])
      : [],
    experienceFacts: Array.isArray(row.experienceFacts)
      ? (row.experienceFacts as string[])
      : [],
    domainKeywords: row.domainKeywords,
    status: row.status === "FAILED" ? "FAILED" : "READY",
  };
}

function buildFallbackDigest(source: SessionDigestSource): CandidateContextDigestValue {
  const selectedIds = selectedProjectIds(source.projectIds);
  const keywords = unique(
    [
      ...normalizeSpaces(source.jobDescription).split(/\W+/),
      source.companyName,
      ...selectedIds,
    ],
    24,
  );
  return {
    sessionId: source.id,
    sourceHash: hashDigestSource(source),
    resumeDigest: normalizeSpaces(
      `${source.companyName} ${source.jobDescription} ${source.extraContext}`,
    ).slice(0, 800) || "Minimal candidate context only.",
    skills: keywords.filter((keyword) => keyword.length > 2).slice(0, 12),
    projectCards: selectedIds.map((id) => ({
      name: id,
      stack: [],
      role: "",
      impact: "",
    })),
    experienceFacts: [],
    domainKeywords: keywords,
    status: "FALLBACK",
  };
}

async function loadSessionDigestSource(sessionId: string): Promise<SessionDigestSource | null> {
  return prisma.session.findUnique({
    where: { id: sessionId },
    select: {
      id: true,
      resumeId: true,
      documentId: true,
      projectIds: true,
      companyName: true,
      jobDescription: true,
      extraContext: true,
    },
  });
}

export async function enqueueCandidateDigestWarmup(sessionId: string): Promise<void> {
  await candidateDigestQueue.add(
    "candidate-digest",
    { sessionId },
    { jobId: `candidate-digest:${sessionId}` },
  );
}

export async function getCandidateDigestForAnswer(
  sessionId: string,
): Promise<CandidateContextDigestValue> {
  const source = await loadSessionDigestSource(sessionId);
  if (!source) throw new Error(`Session not found while loading candidate digest: ${sessionId}`);

  const sourceHash = hashDigestSource(source);
  const row = await prisma.candidateContextDigest.findUnique({
    where: { sessionId },
  });
  if (row && row.sourceHash === sourceHash && row.status === "READY") {
    return digestFromRow(row);
  }

  enqueueCandidateDigestWarmup(sessionId).catch((error) => {
    console.warn("[candidate-digest] warmup enqueue failed", { sessionId, error });
  });
  return buildFallbackDigest(source);
}

export async function buildCandidateContextDigest(sessionId: string): Promise<void> {
  const source = await loadSessionDigestSource(sessionId);
  if (!source) throw new Error(`Session not found while building candidate digest: ${sessionId}`);

  const sourceHash = hashDigestSource(source);
  const projectIds = selectedProjectIds(source.projectIds);
  const [resume, projectRecords] = await Promise.all([
    source.resumeId ? getUnifiedResumeContext(source.resumeId) : Promise.resolve(null),
    projectIds.length
      ? prisma.project.findMany({ where: { id: { in: projectIds } } })
      : Promise.resolve([]),
  ]);

  const resumeText = resume?.resumeContext || "";
  const projectCards = extractProjectCards(projectRecords);
  const skills = unique(
    [
      ...extractSkills(resumeText),
      ...projectCards.flatMap((card) => card.stack),
      ...normalizeSpaces(source.jobDescription).split(/\W+/),
    ],
    48,
  );
  const experienceFacts = extractFacts(resumeText);
  const domainKeywords = unique(
    [
      ...skills,
      ...projectCards.map((card) => card.name),
      source.companyName,
      ...normalizeSpaces(source.jobDescription).split(/\W+/),
    ],
    48,
  );

  await prisma.candidateContextDigest.upsert({
    where: { sessionId },
    create: {
      sessionId,
      resumeId: source.resumeId,
      documentId: source.documentId || null,
      projectIds,
      sourceHash,
      status: "READY",
      resumeDigest: summarizeResume(resumeText),
      skills,
      projectCards,
      experienceFacts,
      domainKeywords,
    },
    update: {
      resumeId: source.resumeId,
      documentId: source.documentId || null,
      projectIds,
      sourceHash,
      status: "READY",
      errorMessage: null,
      resumeDigest: summarizeResume(resumeText),
      skills,
      projectCards,
      experienceFacts,
      domainKeywords,
    },
  });
}

export async function markCandidateDigestFailed(
  sessionId: string,
  error: unknown,
): Promise<void> {
  const source = await loadSessionDigestSource(sessionId);
  if (!source) return;
  await prisma.candidateContextDigest.upsert({
    where: { sessionId },
    create: {
      sessionId,
      resumeId: source.resumeId,
      documentId: source.documentId || null,
      projectIds: selectedProjectIds(source.projectIds),
      sourceHash: hashDigestSource(source),
      status: "FAILED",
      errorMessage: error instanceof Error ? error.message : String(error),
      resumeDigest: "",
      skills: [],
      projectCards: [],
      experienceFacts: [],
      domainKeywords: [],
    },
    update: {
      status: "FAILED",
      errorMessage: error instanceof Error ? error.message : String(error),
    },
  });
}
