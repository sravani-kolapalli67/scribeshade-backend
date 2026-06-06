// SYSTEM PROMPT — shared across all interview AI calls.
// Runtime evidence is intentionally separated into buildRuntimeContextMessage().
function hasUsableProjectContext(val: string | null | undefined): boolean {
  const text = val?.trim();
  return !!text && !text.startsWith("No projects provided.");
}

function hasRealContent(val: string | null | undefined, placeholders: string[]): boolean {
  if (!val || !val.trim()) return false;
  const text = val.trim();
  return !placeholders.some((placeholder) => text === placeholder);
}

function serializeRuntimeValue(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (value === null || value === undefined) return "";

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

const CHARS_PER_TOKEN = 4;

export type AnswerRuntimeContext = {
  company?: string;
  role?: string;
  language?: string;
  simpleLanguage?: boolean;
  projectMode?: "selected_projects_present" | "resume_backed_projects_present" | "no_selected_projects";
  projectPriority?: string;
  resumeDigest?: string;
  candidateProfileTokenBudget?: number;
  projectDigest?: string;
  documentSummary?: string;
  memorySummary?: string;
  historySummary?: string;
  instructions?: string;
  isProjectQuestion?: boolean;
  projectDigestTokenBudget?: number;
};

export type AnswerPlan = {
  mode: "live_ai_answer" | "manual_query" | "regenerate" | "screen_analysis";
  questions: string[];
  intent: string;
  transcriptExcerpt: string;
  followupAnchor?: {
    topic: string;
    priorQuestion: string;
    priorAnswerSummary: string;
    codeSummary?: string;
  };
  projectDiagram?: string;
  requestDeltas: string[];
};

export type ActiveTaskV3 = {
  mode: "live_ai_answer" | "manual_query" | "regenerate_answer";
  transcriptEvidence?: string;
  recentTranscriptContext?: string;
  clickRawTranscript?: string;
  currentQuestionHint?: string;
  manualRequest?: string;
  originalQuestion?: string;
  previousAnswerSummary?: string;
  memoryAnchor?: {
    priorTopic?: string;
    priorAnswerSummary?: string;
    codeMemory?: string;
  };
  projectDiagram?: string;
  regenerateInstruction?: string;
  answerClickMode?: string;
  language: string;
  hasCodeFollowupAnchor: boolean;
  noCodeFollowupGuidance: boolean;
};

function buildRuntimeSection(title: string, value: unknown): string[] {
  const text = serializeRuntimeValue(value);
  if (!text.trim()) return [];

  return ["", title, text];
}

function normalizeSpaces(text: string): string {
  return (text || "").replace(/\s+/g, " ").trim();
}

function clipChars(text: string, maxChars: number): string {
  const normalized = normalizeSpaces(text);
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 16)).trim()}...`;
}

function clipTokens(text: string, tokenBudget: number): string {
  return clipChars(text, tokenBudget * CHARS_PER_TOKEN);
}

function clipMultilineTokens(text: string, tokenBudget: number): string {
  const maxChars = tokenBudget * CHARS_PER_TOKEN;
  const lines = (text || "")
    .split(/\r?\n/)
    .map((line) => normalizeSpaces(line))
    .filter(Boolean);
  const clippedLines: string[] = [];
  let usedChars = 0;

  for (const line of lines) {
    const remainingChars = maxChars - usedChars;
    if (remainingChars <= 0) break;
    const clippedLine = line.length > remainingChars
      ? `${line.slice(0, Math.max(0, remainingChars - 16)).trim()}...`
      : line;
    if (clippedLine) {
      clippedLines.push(clippedLine);
      usedChars += clippedLine.length + 1;
    }
  }

  return clippedLines.join("\n");
}

function omitCodeBlocks(text: string): string {
  return (text || "").replace(/```[\s\S]*?```/g, "[code omitted]");
}

function stripQuestionMeta(text: string): string {
  return (text || "").replace(/={3}QUESTION_META=[\s\S]*?={3}/g, "");
}

function stripRuntimeArtifacts(text: string): string {
  return stripQuestionMeta(omitCodeBlocks(text))
    .split(/\r?\n/)
    .filter((line) => {
      const normalized = normalizeSpaces(line).toUpperCase();
      if (!normalized) return false;
      if (normalized.startsWith("STRICT CONTEXT PACKET")) return false;
      if (normalized.startsWith("CURRENT QUESTION")) return false;
      if (normalized.startsWith("QUESTION EVIDENCE")) return false;
      if (normalized.startsWith("AUTHORITATIVE")) return false;
      if (normalized.startsWith("AI SEGMENTER DECISION")) return false;
      if (normalized.startsWith("BOUNDED RAW TRANSCRIPT")) return false;
      if (normalized.startsWith("RECENT SPEAKER TRANSCRIPT CONTEXT")) return false;
      return true;
    })
    .join(" ");
}

function summarizeEvidence(text: string, tokenBudget: number): string {
  return clipTokens(stripRuntimeArtifacts(text), tokenBudget);
}

function buildProjectContextSectionText(context: AnswerRuntimeContext): string {
  const projectText = summarizeEvidence(
    context.projectDigest || "",
    resolveTokenBudget({
      explicitBudget: context.projectDigestTokenBudget,
      fallbackBudget: context.isProjectQuestion ? 700 : 250,
    }),
  );
  if (!projectText.trim()) return "";
  const sourceLine =
    context.projectMode === "selected_projects_present"
      ? "Project source: selected AI projects only. Do not replace with resume-backed or generic project examples."
      : context.projectMode === "resume_backed_projects_present"
        ? "Project source: resume-backed project/work context."
        : "";
  return [sourceLine, projectText].filter(Boolean).join("\n");
}

function resolveTokenBudget(input: {
  explicitBudget?: number;
  fallbackBudget: number;
}): number {
  if (
    typeof input.explicitBudget === "number" &&
    Number.isFinite(input.explicitBudget) &&
    input.explicitBudget > 0
  ) {
    return Math.floor(input.explicitBudget);
  }
  return input.fallbackBudget;
}

function isUnavailableCandidateProfile(text: string): boolean {
  const normalized = normalizeSpaces(text).toLowerCase();
  return !normalized ||
    normalized === "no resume provided." ||
    normalized === "no resume provided" ||
    normalized === "no resume digest available." ||
    normalized === "minimal candidate context only.";
}

function buildCandidateProfileSectionText(context: AnswerRuntimeContext): string {
  if (!isUnavailableCandidateProfile(context.resumeDigest || "")) {
    return summarizeEvidence(
      context.resumeDigest || "",
      resolveTokenBudget({
        explicitBudget: context.candidateProfileTokenBudget,
        fallbackBudget: 250,
      }),
    );
  }
  return [
    "Candidate facts: Not provided.",
    "Known skills: Not provided.",
  ].join("\n");
}

function formatQuestionList(questions: string[]): string[] {
  const cleaned = questions.map((question) => normalizeSpaces(question)).filter(Boolean);
  if (cleaned.length <= 1) return [`Question: ${cleaned[0] || "No answerable question selected."}`];
  return ["Questions:", ...cleaned.map((question, index) => `${index + 1}. ${question}`)];
}

function legacyProjectMode(context: any): AnswerRuntimeContext["projectMode"] {
  const hasProjects = hasUsableProjectContext(context?.projects);
  if (!hasProjects) return "no_selected_projects";
  return context?.hasSelectedProjects ? "selected_projects_present" : "resume_backed_projects_present";
}

const MARKDOWN_ANSWER_CONTRACT_LINES = [
  "MANDATORY MARKDOWN ANSWER FORMAT:",
  "- Keep parser labels exact: output starts with **QUESTION:**, then **ANSWER:**. Keep ===NEXT_QUESTION=== between independent questions.",
  "- The answer body under **ANSWER:** must be Markdown with clear structure, not dense paragraphs.",
  "- Use exactly one blank line between major sections or label groups to keep spacing readable.",
  "- Use separate '- ' bullets whenever the answer has more than 2 short sentences, multiple ideas, steps, responsibilities, metrics, trade-offs, or tools.",
  "- Use proper Markdown list syntax only: one bullet per line. Never use inline bullets like '• a • b • c'.",
  "- For sub-points, use nested bullets with two-space indentation: '  - '.",
  "- Put one blank line between top-level project bullets or major answer groups. Do not add extra blank lines inside nested bullet groups.",
  "- Use short bold labels inside bullets, e.g. **Main Answer:**, **Direct answer:**, **Problem:**, **Fix:**, **Impact:**, **Example:**.",
  "- Bold short labels and high-signal keywords only: project names, business domains, exact metrics/numbers, role ownership, and major outcomes. Never bold full sentences or full paragraphs.",
  "- Use inline code for explicit tools, APIs, commands, file paths, database objects, and technical keywords, e.g. `Databricks`, `Azure Data Factory`, `PySpark`, `React`.",
  "- Highlight exact numbers and measurable values with bold, e.g. **438 days**, **1TB+**, **40%**, but never create numbers that are not in context.",
  "- Use fenced code blocks only when the question asks for code, syntax, query, implementation, debugging, or optimization.",
  "- Keep output parser-safe: do not emit raw HTML, color tags, CSS, tables, broken markdown markers, or dense paragraph blocks.",
  "- Markdown self-check before final output: labels are exact, blank lines are present, bullets are valid, nested bullets use two spaces, and no stray '**' markers remain.",
  "- Do not end with a clarification question or 'let me know'. Answer directly and stop.",
];

const MARKDOWN_ANSWER_CONTRACT = MARKDOWN_ANSWER_CONTRACT_LINES.join("\n");

function buildProjectBehaviorRules(context: any): string[] {
  const projectPriorityMode = context?.projectPriorityMode || "project_questions_only";

  return [
    `- Runtime context may indicate PROJECT_PRIORITY: ${projectPriorityMode}. Follow that priority only when the active question is about projects, work experience, role ownership, tools, impact, or architecture.`,
    "- If selected projects are present in runtime context and the active question is project/experience-related, treat selected projects as the exclusive project evidence. Do not substitute resume-backed projects, prior-answer projects, or generic examples.",
    "- Resume-backed projects are fallback evidence only when selected projects are absent.",
    "- If PROJECT_CONTEXT says selected project details are unavailable, do not invent project names or details; state that selected project details are not available in the provided context.",
    "- For project/experience questions, use exact project/work item names and explicit tools from runtime context. Do not invent company names, tools, exact metrics, certifications, or frameworks that are not present.",
    "- For broad project asks, cover relevant selected projects with PRIMARY first. For a specific named project, answer that project only.",
    "- For combined profile questions asking experience, skill set, and projects, answer in that order: Experience, Skill Set, Projects.",
    "- In the Experience section, include total years and work experience only when available in runtime context. If exact years are not available, describe the level of experience without inventing a number.",
    "- In the Skill Set section, group skills from runtime context by language, backend/frameworks, databases/cache, cloud/devops, and other relevant tools when those facts exist.",
    "- Project answers should cover Problem/Goal, My role, Tools/Process/Methods, Approach/Operating Model, Challenges + Decisions, and Impact/Metrics when those facts are available.",
  ];
}

function buildSharedBehaviorRules(context: any): string[] {
  return [
    "- Sound like a real candidate in a live interview, not an AI, resume parser, tutor, or corporate script.",
    "- Write answers as if the candidate is speaking directly to the interviewer. Use first person for experience, project, behavioral, approach, and decision questions.",
    "- Answer directly first, then add only the context needed. Short answer first; explanation second; technical depth only when useful.",
    "- Use natural spoken rhythm with varied sentence length. Avoid robotic phrasing, theory lectures, resume dumping, motivational speeches, buzzwords, and overly polished corporate language.",
    "- Do not explain like a tutor. Answer like the candidate is speaking about work they did: what problem existed, what I did, how it worked, and what improved.",
    "- Inject resume, project, document, company, job, or memory details only when they help answer the exact active question.",
    "- Candidate speech may contain the question they want help answering. Treat candidate-spoken question-like text as a valid AI-answer request.",
    "- Never ask clarifying questions. If input is fragmented, infer the most likely interview ask from the active input plus runtime context and answer it directly.",
    "- Never use placeholders like [Candidate Name], [Your Name], or <candidate>. If a name is unavailable, omit the name.",
    context?.simpleLanguage
      ? "- SIMPLE LANGUAGE MODE: use plain easy English, short sentences, and minimal jargon. If a technical term is necessary, add a short plain-English meaning."
      : "- SIMPLE LANGUAGE MODE is off: normal technical vocabulary is allowed, but stay concise and interview-spoken.",
  ];
}

/**
 * Builds behavior-only system rules. Runtime evidence belongs in buildRuntimeContextMessage().
 */
export function buildSystemMessage(context: any): string {
  return [
    "You are ScribeShade AI, a real-time interview copilot embedded inside a live interview tool.",
    "Your only job is to help the candidate answer interview questions the way a capable human candidate would answer in the moment.",
    "Generate realistic, context-aware, human-sounding interview answers using the active task and runtime context messages.",
    "",
    "CONTEXT PRIORITY",
    "1. Active Task",
    "2. Session Memory",
    "3. Runtime Context",
    "4. Transcript Evidence",
    "5. Resume Digest",
    "6. Selected Projects",
    "7. Supporting Documents",
    "8. General Knowledge",
    "",
    "HALLUCINATION GUARD",
    "- Never invent candidate-specific experience, company names, project names, tools, exact numbers, certifications, or metrics.",
    "- Use general knowledge only for concepts, implementation reasoning, or examples that are not claimed as the candidate's personal experience.",
    "- Preserve numeric precision from runtime context exactly.",
    "",
    "TRANSCRIPT CORRECTION",
    "- The interview transcript may contain speech-to-text recognition errors. Correct obvious intent silently before answering.",
    "- Common corrections: 'text stack' -> 'tech stack', 'my sequel' -> 'MySQL', 'post gres' -> 'Postgres', 'no sequel' -> 'NoSQL', 'rest full' -> 'RESTful', 'java script' -> 'JavaScript', 'type script' -> 'TypeScript', 'node js' -> 'Node.js', 'cube rnetes' -> 'Kubernetes', 'open ai' -> 'OpenAI', 'git hub' -> 'GitHub', 'a p i' -> 'API'.",
    "- Never answer a nonsensical STT artifact literally when context makes the intended word clear. Show the corrected clean text in **QUESTION:**.",
    "",
    "CANDIDATE VOICE AND ANSWER STYLE",
    ...buildSharedBehaviorRules(context),
    "",
    "FOLLOW-UP BEHAVIOR",
    "- Treat follow-ups as new active questions that build on previous answers. Do not restart introductions or repeat background already covered.",
    "- Resolve vague references like 'there', 'that', 'it', 'after that', 'why that choice', or 'you mentioned' from session memory and recent history.",
    "- If a follow-up references prior code/query/context and that context is supplied in the active task, prioritize it.",
    "",
    "PROJECT AND CONTEXT SOURCE PRIORITY",
    ...buildProjectBehaviorRules(context),
    "",
    "MULTI-QUESTION BEHAVIOR",
    "- If the active task contains multiple independent interview questions or unresolved interviewer asks, answer every requested active intent.",
    "- Separate independent Q&A blocks with exactly ===NEXT_QUESTION===.",
    "- Do not create extra cards for filler, candidate self-talk, random phrases, or already resolved asks.",
    "- For scenario/system-design prompts with shared setup and sub-parts, answer as one unified question block unless the active task explicitly says the intents are independent.",
    "",
    "LENGTH BUDGET",
    "- Simple definitions: 1-3 sentences or 0-3 bullets.",
    "- Conceptual or practical explanations: 3-5 concise bullets.",
    "- Behavioral answers: 4-6 short sentences or tight STAR-style bullets without naming STAR.",
    "- Project/experience answers: one lead line plus structured bullets, rich enough to speak in under 60 seconds.",
    "- Scenario/system-design answers: 2-4 short sections with practical diagnosis, action, trade-offs, and recommendation.",
    "- Multi-question mode: use the short end of the budget for every answer.",
    "",
    MARKDOWN_ANSWER_CONTRACT,
    "",
    "STRICT RESPONSE FORMAT",
    "**QUESTION:**",
    "<the interview question, cleaned up>",
    "",
    "**ANSWER:**",
    "<your answer>",
    "",
    "The first non-whitespace characters must be **QUESTION:**. Never write a preamble or closing summary.",
  ].join("\n");
}

export function buildAnswerRuntimeContext(context: AnswerRuntimeContext): string {
  const sections: string[] = [
    "RUNTIME_CONTEXT v3",
    "",
    "SESSION",
    `Company: ${context.company || "Unknown"}`,
    `Role: ${context.role || "Interviewee"}`,
    `Domain: ${context.language || "General"}`,
    `Simple Language: ${context.simpleLanguage ? "ON" : "OFF"}`,
  ].filter(Boolean);

  return [
    ...sections,
    ...buildRuntimeSection("CANDIDATE_PROFILE", buildCandidateProfileSectionText(context)),
    ...buildRuntimeSection("PROJECT_CONTEXT", buildProjectContextSectionText(context)),
    ...buildRuntimeSection(
      "MEMORY",
      summarizeEvidence([context.memorySummary, context.historySummary].filter(Boolean).join("\n"), 300),
    ),
    ...buildRuntimeSection("DOCUMENT_CONTEXT", summarizeEvidence(context.documentSummary || "", 180)),
    ...buildRuntimeSection("SPECIAL INSTRUCTIONS", summarizeEvidence(context.instructions || "", 80)),
  ].join("\n");
}

/**
 * Compatibility wrapper for legacy context objects. It intentionally compresses
 * runtime evidence and drops request-level artifacts.
 */
export function buildRuntimeContextMessage(context: any): string {
  return buildAnswerRuntimeContext({
    company: context?.company,
    role: context?.role,
    language: context?.language,
    simpleLanguage: !!context?.simpleLanguage,
    projectMode: legacyProjectMode(context),
    projectPriority: context?.projectPriorityMode || "project_questions_only",
    resumeDigest: hasRealContent(context?.resume, ["No resume provided.", ""]) ? context.resume : "",
    projectDigest: hasUsableProjectContext(context?.projects) ? context.projects : "",
    documentSummary: hasRealContent(context?.document, ["None provided.", ""]) ? context.document : "",
    historySummary: hasRealContent(context?.history, ["No previous interactions in this session.", ""]) ? context.history : "",
    memorySummary: context?.memorySummary || context?.sessionMemory || context?.sessionStateSummary || context?.conversationStateSummary || "",
    instructions: hasRealContent(context?.instructions, ["None.", "None", ""]) ? context.instructions : "",
    isProjectQuestion: !!context?.isProjectQuestion,
  });
}

/**
 * Lean behavior-only system prompt for screenshot analysis.
 * Runtime context should be provided as a separate buildRuntimeContextMessage() user message.
 */
export function buildScreenSystemMessage(context: any): string {
  return [
    "You are ScribeShade AI, a fast real-time interview copilot.",
    "Read the screenshot and answer the visible interview task as the candidate.",
    "",
    "RESPONSE CONTRACT",
    "- Always return a useful answer for an explicit Analyze Screen request. Never return a no-question sentinel and never stay silent.",
    "- The screenshot is the sole authority for the current question. Never reuse a previous transcript question or previous AI answer as the question.",
    "- Prefer the clearest visible interview question, coding problem, system-design prompt, or instruction.",
    "- If the wording is fragmented, reconstruct the best-supported complete question from visible screenshot content.",
    "- If no explicit question is visible, explain the most interview-relevant visible topic, error, code, diagram, or instruction.",
    "- Output only **QUESTION:** followed by **ANSWER:**. The first non-whitespace characters must be **QUESTION:**.",
    "- If multiple independent questions are visible, answer every one and separate blocks with exactly ===NEXT_QUESTION===.",
    "- Keep one scenario with related sub-questions in one block.",
    "- Answer directly in concise, natural first-person candidate voice when appropriate.",
    "- Use short Markdown bullets for multiple points and fenced code only when code is requested.",
    `- Simple language mode is ${context?.simpleLanguage ? "ON: use plain English and short sentences." : "OFF: normal technical vocabulary is allowed."}`,
    "- Use runtime resume/project facts only when relevant. Never invent candidate facts, tools, or metrics.",
    "- Do not ask for clarification, add meta-commentary, or end with an offer to help.",
  ].join("\n");
}

export function buildAnswerTaskMessage(plan: AnswerPlan): string {
  const lines: string[] = [
    "ACTIVE TASK",
    `Mode: ${plan.mode}`,
    `Intent: ${plan.intent || "infer_from_active_input"}`,
    ...formatQuestionList(plan.questions),
  ];

  if (plan.transcriptExcerpt.trim()) {
    lines.push(
      "",
      "Relevant transcript excerpt:",
      clipTokens(plan.transcriptExcerpt, 220),
    );
  }

  if (plan.followupAnchor) {
    lines.push(
      "",
      "Follow-up anchor:",
      `Prior topic: ${clipTokens(plan.followupAnchor.topic, 40) || "general"}`,
      `Prior question: ${clipTokens(plan.followupAnchor.priorQuestion, 60)}`,
      `Prior answer summary: ${clipTokens(plan.followupAnchor.priorAnswerSummary, 140)}`,
    );
    if (plan.followupAnchor.codeSummary) {
      lines.push(`Prior code summary: ${clipTokens(plan.followupAnchor.codeSummary, 140)}`);
    }
  }

  if (plan.projectDiagram) {
    lines.push(
      "",
      "Project diagram context:",
      "MUST include one fenced ```text``` architecture flow block inside **ANSWER:** using this structure.",
      "```text",
      clipTokens(plan.projectDiagram, 260),
      "```",
    );
  }

  lines.push(
    "",
    "Request deltas:",
    ...plan.requestDeltas.map((delta) => `- ${clipTokens(delta, 80)}`),
  );

  return lines.join("\n");
}

/**
 * Compatibility wrapper for older callers. New answer generation should build
 * an AnswerPlan and call buildAnswerTaskMessage().
 */
export function buildUserMessage(
  transcript: string,
  isCustomQuery: boolean,
  isRegenerate: boolean,
  context: any,
): string {
  const lang = context?.language || "the relevant language";
  return buildAnswerTaskMessage({
    mode: isRegenerate ? "regenerate" : isCustomQuery ? "manual_query" : "live_ai_answer",
    questions: [transcript],
    intent: context?.activeIntent || context?.detectedIntent || "infer_from_active_input",
    transcriptExcerpt: "",
    requestDeltas: [
      isRegenerate ? "Regenerate a fresh answer for the active input even if a similar question appears in runtime history." : "",
      isCustomQuery ? "The active input is the candidate's typed/manual request and is authoritative." : "",
      `If the active input explicitly asks for code, syntax, query, implementation, debugging, or optimization, provide a working implementation in ${lang}.`,
      "If it does not ask for code, do not add code just because the role is technical.",
    ].filter(Boolean),
  });
}

function buildMemoryAnchorLines(memoryAnchor: ActiveTaskV3["memoryAnchor"]): string[] {
  if (!memoryAnchor) {
    return [
      "Memory Anchor:",
      "- prior topic: none",
      "- prior answer summary: none",
      "- code memory: none",
    ];
  }

  return [
    "Memory Anchor:",
    `- prior topic: ${clipTokens(memoryAnchor.priorTopic || "none", 40) || "none"}`,
    `- prior answer summary: ${clipTokens(memoryAnchor.priorAnswerSummary || "none", 120) || "none"}`,
    `- code memory: ${clipTokens(memoryAnchor.codeMemory || "none", 120) || "none"}`,
  ];
}

function buildActiveTaskInstruction(input: ActiveTaskV3): string[] {
  const lines = [
    "Instruction:",
    input.mode === "manual_query"
      ? "Treat Manual Request as authoritative and answer directly."
      : input.mode === "regenerate_answer"
        ? "Generate a fresh improved answer for the original question."
        : "Infer the clean interview question(s) from Transcript Evidence. Then answer as the candidate.",
    "If multiple independent questions exist, separate with ===NEXT_QUESTION===.",
    "Output only **QUESTION:** / **ANSWER:** blocks.",
    "Do not use placeholders like [Candidate Name]. If a name is unavailable, omit the name.",
    `If the active input explicitly asks for code, syntax, query, implementation, debugging, or optimization, provide a working implementation in ${input.language}.`,
    "If it does not ask for code, do not add code just because the role is technical.",
  ];

  if (input.mode === "live_ai_answer") {
    lines.push(
      "The backend has validated this AI Answer click as answerable. Never output ===NO_NEW_QUESTION===.",
      "If the latest words are fragmented, reconstruct the best-supported complete question from Raw Click Transcript and Transcript Evidence, then answer it.",
      "Output exactly one Q&A block unless Transcript Evidence contains two or more explicit independent interview questions.",
      "Do not invent follow-up questions or generate additional questions to continue the interview.",
      "Treat compound asks like 'introduce yourself and explain your projects' as one Q&A block.",
      "Never create a new question such as 'Can you provide more details...' unless it appears in Transcript Evidence.",
      "Use ===NEXT_QUESTION=== only for explicit independent questions in Transcript Evidence.",
      "For scenario/problem-solving questions, use the full scenario setup before the final ask.",
      "Do not answer only the final sentence when it depends on earlier Transcript Evidence.",
      "For scenario prompts, extract and preserve domain, actors, constraints, numbers, failure symptom, and final ask.",
      "Treat one scenario with multiple details as one Q&A block unless there are independent explicit questions.",
      "Use Raw Click Transcript as the highest priority evidence for the current ask.",
      "Use Recent Transcript Context only to understand setup and continuity; do not let it override the latest explicit ask.",
    );
  }

  if (input.answerClickMode === "answer_followup") {
    lines.push(
      "This is a follow-up to the selected answer card. Answer exactly one Q&A block about that selected answer only.",
      "Do not use unrelated prior transcript/history/code, project architecture, system diagrams, or older topics unless they are present in the selected answer context.",
    );
  }

  if (input.hasCodeFollowupAnchor) {
    lines.push("Use the memory anchor for prior code continuity; do not substitute unrelated resume/project context.");
  }
  if (input.noCodeFollowupGuidance) {
    lines.push("No prior code/query is available; say that briefly, then give generic guidance.");
  }
  if (input.regenerateInstruction) {
    lines.push(`Regenerate instruction: ${clipTokens(input.regenerateInstruction, 100)}`);
  }
  if (input.projectDiagram) {
    lines.push("Include one fenced ```text``` architecture flow block inside **ANSWER:** using Project Diagram Context.");
  }

  return lines;
}

export function buildActiveTaskV3(input: ActiveTaskV3): string {
  const lines: string[] = [
    "ACTIVE_TASK v3",
    `Mode: ${input.mode}`,
  ];

  if (input.answerClickMode) {
    lines.push(`Answer Click Mode: ${clipTokens(input.answerClickMode, 20)}`);
  }

  if (input.mode === "manual_query") {
    lines.push(
      "",
      "Manual Request:",
      clipTokens(input.manualRequest || "", 300),
    );
  } else if (input.mode === "regenerate_answer") {
    lines.push(
      "",
      "Original Question:",
      clipTokens(input.originalQuestion || "", 220),
      "",
      "Previous Answer Summary:",
      clipTokens(input.previousAnswerSummary || "none", 180),
    );
  } else {
    lines.push(
      "",
      "Transcript Evidence:",
      clipMultilineTokens(input.transcriptEvidence || "", 300),
      ...(input.recentTranscriptContext?.trim()
        ? [
            "",
            "Recent Transcript Context (~1-2 min, memory only):",
            clipMultilineTokens(input.recentTranscriptContext, 220),
          ]
        : []),
      ...(input.clickRawTranscript?.trim()
        ? [
            "",
            "Raw Click Transcript (~15 sec, highest priority evidence):",
            clipMultilineTokens(input.clickRawTranscript, 140),
          ]
        : []),
      "",
      "Current Question Hint:",
      input.currentQuestionHint?.trim()
        ? `- ${clipTokens(input.currentQuestionHint.trim(), 80)}`
        : "- none",
    );
  }

  lines.push("", ...buildMemoryAnchorLines(input.memoryAnchor));

  if (input.projectDiagram) {
    lines.push(
      "",
      "Project Diagram Context:",
      "```text",
      clipTokens(input.projectDiagram, 260),
      "```",
    );
  }

  lines.push("", ...buildActiveTaskInstruction(input));

  return lines.join("\n");
}

/**
 * Builds the active task message for screenshot-based AI answer generation.
 * Runtime context and markdown contract belong to separate messages.
 */
export function buildDirectInferAndAnswerTask(input: {
  transcriptEvidence: string;
  currentQuestionHint?: string;
  activeQuestionDetection?: unknown;
  selectedIntentId?: string;
  answerClickMode?: string;
}): string {
  return buildActiveTaskV3({
    mode: "live_ai_answer",
    transcriptEvidence: input.transcriptEvidence,
    currentQuestionHint: input.currentQuestionHint,
    answerClickMode: input.answerClickMode,
    language: "the relevant language",
    hasCodeFollowupAnchor: false,
    noCodeFollowupGuidance: false,
  });
}

export function buildScreenAnalysisMessage(context: any): string {
  return [
    "SCREEN ACTIVE TASK",
    `Simple Language Mode: ${context?.simpleLanguage ? "ON" : "OFF"}`,
    "Identify and answer the active interview task visible in the screenshot.",
    "Ignore questions from earlier conversation turns; copy or faithfully reconstruct the question currently visible on screen.",
    "Use nearby visible content as setup when the final question depends on it.",
    "When wording is incomplete, reconstruct the best-supported ask instead of refusing.",
    "- Answer order must match the on-screen order: top to bottom, left to right.",
    "- Use ===NEXT_QUESTION=== only between truly independent questions.",
  ].join("\n");
}
