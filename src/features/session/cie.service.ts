import { prisma } from "../../shared/lib/prisma";
import { getUnifiedResumeContext } from "../resume/resume.service";
import { getEncoding } from "js-tiktoken";
import * as documentService from "../document/document.service";
import path from "path";

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

/**
 * Scans a user query for follow-up and continuation keywords.
 */
export function detectFollowupIntent(query: string): boolean {
  if (!query) return false;
  const normalized = query.toLowerCase();
  const signals = [
    "explain more", "why", "how exactly", "elaborate", "give an example",
    "in that context", "you mentioned", "previous answer", "expand on",
    "tell me more", "clarify", "go deeper", "what about", "and what", "how so"
  ];
  const pronouns = [/\bit\b/, /\bthat\b/, /\bthis\b/, /\bthem\b/, /\bthey\b/];
  
  const hasSignal = signals.some(sig => normalized.includes(sig));
  const hasPronoun = pronouns.some(regex => regex.test(normalized));
  
  return hasSignal || hasPronoun;
}

// ── Adaptive Context Complexity Routing ─────────────────────────────────────

export type QuestionComplexity =
  | "simple_atomic"
  | "simple_contextual"
  | "followup"
  | "scenario_based"
  | "system_design";

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
  // Bare keywords that always need candidate context
  "project", "projects", "resume", "experience", "skills",
  "introduce", "background", "strength", "weakness",
  "qualification", "achievements", "portfolio",
];

const SCENARIO_TRIGGERS = [
  "suppose", "imagine", "if you had to", "in production", "build a system",
  "design a", "let's say", "consider a", "what would you do if",
  "how would you handle", "walk me through", "what if",
  "a user reports", "the system is", "your team has deployed",
  "race condition", "deadlock", "outage",
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

/**
 * Classifies a question's complexity tier using pure heuristics.
 * Zero AI calls — only pattern matching, word count, and keyword detection.
 */
export function classifyComplexity(query: string | undefined): QuestionComplexity {
  if (!query || !query.trim()) return "system_design"; // No query = full context (screenshot, etc.)

  const normalized = query.toLowerCase().trim();
  const wordCount = normalized.split(/\s+/).filter(Boolean).length;

  // 1. Follow-up detection (highest priority — short questions that reference prior context)
  if (detectFollowupIntent(query)) {
    return "followup";
  }

  // 2. System design / architecture deep dive
  const hasSystemDesignKeyword = SYSTEM_DESIGN_KEYWORDS.some(kw => normalized.includes(kw));
  if (hasSystemDesignKeyword || (wordCount > 50 && SCENARIO_TRIGGERS.some(t => normalized.includes(t)))) {
    return "system_design";
  }

  // 3. Scenario-based questions
  const hasScenarioTrigger = SCENARIO_TRIGGERS.some(t => normalized.includes(t));
  if (hasScenarioTrigger) {
    return "scenario_based";
  }

  // 4. Simple contextual (references personal experience/resume/projects)
  const hasPersonalContext = PERSONAL_CONTEXT_KEYWORDS.some(kw => normalized.includes(kw));
  if (hasPersonalContext) {
    return "simple_contextual";
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

/**
 * Scores projects by matching query keywords and serializes them in a dense layout.
 */
export function extractRelevantProjectContext(
  projectRecords: any[],
  query: string,
  targetBudget = 700
): string {
  if (!projectRecords || projectRecords.length === 0) return "";

  // Extract query keywords
  const queryWords = (query || "")
    .toLowerCase()
    .match(/\w+/g) || [];
  const keywords = queryWords.filter(w => w.length > 2 && !STOP_WORDS.has(w));

  interface ScoredProject {
    project: any;
    score: number;
  }

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
      scoredProjects.push({ project: p, score });
    }
  }

  // Sort by score desc, fallback to original order
  scoredProjects.sort((a, b) => b.score - a.score);

  // Serialize up to token budget
  const serializedList: string[] = [];
  let currentTokens = 0;

  for (const item of scoredProjects) {
    const p = item.project;
    const header = p.projectHeader || {};
    
    // Build compressed layout
    const lines: string[] = [];
    lines.push(`━━━ PROJECT: ${header.title || "Untitled"} ━━━`);
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
    for (const sec of sections) {
      if (!sec?.type || !sec?.content || sec.type === "tech_tags") continue;
      
      const title = sec.title || sec.key || sec.type;
      
      if (sec.type === "bullets" && Array.isArray(sec.content)) {
        // Only take the top 3 bullets to conserve space
        const bullets = sec.content.slice(0, 3).map((b: string) => ` • ${b}`);
        if (bullets.length > 0) {
          lines.push(`[${title}]:\n${bullets.join("\n")}`);
        }
      } else if (sec.type === "narrative" && typeof sec.content === "string") {
        lines.push(`[${title}]: ${sec.content.trim().substring(0, 200)}...`);
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
    return `Turn ${orderIdx} (Interviewer asked):\n  Q: ${m.question.trim()}\n  A: ${m.answer.trim()}`;
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

  return historyText;
}

/**
 * Main coordinator function for Context Intelligent Engine.
 * Uses Adaptive Context Complexity Routing to classify the query and
 * selectively assemble context — simple questions skip heavy DB fetches entirely.
 */
export async function buildOptimizedContext(
  sessionId: string,
  query?: string,
  targetBudget?: number
) {
  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    include: { company: true },
  });

  if (!session) return null;

  // ── Step 1: Classify question complexity ──────────────────────────────────
  const complexity = classifyComplexity(query);
  const budgets = COMPLEXITY_BUDGETS[complexity];
  const effectiveBudget = targetBudget ?? budgets.total;

  const queryPreview = query ? query.slice(0, 80) : "(no query)";
  const wordCount = query ? query.trim().split(/\s+/).length : 0;
  console.log(`[CIE] Complexity: ${complexity} | Query: "${queryPreview}" (${wordCount} words)`);

  // ── Step 2: Conditionally fetch only what the tier needs ──────────────────
  const includeResume = shouldIncludeResume(complexity);
  const includeProjects = shouldIncludeProjects(complexity);
  const includeDocuments = shouldIncludeDocuments(complexity);
  const includeHistory = shouldIncludeHistory(complexity);
  const includeVector = shouldIncludeVectorRAG(complexity);

  // Parallel fetch — only the sources this tier requires
  const [resume, document, projectRecords] = await Promise.all([
    includeResume && session.resumeId
      ? getUnifiedResumeContext(session.resumeId)
      : Promise.resolve(null),
    includeDocuments && session.documentId
      ? prisma.document.findUnique({ where: { id: session.documentId } }).catch(() => null)
      : Promise.resolve(null),
    includeProjects && session.projectIds && Array.isArray(session.projectIds) && (session.projectIds as string[]).length > 0
      ? prisma.project.findMany({ where: { id: { in: session.projectIds as string[] } } }).catch(() => [])
      : Promise.resolve([])
  ]);

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
  const optimizedResume = includeResume ? trimResume(resumeRaw, budgets.resume) : "";

  const optimizedProjects = includeProjects
    ? extractRelevantProjectContext(projectRecords || [], query || "", budgets.projects)
    : "";

  const optimizedDoc = includeDocuments
    ? extractRelevantDocumentContext(documentRawText, query || "", budgets.document)
    : "";

  const messages = Array.isArray(session.messages) ? (session.messages as any[]) : [];
  const optimizedHistory = includeHistory
    ? buildSlidingTranscriptMemory(messages, budgets.history)
    : "";

  // Semantic Vector RAG — only for tiers that include it
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

    if (includeResume) finalResume = trimResume(resumeRaw, Math.floor(resumeTokens * scaleFactor));
    if (includeProjects) finalProjects = extractRelevantProjectContext(projectRecords || [], query || "", Math.floor(projectsTokens * scaleFactor));
    if (includeDocuments) finalDoc = extractRelevantDocumentContext(documentRawText, query || "", Math.floor(docTokens * scaleFactor));
    if (includeHistory) finalHistory = buildSlidingTranscriptMemory(messages, Math.floor(historyTokens * scaleFactor));
  }

  // ── Step 5: Structured logging ────────────────────────────────────────────
  const included: string[] = [];
  const skipped: string[] = [];

  if (includeResume && finalResume) included.push(`resume(${estimatePromptTokens(finalResume)}t)`);
  else skipped.push("resume");
  if (includeProjects && finalProjects) included.push(`projects(${estimatePromptTokens(finalProjects)}t)`);
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
}) {
  const { id, sessionId, originalQuestionTranscript, generatedAnswer, modelUsed, context } = params;

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
    },
  });
}
