import { prisma } from "../../shared/lib/prisma";
import { getUnifiedResumeContext } from "../resume/resume.service";
import { getEncoding } from "js-tiktoken";
import * as documentService from "../document/document.service";
import path from "path";
import { normalizeTranscriptForQuestionDetection } from "./answer-quality";

// Initialize Tiktoken encoding
const encoding = getEncoding("cl100k_base");

// Stopwords to filter out for keyword scoring
const STOP_WORDS = new Set([
  "the", "a", "and", "of", "to", "in", "is", "you", "that", "it", "he", "was",
  "for", "on", "are", "as", "with", "his", "they", "i", "at", "be", "this",
  "have", "from", "or", "one", "had", "by", "word", "but", "not", "what",
  "all", "were", "we", "when", "your", "can", "said", "there", "use", "an",
  "each", "which", "she", "do", "how", "their", "if", "about", "would",
  "make", "like", "him", "into", "time", "has", "look", "two", "more", "write",
  "go", "see", "number", "no", "way", "could", "people", "my", "than", "first",
  "water", "been", "call", "who", "oil", "its", "now", "find", "long", "down",
  "day", "did", "get", "come", "made", "may", "part"
]);

/**
 * Estimates prompt tokens using cl100k_base encoding.
 */
export function estimatePromptTokens(text: string): number {
  if (!text) return 0;
  return encoding.encode(text).length;
}

function trimTextToTokenBudget(text: string, tokenBudget: number): string {
  if (!text || tokenBudget <= 0) return "";
  const tokens = encoding.encode(text);
  if (tokens.length <= tokenBudget) return text;
  if (tokenBudget <= 8) return encoding.decode(tokens.slice(0, tokenBudget));
  return `${encoding.decode(tokens.slice(0, tokenBudget - 8))}\n... (truncated)`;
}

/**
 * Scans a user query for follow-up and continuation keywords.
 */
export function detectFollowupIntent(query: string): boolean {
  if (!query) return false;
  const normalized = normalizeTranscriptForQuestionDetection(query).toLowerCase();
  const signals = [
    "explain more", "why", "how exactly", "elaborate", "give an example",
    "in that context", "you mentioned", "previous answer", "expand on",
    "tell me more", "clarify", "go deeper", "what about", "how so",
    "explain the code", "explain this code", "explain that code", "explain the code again",
    "why this is used", "optimize this", "optimise this", "debug this", "fix this",
    "continue", "continue from", "database part", "architecture part", "backend part",
    "frontend part", "api part", "the code", "the query", "that query", "that code"
  ];
  const pronouns = [/\bit\b/, /\bthat\b/, /\bthis\b/, /\bthem\b/, /\bthey\b/, /\bthe previous\b/];
  const wordCount = normalized.split(/\s+/).filter(Boolean).length;
  
  const hasSignal =
    signals.some(sig => normalized.includes(sig)) ||
    normalized.startsWith("and what");
  const hasPronoun = pronouns.some(regex => regex.test(normalized));
  
  return hasSignal || (hasPronoun && wordCount <= 8);
}

// ── Adaptive Context Complexity Routing ─────────────────────────────────────

export type QuestionComplexity =
  | "simple_atomic"
  | "simple_contextual"
  | "followup"
  | "scenario_based"
  | "system_design";

export function isProjectExperienceQuestion(query: string | undefined): boolean {
  if (!query || !query.trim()) return false;
  const normalized = normalizeTranscriptForQuestionDetection(query).toLowerCase().trim();
  return /\b(projects?|portfolio|what (did|have) you build|tell me about (your|the) project|problem statement|tech stack|project architecture|project design choices?|impact|metrics|kpis?|challenges?|critical situation|critical challenge|my role|your role|implemented|worked on|years? of experience|how many years|professional experience|work experience|responsibilit(?:y|ies)|measurable|rate yourself|services you worked on|included in your tasks)\b/i.test(
    normalized,
  );
}

export function isExplicitProjectDetailQuestion(query: string | undefined): boolean {
  if (!query || !query.trim()) return false;
  const normalized = normalizeTranscriptForQuestionDetection(query).toLowerCase().trim();
  return /\b(projects?|portfolio|what (did|have) you build|tell me about (your|the) project|problem statement|project work|things you built|tech stack|project architecture|project design choices?|impact|metrics|kpis?|challenges?|critical situation|critical challenge|my role in|your role in|implemented|worked on|built|developed|services you worked on)\b/i.test(
    normalized,
  );
}

export function isProjectOverviewQuestion(query: string | undefined): boolean {
  if (!query || !query.trim()) return false;
  const normalized = normalizeTranscriptForQuestionDetection(query).toLowerCase().trim();
  return /\b(explain|describe|tell me about|walk me through|list|share)\b[\s\w]{0,30}\b(projects|project work|work done|things you built)\b/i.test(
    normalized,
  );
}

function isMixedExperienceProjectQuestion(query: string | undefined): boolean {
  if (!query || !query.trim()) return false;
  const normalized = normalizeTranscriptForQuestionDetection(query).toLowerCase();
  const asksIntroOrExperience =
    /\b(introduce|intro|about yourself|experience|years of experience|work experience|mern|tech stack)\b/.test(
      normalized,
    );
  const asksProject =
    /\b(project|frontend|backend|full stack|full-stack|worked on)\b/.test(
      normalized,
    );
  return asksIntroOrExperience && asksProject;
}

export function shouldUseResumeBackedProjectFallback(input: {
  hasSelectedProjects: boolean;
  isProjectQuestion: boolean;
  isProjectDetailQuestion: boolean;
  isProjectOverview: boolean;
  isMixedExperienceProject: boolean;
  hasResume: boolean;
}): boolean {
  return (
    !input.hasSelectedProjects &&
    input.hasResume &&
    (
      input.isProjectQuestion ||
      input.isProjectDetailQuestion ||
      input.isProjectOverview ||
      input.isMixedExperienceProject
    )
  );
}

export function buildSelectedProjectsUnavailableContext(input: {
  selectedProjectIds: string[];
  resolvedProjectIds: string[];
}): string {
  if (input.selectedProjectIds.length === 0) return "";
  const resolved = new Set(input.resolvedProjectIds);
  const unresolvedIds = input.selectedProjectIds.filter((id) => !resolved.has(id));
  if (unresolvedIds.length === 0) return "";
  return [
    "SELECTED_PROJECT_CONTEXT_UNAVAILABLE",
    `Selected project IDs attached to this session: ${input.selectedProjectIds.join(", ")}`,
    `Unresolved selected project IDs: ${unresolvedIds.join(", ")}`,
    "Do not invent project names, companies, tools, metrics, or project details.",
    "If the active question asks for projects, say that selected project details are not available in the provided context.",
  ].join("\n");
}

/**
 * Per-source token budgets for each complexity tier.
 * Sources with budget 0 are skipped entirely (no DB fetch).
 */
export const COMPLEXITY_BUDGETS: Record<
  QuestionComplexity,
  { resume: number; projects: number; document: number; history: number; vector: number; total: number }
> = {
  simple_atomic:     { resume: 300, projects: 200, document: 0,   history: 0,   vector: 0,   total: 800  },
  simple_contextual: { resume: 400, projects: 400, document: 0,   history: 200, vector: 0,   total: 1200 },
  followup:          { resume: 300, projects: 200, document: 0,   history: 800, vector: 200, total: 1800 },
  scenario_based:    { resume: 400, projects: 600, document: 200, history: 600, vector: 300, total: 3500 },
  system_design:     { resume: 600, projects: 800, document: 300, history: 700, vector: 300, total: 4500 },
};

// ── Keyword sets for classification ─────────────────────────────────────────

const PERSONAL_CONTEXT_KEYWORDS = [
  "my project", "my experience", "my resume", "my work", "my background",
  "my skills", "my role", "tell me about yourself", "introduce yourself",
  "your project", "your experience", "based on my", "from my",
  "tell me about a time", "describe a situation",
  "critical situation", "critical challenge", "challenges did you face",
  "situation you faced", "how did you handle it", "rate yourself",
  "manage and secure sensitive credentials", "client id and client secret",
  "where do you store", "key vault", "secrets manager",
  "years of experience", "year of experience", "how many years",
  "professional experience", "work experience", "responsibilities",
  "tech stack", "impact", "metrics", "worked on", "services you worked on",
  "your tasks", "included in your tasks", "how confident", "your confidence",
  // Bare keywords that always need candidate context
  "project", "projects", "resume", "experience", "skills",
  "introduce", "background", "strength", "weakness",
  "qualification", "achievements", "portfolio",
];

const SCENARIO_TRIGGERS = [
  "suppose", "imagine", "if you had to", "in production", "build a system",
  "design a", "let's say", "consider a", "what would you do if",
  "how would you handle", "what if",
  "a user reports", "the system is", "your team has deployed",
  "race condition", "deadlock", "outage", "continue from database part",
  "continue from architecture part", "database part", "architecture part",
  "production issue", "incident", "scenario setup", "how will you tackle",
  "how would you tackle", "inventory", "stock", "oversell", "oversold",
  "multiple users", "concurrent", "high traffic", "negative orders",
];

const SYSTEM_DESIGN_KEYWORDS = [
  "system design", "architecture", "at scale", "distributed",
  "microservices", "load balancer", "database schema", "sharding",
  "message queue", "event driven", "caching layer", "cdn",
  "high availability", "fault tolerance", "cap theorem",
  "design a", "architect", "scalability",
];

const SIMPLE_ATOMIC_PATTERNS = [
  /^what (?:is|are) /i,
  /^define /i,
  /^difference between /i,
  /^what(?:'s| is) the difference /i,
  /^how does .{3,30} work\??$/i,
  /^what does .{3,30} mean\??$/i,
  /^when (?:do|should|would) (?:you|we) use /i,
];

const TECH_CONCEPT_QUERY_RE =
  /\b(spark\s*(?:session|context)?|sparkcontext|sparksession|databricks|pyspark|spark sql|data skew|repartition|coalesce|broadcast join|spark ui|executor|driver|numpy|pandas|generator|decorator|table statistics|column statistics|stats)\b/i;

const SCENARIO_SCALE_RE =
  /\b(1\s*tb|tb|gb\/hour|cluster size|nodes?|cores?|sla|throughput|daily basis|daily data|fixed time window|process(?:ing)? \d+)\b/i;

const SQL_JOIN_COUNT_QUERY_RE =
  /\b(inner join|left join|right join|full join|join count|output rows?|output records?|records? (?:will|would) (?:come|appear)|table1|table2)\b/i;

function hasExplicitScenarioSetupQuery(normalized: string): boolean {
  if (!normalized) return false;
  if (normalized.includes("scenario setup:")) return true;
  const hasProblemDomain =
    /\b(e-?commerce|sale|inventory|stock|orders?|negative|oversell|oversold|multiple users?|concurrent|race condition|high traffic|same product|checkout|payment)\b/i.test(
      normalized,
    );
  const hasScenarioAsk =
    /\b(how (?:would|will|do) you (?:handle|tackle|solve|fix|prevent|approach|resolve)|what (?:would|will|do) you do)\b/i.test(
      normalized,
    );
  return hasProblemDomain && hasScenarioAsk;
}

/**
 * Classifies a question's complexity tier using pure heuristics.
 * Zero AI calls — only pattern matching, word count, and keyword detection.
 */
export function classifyComplexity(query: string | undefined): QuestionComplexity {
  if (!query || !query.trim()) return "system_design"; // No query = full context (screenshot, etc.)

  const normalized = normalizeTranscriptForQuestionDetection(query).toLowerCase().trim();
  const wordCount = normalized.split(/\s+/).filter(Boolean).length;
  const hasScenarioSetup = hasExplicitScenarioSetupQuery(normalized);

  // 1. Scenario-based questions with explicit setup beat stale follow-up and long-question routing.
  const hasScenarioTrigger = SCENARIO_TRIGGERS.some(t => normalized.includes(t));
  if (hasScenarioSetup) {
    return "scenario_based";
  }

  // 2. System design / architecture deep dive
  const hasSystemDesignKeyword = SYSTEM_DESIGN_KEYWORDS.some(kw => normalized.includes(kw));
  if (hasSystemDesignKeyword || (wordCount > 50 && SCENARIO_TRIGGERS.some(t => normalized.includes(t)))) {
    return "system_design";
  }

  // 3. Follow-up detection for short questions that reference prior context.
  if (detectFollowupIntent(query)) {
    return "followup";
  }

  if (hasScenarioTrigger) {
    return "scenario_based";
  }

  // 4. Simple contextual (references personal experience/resume/projects)
  const hasPersonalContext = PERSONAL_CONTEXT_KEYWORDS.some(kw => normalized.includes(kw));
  if (hasPersonalContext) {
    return "simple_contextual";
  }

  if (
    SQL_JOIN_COUNT_QUERY_RE.test(normalized) ||
    (TECH_CONCEPT_QUERY_RE.test(normalized) && !SCENARIO_SCALE_RE.test(normalized))
  ) {
    return "simple_atomic";
  }

  // 5. Simple atomic — short, generic knowledge questions
  const matchesAtomicPattern = SIMPLE_ATOMIC_PATTERNS.some(re => re.test(normalized));
  if (matchesAtomicPattern && wordCount <= 15) {
    return "simple_atomic";
  }

  // 6. Short questions without personal/scenario context → treat as simple_atomic
  if (wordCount <= 12) {
    return "simple_atomic";
  }

  // 7. Medium-length questions → scenario_based (safe default for interview context)
  if (wordCount <= 40) {
    return "scenario_based";
  }

  // 8. Long questions → system_design
  return "system_design";
}

// ── Context Gating ──────────────────────────────────────────────────────────

export function shouldIncludeResume(complexity: QuestionComplexity): boolean {
  return COMPLEXITY_BUDGETS[complexity].resume > 0;
}

export function shouldIncludeProjects(complexity: QuestionComplexity): boolean {
  return COMPLEXITY_BUDGETS[complexity].projects > 0;
}

export function shouldIncludeDocuments(complexity: QuestionComplexity): boolean {
  return COMPLEXITY_BUDGETS[complexity].document > 0;
}

export function shouldIncludeHistory(complexity: QuestionComplexity): boolean {
  return COMPLEXITY_BUDGETS[complexity].history > 0;
}

export function shouldIncludeVectorRAG(complexity: QuestionComplexity): boolean {
  return COMPLEXITY_BUDGETS[complexity].vector > 0;
}

/**
 * Truncates raw resume text from the top to stay within a target token budget.
 * Excludes ATS scoring/analysis entirely.
 */
export function trimResume(resumeText: string, targetBudget = 900): string {
  if (!resumeText) return "";
  const tokens = encoding.encode(resumeText);
  if (tokens.length <= targetBudget) return resumeText;
  const sliced = tokens.slice(0, targetBudget);
  return encoding.decode(sliced) + "\n... (truncated to fit budget)";
}

function isResumeSectionHeading(line: string, pattern: RegExp): boolean {
  const normalized = line.trim().replace(/[:\-]+$/g, "");
  return normalized.length <= 60 && pattern.test(normalized);
}

function splitResumeLines(resumeText: string): string[] {
  return resumeText
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function extractSectionByHeading(
  lines: string[],
  startPattern: RegExp,
  stopPattern: RegExp,
): string {
  const startIndex = lines.findIndex((line) =>
    isResumeSectionHeading(line, startPattern),
  );
  if (startIndex < 0) return "";

  const selected: string[] = [];
  for (let index = startIndex; index < lines.length; index += 1) {
    const line = lines[index];
    if (
      index > startIndex &&
      isResumeSectionHeading(line, stopPattern)
    ) {
      break;
    }
    selected.push(line);
  }
  return selected.join("\n").trim();
}

function extractFirstResumeLine(lines: string[], pattern: RegExp): string {
  const line = lines.find((candidate) => pattern.test(candidate));
  if (!line) return "";
  return line.replace(pattern, "$1").replace(/\s+/g, " ").trim();
}

function extractExplicitTotalExperience(resumeText: string): string {
  const normalized = resumeText.replace(/\s+/g, " ").trim();
  const labeled = normalized.match(
    /\b(?:total\s+)?experience\s*[:\-]\s*([^.|;\n]{0,120}?\b\d+(?:\.\d+)?\+?\s*(?:years?|yrs?)\b[^.|;\n]{0,120})/i,
  );
  if (labeled?.[1]) return labeled[1].trim();
  const sentence = normalized.match(
    /\b\d+(?:\.\d+)?\+?\s*(?:years?|yrs?)\s+(?:of\s+)?(?:professional\s+|work\s+)?experience\b[^.|;\n]{0,120}/i,
  );
  return sentence?.[0]?.trim() || "";
}

function compactResumeSection(section: string, maxChars: number): string {
  const normalized = section
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 16)).trim()}...`;
}

export function extractCandidateProfileContext(input: {
  resumeText: string;
  targetBudget: number;
  includeResumeProjects: boolean;
}): string {
  if (!input.resumeText.trim()) return "";
  const lines = splitResumeLines(input.resumeText);
  const stopAtMajorSection =
    /^(summary|profile|objective|professional summary|work experience|professional experience|experience|employment history|internships?|skills?|technical skills?|projects?|project experience|academic projects|professional projects|education|certifications?|achievements?|awards?|languages?|publications?|contact|personal details)$/i;
  const summary = extractSectionByHeading(
    lines,
    /^(summary|profile|objective|professional summary)$/i,
    /^(work experience|professional experience|experience|employment history|internships?|skills?|technical skills?|projects?|project experience|academic projects|professional projects|education|certifications?|achievements?|awards?|languages?|publications?|contact|personal details)$/i,
  );
  const workExperience = extractSectionByHeading(
    lines,
    /^(work experience|professional experience|experience|employment history|internships?)$/i,
    /^(skills?|technical skills?|projects?|project experience|academic projects|professional projects|education|certifications?|achievements?|awards?|languages?|publications?|contact|personal details)$/i,
  );
  const skills = extractSectionByHeading(
    lines,
    /^(skills?|technical skills?)$/i,
    /^(work experience|professional experience|experience|employment history|internships?|projects?|project experience|academic projects|professional projects|education|certifications?|achievements?|awards?|languages?|publications?|contact|personal details)$/i,
  );
  const education = extractSectionByHeading(
    lines,
    /^(education)$/i,
    /^(work experience|professional experience|experience|employment history|internships?|skills?|technical skills?|projects?|project experience|academic projects|professional projects|certifications?|achievements?|awards?|languages?|publications?|contact|personal details)$/i,
  );
  const certifications = extractSectionByHeading(
    lines,
    /^(certifications?)$/i,
    /^(work experience|professional experience|experience|employment history|internships?|skills?|technical skills?|projects?|project experience|academic projects|professional projects|education|achievements?|awards?|languages?|publications?|contact|personal details)$/i,
  );
  const resumeProjects = input.includeResumeProjects
    ? extractSectionByHeading(
        lines,
        /^(projects?|project experience|academic projects|professional projects)$/i,
        /^(work experience|professional experience|experience|employment history|internships?|skills?|technical skills?|education|certifications?|achievements?|awards?|languages?|publications?|contact|personal details)$/i,
      )
    : "";
  const name = extractFirstResumeLine(lines, /^name\s*:\s*(.+)$/i);
  const role = extractFirstResumeLine(lines, /^(?:role|title|current role)\s*:\s*(.+)$/i);
  const totalExperience = extractExplicitTotalExperience(input.resumeText);
  const headerLines = lines
    .slice(0, 12)
    .filter((line) => !isResumeSectionHeading(line, stopAtMajorSection))
    .filter((line) => !/^(email|phone|location|links?)\s*:/i.test(line))
    .slice(0, 4)
    .join("\n");

  const sections = [
    "VERIFIED_CANDIDATE_PROFILE",
    name ? `Name: ${name}` : "",
    role ? `Current/Recent Role: ${role}` : "",
    totalExperience ? `Total Experience: ${totalExperience}` : "",
    !name && !role && headerLines ? `Header/Profile lines:\n${compactResumeSection(headerLines, 280)}` : "",
    summary ? `Resume Summary:\n${compactResumeSection(summary, 520)}` : "",
    workExperience ? `Work History:\n${compactResumeSection(workExperience, 900)}` : "",
    skills ? `Skills:\n${compactResumeSection(skills, 520)}` : "",
    education ? `Education:\n${compactResumeSection(education, 420)}` : "",
    certifications ? `Certifications:\n${compactResumeSection(certifications, 320)}` : "",
    resumeProjects ? `Resume Project Summary:\n${compactResumeSection(resumeProjects, 700)}` : "",
  ].filter(Boolean);

  const profile = sections.join("\n\n");
  return trimResume(profile, input.targetBudget);
}

function buildScoredResumeBlocks(resumeText: string, query: string): string[] {
  const queryWords = (query || "")
    .toLowerCase()
    .match(/\w+/g) || [];
  const keywords = queryWords.filter((word) => word.length > 2 && !STOP_WORDS.has(word));
  const rawBlocks = resumeText
    .split(/\n\s*\n+/)
    .map((block) => block.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const blocks = rawBlocks.length >= 3
    ? rawBlocks
    : splitResumeLines(resumeText)
        .reduce<string[]>((acc, line, index) => {
          const blockIndex = Math.floor(index / 4);
          acc[blockIndex] = [acc[blockIndex], line].filter(Boolean).join("\n");
          return acc;
        }, []);

  const scored = blocks.map((block, index) => {
    const lower = block.toLowerCase();
    let score = 0;
    if (/\b(projects?|work experience|professional experience|experience|employment)\b/.test(lower)) score += 8;
    if (/\b(databricks|azure|data lake|data warehouse|pipeline|migration|integration|automation|governance|retail|hilton|infy)\b/.test(lower)) score += 4;
    if (/\b(days?|months?|years?)\b/.test(lower)) score += 2;
    for (const keyword of keywords) {
      if (lower.includes(keyword)) score += 2;
    }
    return { block, index, score };
  });

  return scored
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, 8)
    .sort((a, b) => a.index - b.index)
    .map((entry) => entry.block);
}

export function extractResumeProjectContext(
  resumeText: string,
  query: string,
  targetBudget = 1600,
): string {
  if (!resumeText.trim()) return "";
  const lines = splitResumeLines(resumeText);
  const projectSection = extractSectionByHeading(
    lines,
    /^(projects?|project experience|academic projects|professional projects|work projects)$/i,
    /^(education|skills?|technical skills?|certifications?|summary|profile|objective|achievements?|awards?|languages?|contact|personal details)$/i,
  );
  const experienceSection = extractSectionByHeading(
    lines,
    /^(professional experience|work experience|experience|employment history|internships?)$/i,
    /^(education|skills?|technical skills?|certifications?|summary|profile|objective|projects?|achievements?|awards?|languages?|contact|personal details)$/i,
  );
  const selectedSections = [projectSection, experienceSection]
    .filter((section) => section.length >= 80);
  const scoredBlocks = selectedSections.length > 0
    ? selectedSections
    : buildScoredResumeBlocks(resumeText, query);
  const body = scoredBlocks.join("\n\n").trim();
  if (!body) return "";
  return trimResume(
    `RESUME-BACKED PROJECT/WORK CONTEXT (selected resume only; do not invent beyond this):\n${body}`,
    targetBudget,
  );
}

/**
 * Scores projects by matching query keywords and serializes them in a dense layout.
 */
export function extractRelevantProjectContext(
  projectRecords: any[],
  query: string,
  targetBudget = 700,
  options?: {
    primaryProjectId?: string | null;
    selectedProjectIds?: string[];
  },
): string {
  if (!projectRecords || projectRecords.length === 0) return "";
  const selectedProjectIds = Array.isArray(options?.selectedProjectIds)
    ? options!.selectedProjectIds!
    : [];
  const fallbackPrimary = selectedProjectIds[0] || null;
  const primaryProjectId = options?.primaryProjectId || fallbackPrimary;

  // Extract query keywords
  const queryWords = (query || "")
    .toLowerCase()
    .match(/\w+/g) || [];
  const keywords = queryWords.filter(w => w.length > 2 && !STOP_WORDS.has(w));

  interface ScoredProject {
    project: any;
    score: number;
  }

  const queryLower = (query || "").toLowerCase();
  const hasExplicitProjectNameMention = projectRecords.some((pr) => {
    const items = Array.isArray(pr.projects) ? (pr.projects as any[]) : [];
    return items.some((p: any) => {
      const title = String(p?.projectHeader?.title || "").toLowerCase().trim();
      return title.length >= 5 && queryLower.includes(title);
    });
  });

  // Score each project
  const scoredProjects: ScoredProject[] = [];
  for (const pr of projectRecords) {
    const items = Array.isArray(pr.projects) ? (pr.projects as any[]) : [];
    for (const p of items) {
      let score = 0;
      const header = p.projectHeader || {};
      const title = (header.title || "").toLowerCase();
      const tagline = (header.tagline || "").toLowerCase();
      const domain = (header.domain || "").toLowerCase();
      const techTags = Array.isArray(p.sections)
        ? p.sections.find((s: any) => s.type === "tech_tags")?.content || []
        : [];
      
      const techText = JSON.stringify(techTags).toLowerCase();
      const bodyText = JSON.stringify(p.sections || []).toLowerCase();

      for (const word of keywords) {
        if (title.includes(word)) score += 10; // High weight for title match
        if (domain.includes(word)) score += 5;
        if (tagline.includes(word)) score += 3;
        if (techText.includes(word)) score += 2;
        if (bodyText.includes(word)) score += 1;
      }
      const bonus =
        !hasExplicitProjectNameMention &&
        primaryProjectId &&
        String(pr?.id) === primaryProjectId
          ? 0.5
          : 0;
      scoredProjects.push({ project: { ...p, __selectedProjectId: pr?.id }, score: score + bonus });
    }
  }

  // For broad "tell me about your projects" asks, keep original order so all
  // selected projects are represented instead of over-favoring one match.
  const overviewMode = isProjectOverviewQuestion(query);
  if (overviewMode) {
    const order = new Map<string, number>();
    if (primaryProjectId) order.set(primaryProjectId, 0);
    let i = primaryProjectId ? 1 : 0;
    for (const id of selectedProjectIds) {
      if (id === primaryProjectId) continue;
      if (!order.has(id)) order.set(id, i++);
    }
    scoredProjects.sort((a, b) => {
      const aId = String((a.project as any)?.__selectedProjectId ?? "");
      const bId = String((b.project as any)?.__selectedProjectId ?? "");
      const ai = order.get(aId) ?? Number.MAX_SAFE_INTEGER;
      const bi = order.get(bId) ?? Number.MAX_SAFE_INTEGER;
      return ai - bi;
    });
  } else {
    // Sort by score desc, fallback to original order
    scoredProjects.sort((a, b) => b.score - a.score);
    if (primaryProjectId && !hasExplicitProjectNameMention) {
      scoredProjects.sort((a, b) => {
        const ap = String((a.project as any)?.__selectedProjectId ?? "") === primaryProjectId ? -1 : 0;
        const bp = String((b.project as any)?.__selectedProjectId ?? "") === primaryProjectId ? -1 : 0;
        return ap - bp;
      });
    }
  }

  // Serialize up to token budget
  const serializedList: string[] = [];
  let currentTokens = 0;

  for (const item of scoredProjects) {
    const p = item.project;
    const header = p.projectHeader || {};
    
    // Build compressed layout
    const lines: string[] = [];
    const selectedId = String((p as any)?.__selectedProjectId ?? "");
    const label =
      primaryProjectId && selectedId === primaryProjectId
        ? "PRIMARY PROJECT"
        : "OPTIONAL PROJECT";
    lines.push(`━━━ ${label}: ${header.title || "Untitled"} ━━━`);
    if (header.role) lines.push(`Role: ${header.role}`);
    if (header.domain) lines.push(`Domain: ${header.domain}`);
    
    const techTagsSec = Array.isArray(p.sections)
      ? p.sections.find((s: any) => s.type === "tech_tags")
      : null;
    if (techTagsSec && Array.isArray(techTagsSec.content)) {
      const tags = techTagsSec.content
        .map((cat: any) => `${cat.category}: ${(cat.tags || []).join(", ")}`)
        .join(" | ");
      if (tags) lines.push(`Tech: ${tags}`);
    }

    // Add sections but in a very dense format
    const sections: any[] = Array.isArray(p.sections) ? p.sections : [];
    const prioritizedArchitectureSection = sections.find((sec: any) =>
      sec?.key === "architecture_diagram" ||
      sec?.key === "architecture_tree" ||
      sec?.type === "code_block",
    );
    const orderedSections = prioritizedArchitectureSection
      ? [
          prioritizedArchitectureSection,
          ...sections.filter((sec) => sec !== prioritizedArchitectureSection),
        ]
      : sections;
    const maxBulletsPerSection = overviewMode ? 2 : 3;
    const maxNarrativeChars = overviewMode ? 130 : 200;
    let architectureIncluded = false;
    let flowIncluded = false;
    let challengeIncluded = false;
    for (const sec of orderedSections) {
      if (!sec?.type || !sec?.content || sec.type === "tech_tags") continue;
      
      const title = sec.title || sec.key || sec.type;
      
      if (sec.type === "bullets" && Array.isArray(sec.content)) {
        // Keep compact summaries in overview mode so more projects fit.
        const bullets = sec.content
          .slice(0, maxBulletsPerSection)
          .map((b: string) => ` • ${b}`);
        if (bullets.length > 0) {
          lines.push(`[${title}]:\n${bullets.join("\n")}`);
        }
      } else if (sec.type === "narrative" && typeof sec.content === "string") {
        lines.push(`[${title}]: ${sec.content.trim().substring(0, maxNarrativeChars)}...`);
      } else if (sec.type === "star_story") {
        const s = sec.content as any;
        const starParts = [
          s.situation ? `S: ${s.situation}` : "",
          s.task ? `T: ${s.task}` : "",
          s.action ? `A: ${s.action}` : "",
          s.result ? `R: ${s.result}` : ""
        ].filter(Boolean);
        if (starParts.length > 0) {
          lines.push(`[STAR]: ${starParts.join(" | ")}`);
        }
      } else if (sec.type === "metrics" && Array.isArray(sec.content)) {
        const metrics = sec.content.slice(0, 3).map((m: any) => ` • ${m.metric}: ${m.value}`);
        if (metrics.length > 0) {
          lines.push(`[Metrics]:\n${metrics.join("\n")}`);
        }
      } else if (!architectureIncluded && (sec.key === "architecture_diagram" || sec.key === "architecture_tree" || sec.type === "code_block")) {
        if (typeof sec.content === "string" && sec.content.trim()) {
          const raw = sec.content.trim();
          // Preserve diagram shape for project-explanation asks so the model can
          // reuse the same flow in markdown answers.
          if (sec.key === "architecture_diagram" || /diagram|architecture/i.test(String(sec.title || ""))) {
            const diagramLines = raw
              .split(/\r?\n/)
              .map((line: string) => line.replace(/\t/g, "  ").replace(/\s+$/g, ""))
              .filter((line: string) => line.length > 0)
              .slice(0, 18);
            if (diagramLines.length > 0) {
              lines.push("[Architecture Diagram]:");
              lines.push("```text");
              lines.push(...diagramLines);
              lines.push("```");
              architectureIncluded = true;
            }
          }
          if (!architectureIncluded) {
            lines.push(`[Architecture]: ${raw.replace(/\s+/g, " ").slice(0, 220)}...`);
            architectureIncluded = true;
          }
        } else if (sec.key === "architecture_tree" && sec.content?.layers && Array.isArray(sec.content.layers)) {
          const layerNames = sec.content.layers
            .map((l: any) => l?.name)
            .filter(Boolean)
            .slice(0, 4)
            .join(" -> ");
          if (layerNames) {
            lines.push(`[Architecture]: ${layerNames}`);
            architectureIncluded = true;
          }
        }
      } else if (!flowIncluded && (sec.key === "data_flow" || sec.type === "steps")) {
        if (Array.isArray(sec.content) && sec.content.length > 0) {
          const stepSummary = sec.content
            .slice(0, 3)
            .map((s: any) => s?.step || s?.title || s?.description)
            .filter(Boolean)
            .join(" -> ");
          if (stepSummary) {
            lines.push(`[Flow]: ${stepSummary}`);
            flowIncluded = true;
          }
        }
      } else if (!challengeIncluded && (sec.key === "challenges_resolution" || sec.type === "challenge_cards")) {
        if (Array.isArray(sec.content) && sec.content.length > 0) {
          const first = sec.content[0] || {};
          const challenge = first.challenge || first.title || "";
          const solution = first.solution || first.body || "";
          const value = [challenge, solution].filter(Boolean).join(" => ");
          if (value) {
            lines.push(`[Challenge]: ${String(value).slice(0, 220)}`);
            challengeIncluded = true;
          }
        }
      }
    }

    const serializedProject = lines.join("\n");
    const projTokens = estimatePromptTokens(serializedProject);

    if (currentTokens + projTokens <= targetBudget) {
      serializedList.push(serializedProject);
      currentTokens += projTokens;
    } else if (serializedList.length === 0) {
      // If even one project exceeds budget, truncate it to fit
      const truncated = encoding.decode(encoding.encode(serializedProject).slice(0, targetBudget));
      serializedList.push(truncated + "\n... (truncated)");
      break;
    } else {
      break;
    }
  }

  return serializedList.join("\n\n════════════════════════════════════════\n\n");
}

/**
 * Splits document text into paragraphs, scores relevance, and returns top paragraphs under budget.
 */
export function extractRelevantDocumentContext(
  documentText: string,
  query: string,
  targetBudget = 350
): string {
  if (!documentText) return "";
  
  // Split by double newlines or single newlines with spacing
  const paragraphs = documentText
    .split(/\n\n+/)
    .map(p => p.trim())
    .filter(Boolean);

  if (paragraphs.length === 0) return "";

  // Extract query keywords
  const queryWords = (query || "")
    .toLowerCase()
    .match(/\w+/g) || [];
  const keywords = queryWords.filter(w => w.length > 2 && !STOP_WORDS.has(w));

  if (keywords.length === 0) {
    // If no query keywords, just return first few paragraphs within budget
    const selected: string[] = [];
    let currentTokens = 0;
    for (const p of paragraphs) {
      const pTokens = estimatePromptTokens(p);
      if (currentTokens + pTokens <= targetBudget) {
        selected.push(p);
        currentTokens += pTokens;
      } else {
        break;
      }
    }
    return selected.join("\n\n");
  }

  // Score each paragraph
  const scored = paragraphs.map(p => {
    const pLower = p.toLowerCase();
    let score = 0;
    for (const word of keywords) {
      if (pLower.includes(word)) {
        score += 1;
      }
    }
    return { text: p, score };
  });

  // Sort by score desc
  scored.sort((a, b) => b.score - a.score);

  // Take top paragraphs that fit in budget
  const selected: string[] = [];
  let currentTokens = 0;
  for (const item of scored) {
    const tokens = estimatePromptTokens(item.text);
    if (currentTokens + tokens <= targetBudget) {
      selected.push(item.text);
      currentTokens += tokens;
    } else if (selected.length === 0) {
      // Partial paragraph fallback
      const truncated = encoding.decode(encoding.encode(item.text).slice(0, targetBudget));
      selected.push(truncated + "... (truncated)");
      break;
    } else {
      break;
    }
  }

  return selected.join("\n\n");
}

/**
 * Builds a sliding conversation transcript window.
 * Keeps a rolling 3-turn window of full Q&As, and compresses older turns.
 */
export function buildSlidingTranscriptMemory(
  messages: any[],
  targetBudget = 600
): string {
  if (!messages || messages.length === 0) return "";

  // Filter out messages that contain Q&As
  const qaMessages = messages.filter(
    m => m.role === "AI_ASSISTANT" && m.question && m.answer
  );

  if (qaMessages.length === 0) return "";

  // Split into recent (last 3) and history (older)
  const recentTurns = qaMessages.slice(-3);
  const olderTurns = qaMessages.slice(0, -3);

  const formattedRecent = recentTurns.map((m, idx) => {
    const orderIdx = olderTurns.length + idx + 1;
    const perTurnBudget = Math.max(120, Math.floor(targetBudget / Math.max(recentTurns.length, 1)));
    return trimTextToTokenBudget(
      `Turn ${orderIdx} (Interviewer asked):\n  Q: ${m.question.trim()}\n  A: ${m.answer.trim()}`,
      perTurnBudget,
    );
  });

  const formattedOlder = olderTurns.map((m, idx) => {
    // Compress older turns: strip markdown code blocks and long descriptions
    let cleanAnswer = m.answer.trim();
    
    // Remove markdown code blocks
    cleanAnswer = cleanAnswer.replace(/```[\s\S]*?```/g, "[Code snippet omitted]");
    
    // If answer is still very long, grab first 120 chars
    if (cleanAnswer.length > 120) {
      cleanAnswer = cleanAnswer.substring(0, 120) + "... (summarized)";
    }
    
    return `Turn ${idx + 1} (Interviewer asked):\n  Q: ${m.question.trim()}\n  A: ${cleanAnswer}`;
  });

  // Re-assemble and ensure it fits budget
  let historyText = formattedRecent.join("\n\n");
  let currentTokens = estimatePromptTokens(historyText);

  if (formattedOlder.length > 0) {
    const olderBlocks: string[] = [];
    for (let i = formattedOlder.length - 1; i >= 0; i--) {
      const block = formattedOlder[i];
      const blockTokens = estimatePromptTokens(block);
      if (currentTokens + blockTokens + 2 <= targetBudget) {
        olderBlocks.unshift(block);
        currentTokens += blockTokens + 2;
      } else {
        break;
      }
    }
    if (olderBlocks.length > 0) {
      historyText = olderBlocks.join("\n\n") + "\n\n" + historyText;
    }
  }

  return trimTextToTokenBudget(historyText, targetBudget);
}

/**
 * Main coordinator function for Context Intelligent Engine.
 * Uses Adaptive Context Complexity Routing to classify the query and
 * selectively assemble context — simple questions skip heavy DB fetches entirely.
 */
export async function buildOptimizedContext(
  sessionId: string,
  query?: string,
  targetBudget?: number,
  preloadedSession?: any,
  options?: {
    complexity?: QuestionComplexity;
    disableProjectPriority?: boolean;
    contextMode?: "live" | "offline";
  },
) {
  const contextMode = options?.contextMode || "offline";
  const session =
    preloadedSession ||
    (await prisma.session.findUnique({
      where: { id: sessionId },
      include: { company: true },
    }));

  if (!session) return null;

  // ── Step 1: Classify question complexity ──────────────────────────────────
  const complexity = options?.complexity || classifyComplexity(query);
  const baseBudgets = COMPLEXITY_BUDGETS[complexity];
  const hasSelectedProjects =
    Array.isArray(session.projectIds) &&
    (session.projectIds as string[]).length > 0;
  const selectedProjectIds = Array.isArray(session.projectIds)
    ? (session.projectIds as unknown[])
        .filter((v) => typeof v === "string")
        .map((v) => String(v).trim())
        .filter(Boolean)
    : [];
  const primaryProjectId =
    typeof (session as any).primaryProjectId === "string" &&
    (session as any).primaryProjectId.trim().length > 0
      ? (session as any).primaryProjectId.trim()
      : (selectedProjectIds[0] ?? null);
  const isProjectQuestion = isProjectExperienceQuestion(query);
  const isProjectDetailQuestion = isExplicitProjectDetailQuestion(query);
  const isMixedExperienceProject = isMixedExperienceProjectQuestion(query);
  const isProjectOverview = isProjectOverviewQuestion(query);
  const resumeProjectFallbackActive = shouldUseResumeBackedProjectFallback({
    hasSelectedProjects,
    isProjectQuestion,
    isProjectDetailQuestion,
    isProjectOverview,
    isMixedExperienceProject,
    hasResume: !!session.resumeId,
  });
  const projectPriorityActive =
    hasSelectedProjects &&
    isProjectDetailQuestion &&
    !options?.disableProjectPriority;
  const budgets = projectPriorityActive
    ? {
        ...baseBudgets,
        // For hybrid intro + project asks, keep a small resume budget as secondary context.
        resume: isMixedExperienceProject
          ? Math.max(260, Math.min(baseBudgets.resume || 320, 420))
          : 0,
        projects: isProjectOverview
          ? Math.max(
              baseBudgets.projects + baseBudgets.resume,
              2400,
            )
          : Math.min(
              baseBudgets.total,
              baseBudgets.projects + baseBudgets.resume,
            ),
        total: isProjectOverview
          ? Math.max(
              baseBudgets.total,
              baseBudgets.projects + baseBudgets.resume + 1400,
            )
          : baseBudgets.total,
      }
    : baseBudgets;
  const effectiveBudget = targetBudget ?? budgets.total;

  const queryPreview = query ? query.slice(0, 80) : "(no query)";
  const wordCount = query ? query.trim().split(/\s+/).length : 0;
  console.log(`[CIE] Complexity: ${complexity} | Query: "${queryPreview}" (${wordCount} words)`);

  // ── Step 2: Conditionally fetch only what the tier needs ──────────────────
  const includeResume =
    (shouldIncludeResume(complexity) ||
      resumeProjectFallbackActive ||
      (projectPriorityActive && isMixedExperienceProject)) &&
    (!projectPriorityActive || isMixedExperienceProject);
  const includeProjects =
    shouldIncludeProjects(complexity) &&
    (projectPriorityActive || isProjectDetailQuestion || resumeProjectFallbackActive);
  const includeDocuments = shouldIncludeDocuments(complexity);
  const includeHistory = shouldIncludeHistory(complexity);
  const includeVector = contextMode !== "live" && shouldIncludeVectorRAG(complexity);
  const sourceTimingsStartedAt = Date.now();

  // Parallel fetch — only the sources this tier requires
  const [resume, document, projectRecords] = await Promise.all([
    includeResume && session.resumeId
      ? getUnifiedResumeContext(session.resumeId)
      : Promise.resolve(null),
    includeDocuments && session.documentId
      ? prisma.document.findUnique({ where: { id: session.documentId } }).catch(() => null)
      : Promise.resolve(null),
    includeProjects && selectedProjectIds.length > 0
      ? prisma.project.findMany({ where: { id: { in: selectedProjectIds } } }).catch(() => [])
      : Promise.resolve([])
  ]);
  const sourceFetchMs = Date.now() - sourceTimingsStartedAt;
  const orderedProjectRecords = selectedProjectIds.length
    ? [...(projectRecords || [])].sort((a: any, b: any) => {
        const aId = String(a?.id ?? "");
        const bId = String(b?.id ?? "");
        const aIndex =
          aId === primaryProjectId
            ? -1
            : selectedProjectIds.indexOf(aId);
        const bIndex =
          bId === primaryProjectId
            ? -1
            : selectedProjectIds.indexOf(bId);
        return aIndex - bIndex;
      })
    : [];
  const selectedProjectResolutionContext = includeProjects
    ? buildSelectedProjectsUnavailableContext({
        selectedProjectIds,
        resolvedProjectIds: orderedProjectRecords
          .map((record: any) => String(record?.id ?? "").trim())
          .filter(Boolean),
      })
    : "";

  // Extract document text if fetched
  let documentRawText = "";
  if (document) {
    try {
      const ext = path.extname(document.path).toLowerCase();
      const text = await documentService.extractTextFromFile(document.path, ext);
      if (text) documentRawText = text;
    } catch (e) {
      console.warn("Failed to extract doc text inside CIE:", e);
    }
  }

  // ── Step 3: Apply per-source budgets from the complexity tier ─────────────
  const resumeRaw = resume?.resumeContext || "";
  const resumeBudget = resumeProjectFallbackActive
    ? Math.max(budgets.resume, isProjectOverview ? 1800 : 1200)
    : budgets.resume;
  const shouldUseCandidateProfileDigest =
    includeResume &&
    (complexity === "simple_contextual" ||
      isProjectQuestion ||
      isMixedExperienceProject ||
      isProjectOverview);
  const optimizedResume = includeResume
    ? shouldUseCandidateProfileDigest
      ? extractCandidateProfileContext({
          resumeText: resumeRaw,
          targetBudget: resumeBudget,
          includeResumeProjects: !hasSelectedProjects,
        }) || trimResume(resumeRaw, resumeBudget)
      : trimResume(resumeRaw, resumeBudget)
    : "";
  const resumeProjectContext = resumeProjectFallbackActive
    ? extractResumeProjectContext(
        resumeRaw,
        query || "",
        isProjectOverview ? 2200 : 1400,
      )
    : "";

  const optimizedProjects = includeProjects && orderedProjectRecords.length > 0
    ? extractRelevantProjectContext(orderedProjectRecords || [], query || "", budgets.projects, {
        primaryProjectId,
        selectedProjectIds,
      })
    : selectedProjectResolutionContext || resumeProjectContext;
  const effectiveIncludeProjects =
    includeProjects ||
    !!selectedProjectResolutionContext ||
    !!resumeProjectContext;

  const optimizedDoc = includeDocuments
    ? extractRelevantDocumentContext(documentRawText, query || "", budgets.document)
    : "";

  const historyStartedAt = Date.now();
  const messages = Array.isArray(session.messages) ? (session.messages as any[]) : [];
  const optimizedHistory = includeHistory
    ? buildSlidingTranscriptMemory(messages, budgets.history)
    : "";
  const historyMs = Date.now() - historyStartedAt;

  // Semantic Vector RAG — only for tiers that include it
  const vectorStartedAt = Date.now();
  let vectorContext = "";
  if (includeVector && query) {
    try {
      const { RagService } = require("../ask-ai/rag.service");
      const ragService = new RagService();
      const chunks = await ragService.retrieveContext(sessionId, session.userId, query);
      
      if (chunks && chunks.length > 0) {
        const formatted = chunks
          .map((c: any, idx: number) => `[Ref ${idx + 1}]: Q: ${c.question} | Content: ${c.content}`)
          .join("\n\n");
        const tokens = encoding.encode(formatted);
        if (tokens.length > budgets.vector) {
          vectorContext = encoding.decode(tokens.slice(0, budgets.vector)) + "\n... (truncated)";
        } else {
          vectorContext = formatted;
        }
      }
    } catch (e) {
      console.warn("Failed vector context in CIE:", e);
    }
  }
  const vectorMs = Date.now() - vectorStartedAt;

  // ── Step 4: Aggregate and enforce budget ──────────────────────────────────
  let resumeTokens = estimatePromptTokens(optimizedResume);
  let projectsTokens = estimatePromptTokens(optimizedProjects);
  let docTokens = estimatePromptTokens(optimizedDoc);
  let historyTokens = estimatePromptTokens(optimizedHistory);
  let vectorTokens = estimatePromptTokens(vectorContext);

  const totalCalculated = resumeTokens + projectsTokens + docTokens + historyTokens + vectorTokens;

  let finalResume = optimizedResume;
  let finalProjects = optimizedProjects;
  let finalDoc = optimizedDoc;
  let finalHistory = optimizedHistory;

  if (totalCalculated > effectiveBudget) {
    console.log(`[CIE] Budget ${effectiveBudget} exceeded (${totalCalculated}). Scaling down.`);
    const scaleFactor = effectiveBudget / totalCalculated;

    if (includeResume) {
      const scaledResumeBudget = Math.floor(resumeTokens * scaleFactor);
      finalResume = shouldUseCandidateProfileDigest
        ? extractCandidateProfileContext({
            resumeText: resumeRaw,
            targetBudget: scaledResumeBudget,
            includeResumeProjects: !hasSelectedProjects,
          }) || trimResume(resumeRaw, scaledResumeBudget)
        : trimResume(resumeRaw, scaledResumeBudget);
    }
    if (includeProjects && orderedProjectRecords.length > 0) {
      finalProjects = extractRelevantProjectContext(orderedProjectRecords || [], query || "", Math.floor(projectsTokens * scaleFactor), {
        primaryProjectId,
        selectedProjectIds,
      });
    } else if (selectedProjectResolutionContext) {
      finalProjects = trimResume(
        selectedProjectResolutionContext,
        Math.max(180, Math.floor(projectsTokens * scaleFactor)),
      );
    } else if (resumeProjectContext) {
      finalProjects = trimResume(resumeProjectContext, Math.max(700, Math.floor(projectsTokens * scaleFactor)));
    }
    if (includeDocuments) finalDoc = extractRelevantDocumentContext(documentRawText, query || "", Math.floor(docTokens * scaleFactor));
    if (includeHistory) finalHistory = buildSlidingTranscriptMemory(messages, Math.floor(historyTokens * scaleFactor));
  }

  let remainingBudget = effectiveBudget;
  finalResume = trimTextToTokenBudget(finalResume, remainingBudget);
  remainingBudget -= estimatePromptTokens(finalResume);
  finalProjects = trimTextToTokenBudget(finalProjects, remainingBudget);
  remainingBudget -= estimatePromptTokens(finalProjects);
  finalDoc = trimTextToTokenBudget(finalDoc, remainingBudget);
  remainingBudget -= estimatePromptTokens(finalDoc);
  finalHistory = trimTextToTokenBudget(finalHistory, remainingBudget);
  remainingBudget -= estimatePromptTokens(finalHistory);
  vectorContext = trimTextToTokenBudget(vectorContext, remainingBudget);

  // ── Step 5: Structured logging ────────────────────────────────────────────
  const included: string[] = [];
  const skipped: string[] = [];

  if (includeResume && finalResume) included.push(`resume(${estimatePromptTokens(finalResume)}t)`);
  else skipped.push("resume");
  if (effectiveIncludeProjects && finalProjects) included.push(`projects(${estimatePromptTokens(finalProjects)}t)`);
  else skipped.push("projects");
  if (includeDocuments && finalDoc) included.push(`documents(${estimatePromptTokens(finalDoc)}t)`);
  else skipped.push("documents");
  if (includeHistory && finalHistory) included.push(`history(${estimatePromptTokens(finalHistory)}t)`);
  else skipped.push("history");
  if (includeVector && vectorContext) included.push(`vector(${estimatePromptTokens(vectorContext)}t)`);
  else skipped.push("vector");

  const finalTotal = estimatePromptTokens(finalResume) + estimatePromptTokens(finalProjects) +
    estimatePromptTokens(finalDoc) + estimatePromptTokens(finalHistory) + estimatePromptTokens(vectorContext);

  console.log(`[CIE] Included: ${included.length > 0 ? included.join(", ") : "(none)"}`);
  console.log(`[CIE] Skipped: ${skipped.length > 0 ? skipped.join(", ") : "(none)"}`);
  console.log(`[CIE] Final context: ${finalTotal} tokens (budget: ${effectiveBudget})`);
  console.log("[CIE] Source timings", {
    contextMode,
    sourceFetchMs,
    historyMs,
    vectorMs,
  });

  return {
    company: session.company?.name || session.companyName || "Unknown",
    role: session.jobDescription || "Interviewee",
    language: session.language || "General",
    simpleLanguage: session.simpleLanguage,
    instructions: session.extraContext || "None",
    resume: finalResume || "No resume provided.",
    document: finalDoc || "None provided.",
    projects: finalProjects || "No projects provided.",
    history: finalHistory || "No previous interactions in this session.",
    vectorContext: vectorContext || null,
    complexity,
    hasSelectedProjects,
    projectPriorityMode: "project_questions_only",
    isProjectQuestion: isProjectDetailQuestion,
  };
}

/**
 * Extracts the exact surroundings from the session transcript based on the query.
 * Looks back 10-20 seconds and captures before/active/after chunks.
 */
export async function captureTranscriptWindow(
  sessionId: string,
  query: string
) {
  const session = await prisma.session.findUnique({
    where: { id: sessionId },
  });
  if (!session) return null;

  const transcript = Array.isArray(session.transcript)
    ? (session.transcript as any[])
    : [];

  // Find index of the entry matching or containing the query
  const qLower = query.toLowerCase().trim();
  let activeIndex = -1;

  for (let i = transcript.length - 1; i >= 0; i--) {
    const content = (transcript[i].content || "").toLowerCase().trim();
    if (content.includes(qLower) || qLower.includes(content)) {
      activeIndex = i;
      break;
    }
  }

  // Fallback to fuzzy match or last entry if not found
  if (activeIndex === -1 && transcript.length > 0) {
    // Find closest length-based match or simply default to the last candidate/interviewer chunk
    activeIndex = transcript.length - 1;
  }

  if (activeIndex === -1) {
    return {
      before: [],
      active: query,
      after: [],
      startTime: Date.now(),
      endTime: Date.now(),
    };
  }

  const activeEntry = transcript[activeIndex];
  
  // Capture before window (approx. 5 entries or 15 seconds)
  const beforeEntries = transcript.slice(Math.max(0, activeIndex - 5), activeIndex);
  
  // Capture after window (approx. 5 entries or 15 seconds)
  const afterEntries = transcript.slice(activeIndex + 1, activeIndex + 6);

  const getMsTime = (entry: any) => {
    if (entry.createdAt) return new Date(entry.createdAt).getTime();
    return Date.now();
  };

  const startTime = beforeEntries.length > 0 
    ? getMsTime(beforeEntries[0]) 
    : getMsTime(activeEntry);

  const endTime = afterEntries.length > 0 
    ? getMsTime(afterEntries[afterEntries.length - 1]) 
    : getMsTime(activeEntry);

  return {
    before: beforeEntries.map(e => `${e.role || "SPEAKER"}: ${e.content || ""}`),
    active: `${activeEntry.role || "SPEAKER"}: ${activeEntry.content || ""}`,
    after: afterEntries.map(e => `${e.role || "SPEAKER"}: ${e.content || ""}`),
    startTime,
    endTime,
  };
}

/**
 * Creates and persists an AnswerGenerationSnapshot in the database.
 */
export async function createGenerationSnapshot(params: {
  id: string;
  sessionId: string;
  originalQuestionTranscript: string;
  generatedAnswer: string;
  modelUsed: string;
  context: any;
  segmenter?: {
    fromTranscriptChunkId?: string;
    toTranscriptChunkId?: string;
    detectedIntent: string;
    resolvedIntentIds: string[];
    questionForDisplay: string;
    sessionStateSummary: string;
    confidence: number;
    decisionMetadata: any;
  };
}) {
  const { id, sessionId, originalQuestionTranscript, generatedAnswer, modelUsed, context, segmenter } = params;

  // Retrieve transcript window
  const windowData = await captureTranscriptWindow(sessionId, originalQuestionTranscript);
  const before = windowData ? windowData.before : [];
  const active = windowData ? windowData.active : originalQuestionTranscript;
  const after = windowData ? windowData.after : [];
  const startTime = windowData ? windowData.startTime : Date.now();
  const endTime = windowData ? windowData.endTime : Date.now();

  // Create db record
  return await prisma.answerGenerationSnapshot.create({
    data: {
      id,
      sessionId,
      originalQuestionTranscript,
      transcriptWindowBefore: before,
      transcriptWindowActive: active,
      transcriptWindowAfter: after,
      timestampRangeStart: startTime,
      timestampRangeEnd: endTime,
      selectedResumeContext: context.resume,
      selectedProjectContext: [context.projects],
      selectedDocumentContext: [context.document],
      ragContext: context.vectorContext ? [context.vectorContext] : [],
      generatedAnswer,
      modelUsed,
      fromTranscriptChunkId: segmenter?.fromTranscriptChunkId,
      toTranscriptChunkId: segmenter?.toTranscriptChunkId,
      detectedIntent: segmenter?.detectedIntent,
      resolvedIntentIds: segmenter?.resolvedIntentIds || [],
      questionGenerated: segmenter?.questionForDisplay,
      sessionStateSummary: segmenter?.sessionStateSummary,
      confidence: segmenter?.confidence,
      decisionMetadata: segmenter?.decisionMetadata,
    },
  });
}
