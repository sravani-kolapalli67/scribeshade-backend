import { OpenRouter } from "@openrouter/sdk";
import path from "path";
import { Prisma } from "@prisma/client";
import { jsonrepair } from "jsonrepair";
import { prisma } from "../../shared/lib/prisma";
import { AppError } from "../../shared/middleware/error.middleware";
import * as resumeService from "../resume/resume.service";
import {
  GenerateProjectRequest,
  AIProjectGenerationResponse,
} from "./projects.types";

// ── Credit costs (resolved from DB at call-time; falls back to these defaults) ─
const DEFAULT_COST_GENERATE       = new Prisma.Decimal(4);
const DEFAULT_COST_EDIT_COMPONENT = new Prisma.Decimal(1);

/**
 * Fetches the credit cost for a feature from the FeatureCost table.
 * Returns the hardcoded default if the row doesn't exist or is inactive.
 */
async function getFeatureCost(
  featureKey: string,
  fallback: Prisma.Decimal,
): Promise<Prisma.Decimal> {
  try {
    const row = await prisma.featureCost.findUnique({ where: { featureKey } });
    if (row?.isActive) return row.credits;
  } catch {
    // DB unavailable — fall through to default
  }
  return fallback;
}

/**
 * Atomically deducts credits from a user's balance and records a ledger entry.
 * Throws AppError(402) if balance is insufficient.
 */
async function deductCredits(
  userId: string,
  amount: Prisma.Decimal,
  operation: string,
): Promise<{ creditsRemaining: number }> {
  let creditsRemaining = 0;

  await prisma.$transaction(async (tx) => {
    const balance = await tx.userCreditBalance.findUnique({ where: { userId } });

    if (!balance) {
      throw new AppError(402, `Insufficient credits. Required: ${amount}, Available: 0`);
    }

    const available = new Prisma.Decimal(balance.totalAvailable.toString());
    if (available.lt(amount)) {
      throw new AppError(
        402,
        `Insufficient credits. Required: ${amount}, Available: ${available}`,
      );
    }

    const after = available.minus(amount);

    await tx.userCreditBalance.update({
      where: { userId },
      data: { totalAvailable: after },
    });

    await tx.creditLedger.create({
      data: {
        userId,
        type:          "DEBIT",
        amount,
        balanceBefore: available,
        balanceAfter:  after,
        reason:        operation,
      },
    });

    creditsRemaining = after.toNumber();
  });

  return { creditsRemaining };
}

// Projects generation always uses Gemini 2.5 Flash — it is significantly
// faster and more instruction-following than the global OPENROUTER_MODEL
// Default: Claude Haiku 4.5 — fast, cost-efficient, 200K context.
// Override with PROJECTS_AI_MODEL env var if needed.
const PROJECTS_MODEL =
  process.env.PROJECTS_AI_MODEL || "openai/gpt-4.1";
const PROJECTS_PER_REQUEST = Math.max(
  1,
  Number.parseInt(process.env.PROJECTS_PER_REQUEST ?? "1", 10) || 1,
);

export function getProjectsPerRequest(): number {
  return PROJECTS_PER_REQUEST;
}

if (!process.env.OPENROUTER_API_KEY) {
  throw new Error("OPENROUTER_API_KEY environment variable is not defined");
}

const ai = new OpenRouter({
  apiKey: process.env.OPENROUTER_API_KEY,
});

/**
 * Parses a JSON response string from AI.
 * Attempts strict parse → jsonrepair → regex extraction with repair.
 * Handles truncated output caused by model token limits.
 */
export function parseJsonResponse<T>(text: string): T | null {
  const candidates = [
    text.trim(),
    text.trim().replace(/^```json?\n?/i, "").replace(/\n?```$/i, "").trim(),
  ];

  for (const candidate of candidates) {
    // 1. Strict parse — ideal case
    try { return JSON.parse(candidate) as T; } catch { /* fall through */ }

    // 2. jsonrepair — handles truncated JSON, unquoted keys, trailing commas, etc.
    try { return JSON.parse(jsonrepair(candidate)) as T; } catch { /* fall through */ }

    // 3. Extract the outermost {...} block first, then try repair on that
    const brace = candidate.indexOf("{");
    const lastBrace = candidate.lastIndexOf("}");
    if (brace !== -1) {
      // If there IS a closing brace, try that slice first
      if (lastBrace > brace) {
        const slice = candidate.slice(brace, lastBrace + 1);
        try { return JSON.parse(jsonrepair(slice)) as T; } catch { /* fall through */ }
      }
      // If no closing brace (hard truncation), repair the open fragment
      const fragment = candidate.slice(brace);
      try { return JSON.parse(jsonrepair(fragment)) as T; } catch { /* fall through */ }
    }
  }

  return null;
}

/**
 * Generates AI projects and streams the response.
 */
export async function* streamAIProjects(params: GenerateProjectRequest) {
  const {
    resumeId,
    resumeText: providedResumeText,
    position,
    jobDescription,
    industry,
    experienceLevel,
    generationMode = "new",
  } = params;

  let resumeContext = providedResumeText || "";

  if (resumeId) {
    const resume = await resumeService.getUnifiedResumeContext(resumeId);
    if (resume) {
      // Prefer structured parsedData for skill extraction (higher fidelity)
      if (resume.parsedData) {
        const parsed = resume.parsedData as any;
        const skills: string[] = [];

        // Extract skills from common parsedData shapes
        if (Array.isArray(parsed.skills)) {
          parsed.skills.forEach((s: any) => {
            if (typeof s === "string") skills.push(s);
            else if (s?.name) skills.push(s.name);
          });
        }
        // Also pull from technicalSkills, tools, technologies subkeys
        for (const key of ["technicalSkills", "tools", "technologies", "frameworks", "languages"]) {
          if (Array.isArray(parsed[key])) {
            parsed[key].forEach((s: any) =>
              skills.push(typeof s === "string" ? s : s?.name ?? ""),
            );
          }
        }

        const uniqueSkills = [...new Set(skills.filter(Boolean))];
        if (uniqueSkills.length >= 2) {
          resumeContext = `EXTRACTED SKILLS LIST:\n${uniqueSkills.join(", ")}\n\nProjects MUST stay within this skill boundary. Do not use technologies not listed above.`;
        } else {
          // Fewer than 2 structured skills — fall back to full text
          resumeContext = resume.resumeContext || "";
        }
      } else {
        resumeContext = resume.resumeContext || "";
      }
    }
  }

  // If resume yielded very few skills, fall through — generate from position + JD instead of blocking

  // ── Build the prompt based on generationMode ───────────────────────────
  const SECTION_TYPE_REFERENCE = `
## SECTION TYPE REFERENCE

type "bullets"               → content: string[]  (4–6 achievement bullets with %, $, ms metrics)
type "narrative"             → content: string    (2–3 paragraphs of professional prose)
type "how_to_explain"        → content: { "elevatorPitch": string, "detailedExplanation": string }
type "star_story"            → content: { "situation": string, "task": string, "action": string, "result": string }
type "thirty_second_summary" → content: { "hook": string, "mainPoints": string[], "closingLine": string }
type "architecture_tree"     → content: { "layers": [ { "name": string, "nodes": [ { "name": string, "description": string, "tech": string, "children"?: [ { "name": string, "description": string } ] } ] } ] }
type "metadata"              → content: { "fields": [ { "label": string, "value": string } ] }
type "code_block"            → content: string  (ASCII diagram, architecture flow, or pipeline diagram)
type "tech_tags"             → content: [ { "category": string, "tags": string[] } ]
type "key_value_pairs"       → content: [ { "key": string, "value": string } ]
type "steps"                 → content: [ { "step": string, "description": string } ]
type "challenge_cards"       → content: [ { "challenge": string, "solution": string } ]
type "cards"                 → content: [ { "title": string, "body": string, "badge"?: string } ]
type "table"                 → content: { "headers": string[], "rows": string[][] }
type "timeline"              → content: [ { "date": string, "event": string, "description": string } ]
type "metrics"               → content: [ { "metric": string, "value": string, "description": string, "before"?: string, "after"?: string } ]
type "quote_cards"           → content: string[]  (3–4 first-person learning reflections)
type "comparison_table"      → content: [ { "decision": string, "winner": string, "loser": string, "rationale": string } ]
type "code_snippets"         → content: [ { "title": string, "language": string, "purpose": string, "code": string } ]

For "architecture_tree": layers must be exactly: "Frontend", "Backend", "Database", "Infrastructure" (skip any that are not applicable). Each layer has 2–4 nodes. Nodes may have up to 3 children showing sub-components.`.trim();

  const MASTER_SECTION_LIST = `
## MASTER SECTION LIST (generate ALL applicable sections, in this exact order)

 1. key="resume_ready_bullets"     type="bullets"               title="Resume-Ready Bullets"           subtitle="Drop directly onto your resume"
 2. key="introduction"             type="narrative"             title="Introduction"                   subtitle="Full project narrative"
 3. key="how_to_explain"           type="how_to_explain"        title="How to Explain This Project"    subtitle="Conversational walkthrough for interviews"
 4. key="project_header"           type="metadata"              title="Project Header"                 subtitle="Key project metadata"
 5. key="star_story"               type="star_story"            title="STAR Story"                     subtitle="Structured interview storytelling — Situation, Task, Action, Result"
 6. key="thirty_second_summary"    type="thirty_second_summary" title="30-Second Summary"              subtitle="Memory hook — elevator pitch you can deliver in 30 seconds"
 7. key="business_purpose"         type="narrative"             title="Business Purpose"               subtitle="Why this project existed and the business problem it solved"
 8. key="architecture_diagram"     type="code_block"            title="Architecture Diagram"           subtitle="System or solution architecture as ASCII diagram"
 9. key="architecture_tree"        type="architecture_tree"     title="Architecture Tree"              subtitle="Layered system view — Frontend → Backend → Database → Infrastructure"
10. key="data_flow"                type="steps"                 title="Data Flow Diagram"              subtitle="How data moves through the system step by step"
11. key="code_snippets"            type="code_snippets"         title="Key Code Snippets"              subtitle="Critical or complex implementation code"
12. key="cluster_nodes"            type="cards"                 title="Cluster & Node Details"         subtitle="Infrastructure, scaling, and node configuration"
13. key="tools_and_technologies"   type="tech_tags"             title="Tools & Technologies"           subtitle="Full tech stack organized by category"
14. key="data_characteristics"     type="key_value_pairs"       title="Data Characteristics"           subtitle="Volume, velocity, variety and schema details"
15. key="database_schema"          type="table"                 title="Database Schema"                subtitle="Core tables, columns, relationships"
16. key="tool_integration_map"     type="cards"                 title="Tool Integration Map"           subtitle="How all tools connect and communicate"
17. key="why_these_tools"          type="comparison_table"      title="Why These Tools"                subtitle="Key technology decisions and trade-offs"
18. key="methodology"              type="steps"                 title="Methodology"                    subtitle="Development approach, process, and framework used"
19. key="cicd_pipeline"            type="steps"                 title="CI/CD Pipeline"                 subtitle="Build, test, and deployment automation steps"
20. key="environment_setup"        type="cards"                 title="Environment Setup"              subtitle="Dev, staging, and production environment details"
21. key="monitoring_alerting"      type="cards"                 title="Monitoring & Alerting"          subtitle="Observability stack and alert rules"
22. key="challenges_resolution"    type="challenge_cards"       title="Challenges & Resolution"        subtitle="Key obstacles faced and how they were overcome"
23. key="production_issues"        type="timeline"              title="Production Issues"              subtitle="Real incidents, root causes, and resolutions"
24. key="performance_optimization" type="metrics"               title="Performance Optimization"       subtitle="Before/after metrics from optimization work"
25. key="key_achievements"         type="metrics"               title="Key Achievements"               subtitle="Measurable outcomes and business impact"
26. key="technical_learnings"      type="quote_cards"           title="Technical Learnings"            subtitle="What you learned and would do differently"

### Role adaptation rules (skip marked sections):
- Software Eng / Full Stack / Frontend / Backend: include all 26 sections
- Data Engineering / Data Architecture: include all 26 sections
- DevOps / SRE / Platform: include all 26; make architecture_diagram, architecture_tree and cluster_nodes very detailed
- Data Science / ML / AI: skip cluster_nodes; add ML-specific content in methodology and data_characteristics
- Product Manager / Business Analyst: skip sections 8,9,10,11,12,14,15,16,19,20; use business/OKR language for rest
- Marketing / Growth: skip sections 8,9,10,11,12,14,15,16,19,20,21; focus on campaign metrics
- Finance / Accounting: skip sections 8,9,10,11,12,14,15,16,19,20,21; use financial KPIs
- Operations / Supply Chain: skip sections 8,10,11,12,14,15,16,19,20,21; adapt to process-oriented content`.trim();

  const OUTPUT_FORMAT = `
## OUTPUT FORMAT

Each project = one JSON object:

{
  "projectHeader": {
    "title": "...",
    "tagline": "...",
    "domain": "...",
    "duration": "...",
    "teamSize": "...",
    "role": "..."
  },
  "sections": [
    {
      "key": "snake_case_identifier",
      "title": "Human-readable Title",
      "subtitle": "Brief description of this section",
      "type": "<see type reference>",
      "content": <see type reference>
    }
  ]
}`.trim();

  const SHARED_CRITICAL_RULES = `
## CRITICAL RULES (APPLY TO ALL MODES)

 1. Output EXACTLY ${PROJECTS_PER_REQUEST} JSON object${PROJECTS_PER_REQUEST === 1 ? "" : "s"}, each covering all applicable sections above.
 2. NO markdown wrappers (no \`\`\`json), NO explanations, NO extra text outside JSON.
 3. After each project's closing brace, append exactly: |||PROJECT_END|||
 4. Sections array must follow the numbered order above.
 5. Quantify everything: real numbers (%, $, ms, records/day, GB, users, team size).
 6. ${PROJECTS_PER_REQUEST === 1 ? "Make this project realistic, detailed, and fully interview-ready." : `All ${PROJECTS_PER_REQUEST} projects must be meaningfully different scenarios within the same role.`}
 7. No placeholder text. Every field must contain real, role-appropriate, interview-ready content.
 8. code_snippets must contain actual realistic code (not pseudocode), 15–40 lines each.
 9. architecture_diagram must be a proper ASCII art diagram with boxes, arrows (→, ↓, ↑, ←, ↔).
10. Projects must directly address real requirements from the job description where one is provided.
11. Tailor complexity and scope to the specified experience level.
12. thirty_second_summary hook must be a single memorable opening sentence (max 20 words). mainPoints must be exactly 3 strings. closingLine is a confident one-liner.
13. architecture_tree must include ALL applicable layers (Frontend, Backend, Database, Infrastructure); each layer must have 2–4 nodes.
14. database_schema rows must reflect the actual data model; include primary keys, foreign keys, and data types.
15. cicd_pipeline steps must be concrete (e.g., "Run Jest unit tests", "Build Docker image", "Push to ECR").`.trim();

  // ─────────────────────────────────────────────────────────────────────────
  // DISTRIBUTED ORCHESTRATION ARCHITECTURE
  // ─────────────────────────────────────────────────────────────────────────
  //
  //   Phase 1 — Planner Agent (1 fast call, ~1–2 s)
  //     └─ Produces N diverse ProjectPlan blueprints
  //
  //   Phase 2 — Parallel Project Workers (N simultaneous calls)
  //     ├─ Worker 0: collectProjectText(plan[0])  ─┐
  //     ├─ Worker 1: collectProjectText(plan[1])  ─┤─ all fire at once
  //     └─ Worker 2: collectProjectText(plan[2])  ─┘
  //
  //   Phase 3 — Arrival-ordered streaming
  //     └─ Yield each complete project to the controller as it finishes
  //        (fastest-first — client sees project N the moment it's ready)
  //
  // Token optimisation: all 26 section definitions live in the SYSTEM prompt
  // (shared/cached across the parallel calls). User messages carry only
  // project-specific data → ~40–60% token reduction per call.
  // ─────────────────────────────────────────────────────────────────────────

  const DELIMITER = "|||PROJECT_END|||";

  // ── Compressed system prompt shared by all generation calls ────────────────
  // Moving static definitions here enables potential prompt caching on Claude
  // and keeps user messages lean.
  const SINGLE_PROJECT_RULES = `
## CRITICAL RULES (APPLY TO THIS PROJECT)

1. Output EXACTLY 1 JSON object covering all applicable sections.
2. NO markdown wrappers (no \`\`\`json), NO explanations, NO extra text outside JSON.
3. After the project's closing brace, append exactly: |||PROJECT_END|||
4. Sections array must follow the numbered order above.
5. Quantify everything: real numbers (%, $, ms, records/day, GB, users, team size).
6. Make this project realistic, detailed, and fully interview-ready.
7. No placeholder text. Every field must contain real, role-appropriate, interview-ready content.
8. code_snippets must contain actual realistic code (not pseudocode), 15–40 lines each.
9. architecture_diagram must be a proper ASCII art diagram with boxes, arrows (→, ↓, ↑, ←, ↔).
10. Projects must directly address real requirements from the job description where one is provided.
11. Tailor complexity and scope to the specified experience level.
12. thirty_second_summary hook must be a single memorable opening sentence (max 20 words). mainPoints must be exactly 3 strings. closingLine is a confident one-liner.
13. architecture_tree must include ALL applicable layers (Frontend, Backend, Database, Infrastructure); each layer must have 2–4 nodes.
14. database_schema rows must reflect the actual data model; include primary keys, foreign keys, and data types.
15. cicd_pipeline steps must be concrete (e.g., "Run Jest unit tests", "Build Docker image", "Push to ECR").
`.trim();

  const GENERATION_SYSTEM_PROMPT = [
    "You are an expert technical architect and career strategist generating portfolio project case studies.",
    "Output raw JSON only — no markdown fences, no commentary.",
    "After the closing brace of the JSON object, append exactly: |||PROJECT_END|||",
    "",
    OUTPUT_FORMAT,
    "",
    SECTION_TYPE_REFERENCE,
    "",
    MASTER_SECTION_LIST,
    "",
    SINGLE_PROJECT_RULES,
  ].join("\n");

  // ── Project blueprint produced by the planner ─────────────────────────────
  interface ProjectPlan {
    title: string;
    domain: string;
    techFocus: string;
    scenario: string;
  }

  // ── Phase 1: Planner agent ────────────────────────────────────────────────
  // One cheap call (≤500 output tokens) that returns N diverse blueprints.
  // Having titles/domains upfront lets all workers start in parallel without
  // needing the sequential diversity-tracking used in the old architecture.
  async function planProjects(): Promise<ProjectPlan[]> {
    const planStart = Date.now();
    console.log(`\n[projects] ── Phase 1: Planner Agent ─────────────────────────────`);
    console.log(`[projects]   position="${position}" mode=${generationMode} model=${PROJECTS_MODEL}`);
    const planPrompt = [
      `Generate a planning blueprint for ${PROJECTS_PER_REQUEST} diverse portfolio project case studies.`,
      "",
      `ROLE: ${position}`,
      `INDUSTRY: ${industry || "infer from role"}`,
      `EXPERIENCE LEVEL: ${experienceLevel || "mid-level"}`,
      `MODE: ${generationMode === "resume_enhanced" ? "Transform existing resume experience" : "Generate new fictional projects"}`,
      resumeContext ? `\nSKILLS / CONTEXT:\n${resumeContext.slice(0, 600)}` : "",
      jobDescription ? `\nJOB DESCRIPTION:\n${jobDescription.slice(0, 400)}` : "",
      "",
      `Output ONLY a JSON array of exactly ${PROJECTS_PER_REQUEST} objects. No markdown, no commentary.`,
      `Schema: [{ "title": string, "domain": string, "techFocus": "top 3 techs comma-separated", "scenario": "one-sentence company/problem" }]`,
      "",
      "Rules:",
      "- Each project covers a completely different industry vertical and primary tech stack",
      "- title = realistic project name (e.g. \"Real-Time Inventory Sync Platform\")",
      "- scenario = e.g. \"Fintech startup needing real-time fraud detection at 50k TPS\"",
      "- For resume_enhanced: map each to a distinct experience from the candidate's resume",
      "- For new: invent fictional but realistic companies and scenarios",
    ].filter(Boolean).join("\n").trim();

    try {
      const planStream = await ai.chat.send({
        chatRequest: {
          model: PROJECTS_MODEL,
          messages: [
            { role: "system" as const, content: "Output a raw JSON array only. No markdown fences." },
            { role: "user" as const, content: planPrompt },
          ],
          stream: true as const,
          maxTokens: 500,
        },
      });
      let raw = "";
      for await (const chunk of planStream) {
        raw += (chunk as any).choices?.[0]?.delta?.content || "";
      }
      raw = raw.replace(/^```json?\n?/i, "").replace(/\n?```$/i, "").trim();
      const plans = JSON.parse(raw) as ProjectPlan[];
      if (Array.isArray(plans) && plans.length >= PROJECTS_PER_REQUEST) {
        console.log(`[projects]   Planner OK (${Date.now() - planStart}ms)`);
        plans.slice(0, PROJECTS_PER_REQUEST).forEach((p, i) =>
          console.log(`[projects]   blueprint[${i}] "${p.title}" — ${p.domain} — ${p.techFocus}`)
        );
        return plans.slice(0, PROJECTS_PER_REQUEST);
      }
    } catch (planErr) {
      console.warn(`[projects]   Planner failed (${Date.now() - planStart}ms) — using fallback blueprints`, (planErr as Error).message);
    }

    // Fallback blueprints when planning call fails or returns malformed JSON
    console.log(`[projects]   Using fallback blueprints`);
    const fallbackPlans: ProjectPlan[] = [
      { title: "Distributed Data Pipeline", domain: "Data Engineering", techFocus: "Python, Kafka, PostgreSQL", scenario: "Scaling real-time data ingestion for a fintech analytics platform" },
      { title: "Cloud Infrastructure Platform", domain: "DevOps / Platform Engineering", techFocus: "Kubernetes, Terraform, GitHub Actions", scenario: "Automating multi-region deployments for a growing SaaS product" },
      { title: "High-Throughput API Gateway", domain: "Backend Engineering", techFocus: "Node.js, Redis, PostgreSQL", scenario: "Building a resilient API layer for a B2B marketplace at 10k RPS" },
    ];
    if (PROJECTS_PER_REQUEST <= fallbackPlans.length) {
      return fallbackPlans.slice(0, PROJECTS_PER_REQUEST);
    }
    const expanded: ProjectPlan[] = [...fallbackPlans];
    for (let i = fallbackPlans.length; i < PROJECTS_PER_REQUEST; i++) {
      const base = fallbackPlans[i % fallbackPlans.length];
      expanded.push({
        ...base,
        title: `${base.title} ${i + 1}`,
      });
    }
    return expanded;
  }

  // ── Phase 2a: Lean user-message builder ───────────────────────────────────
  // All section definitions live in the system prompt above.
  // This message carries only project-specific data → minimal token cost.
  function buildProjectPrompt(plan: ProjectPlan): string {
    const modeInstruction = generationMode === "resume_enhanced"
      ? "MODE: RESUME-ENHANCED — Transform the candidate's EXISTING experience into this case study. " +
        "Base it on real work from the resume; enrich with architecture diagrams, code snippets, metrics, and STAR stories. " +
        "Never invent technologies not found in the resume."
      : "MODE: NEW PROJECT — Generate a completely fictional but realistic project. " +
        "Do NOT reference or copy any project already in the candidate's resume. " +
        "Only use technologies plausible given the candidate's demonstrated skills.";

    const lines = [
      modeInstruction,
      "",
      "PROJECT BLUEPRINT:",
      `Title: ${plan.title}`,
      `Domain: ${plan.domain}`,
      `Core Technologies: ${plan.techFocus}`,
      `Scenario: ${plan.scenario}`,
      "",
      "CANDIDATE PROFILE:",
      `Position: ${position}`,
      `Industry: ${industry || "Not specified"}`,
      `Experience Level: ${experienceLevel || "Not specified"}`,
    ];

    if (resumeContext) {
      const limit = generationMode === "resume_enhanced" ? 1500 : 600;
      lines.push("", "Skills / Resume Context:", resumeContext.slice(0, limit));
    }
    if (jobDescription) {
      const limit = generationMode === "resume_enhanced" ? 600 : 400;
      lines.push("", "Job Description:", jobDescription.slice(0, limit));
    }

    lines.push(
      "",
      "Generate this project as a complete, interview-ready portfolio case study.",
      "Include ALL applicable sections from the MASTER SECTION LIST in your instructions.",
      "Output EXACTLY 1 JSON object followed by |||PROJECT_END|||",
    );

    return lines.join("\n");
  }

  // ── Phase 2b: Single-project collector with retry ─────────────────────────
  // Collects one complete project from the AI stream.
  // Returns empty string on permanent failure (controller handles gracefully).
  async function collectProjectText(plan: ProjectPlan, index: number): Promise<string> {
    const workerStart = Date.now();
    console.log(`[projects]   worker[${index}] START "${plan.title}" (${plan.domain})`);
    const messages = [
      { role: "system" as const, content: GENERATION_SYSTEM_PROMPT },
      { role: "user" as const, content: buildProjectPrompt(plan) },
    ];

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        if (attempt > 0) console.log(`[projects]   worker[${index}] retry attempt ${attempt + 1}`);
        const stream = await ai.chat.send({
          chatRequest: { model: PROJECTS_MODEL, messages, stream: true as const, maxTokens: 16000 },
        });
        let text = "";
        let tokenCount = 0;
        for await (const chunk of stream) {
          const delta = (chunk as any).choices?.[0]?.delta?.content || "";
          text += delta;
          tokenCount += delta.length;
        }
        if (text.includes("{")) {
          console.log(`[projects]   worker[${index}] DONE "${plan.title}" — ${tokenCount} chars in ${Date.now() - workerStart}ms`);
          return text;
        }
        throw new Error("Response contained no JSON object");
      } catch (err) {
        if (attempt === 1) {
          console.error(`[projects]   worker[${index}] FAILED "${plan.title}" after 2 attempts (${Date.now() - workerStart}ms):`, (err as Error).message);
          return "";
        }
        console.warn(`[projects]   worker[${index}] attempt 1 failed — retrying in 500ms:`, (err as Error).message);
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    return "";
  }

  // ── Phase 3: Parallel launch + arrival-ordered streaming ──────────────────
  // All collectors fire simultaneously. An in-process completion channel
  // (push/wait over a plain array + resolver queue) yields each project to the
  // controller the moment it finishes — no SSE or WebSocket required at this
  // layer. Latency improvement remains proportional to concurrent workers.
  const orchestrationStart = Date.now();
  const plans = await planProjects();
  const targetCount = plans.length;

  console.log(`\n[projects] ── Phase 2: Parallel Workers ────────────────────────────`);
  console.log(`[projects]   Launching ${targetCount} workers simultaneously...`);

  // Completion channel — zero external dependencies
  const arrivals: string[] = [];
  const waiters: Array<(text: string) => void> = [];

  const pushArrival = (text: string): void => {
    if (waiters.length > 0) {
      // A consumer is already waiting — hand off immediately
      (waiters.shift() as (t: string) => void)(text);
    } else {
      arrivals.push(text);
    }
  };

  const waitArrival = (): Promise<string> =>
    new Promise((resolve) => {
      if (arrivals.length > 0) {
        resolve(arrivals.shift() as string);
      } else {
        waiters.push(resolve);
      }
    });

  // Launch all workers in parallel — intentionally NOT awaited here
  const workerLaunchTime = Date.now();
  plans.forEach((plan, i) => {
    collectProjectText(plan, i)
      .then((text) => pushArrival(text))
      .catch(() => pushArrival(""));
  });

  console.log(`\n[projects] ── Phase 3: Streaming to client (arrival-ordered) ──────`);

  // Yield each project as it arrives (fastest-first delivery to client)
  let successCount = 0;
  for (let i = 0; i < targetCount; i++) {
    const raw = await waitArrival();
    if (!raw) {
      console.warn(`[projects]   arrival[${i}] skipped — worker returned empty`);
      continue;
    }

    const clean = raw
      .replace(/^```json\n?/i, "")
      .replace(/\n?```$/i, "")
      .trim();

    console.log(`[projects]   arrival[${successCount}] yielding project to controller (${clean.length} chars, +${Date.now() - workerLaunchTime}ms)`);
    yield clean.includes(DELIMITER) ? clean : clean + DELIMITER;
    successCount++;
  }

  const totalMs = Date.now() - orchestrationStart;
  if (successCount === 0) {
    console.error(`[projects] Generation FAILED — 0 valid projects produced (${totalMs}ms total)`);
    throw new AppError(503, "AI generation produced no valid projects. Please try again.");
  }
  console.log(`\n[projects] ── Generation complete — ${successCount}/${targetCount} projects in ${totalMs}ms ────\n`);
}

/**
 * Saves a generated project batch to the database.
 */
export async function saveProjectBatch(
  userId: string,
  position: string,
  jobDescription: string,
  projects: any[],
  resumeId?: string,
  industry?: string,
  experienceLevel?: string,
) {
  return prisma.project.create({
    data: {
      userId,
      position,
      jobDescription,
      resumeId: resumeId || null,
      industry: industry || null,
      experienceLevel: experienceLevel || null,
      projects: projects,
    },
  });
}

/**
 * Returns all stored projects for a given user.
 */
export async function getProjectsByUser(userId: string) {
  return prisma.project.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
  });
}

/**
 * Returns a single project record by its database ID.
 */
export async function getProjectById(id: string) {
  return prisma.project.findUnique({
    where: { id },
  });
}

/**
 * Deletes a project record.
 */
export async function deleteProjectById(id: string): Promise<void> {
  await prisma.project.delete({ where: { id } });
}

/**
 * Updates mutable fields on a project record (currently: position label).
 */
export async function updateProjectById(
  id: string,
  data: { position: string },
) {
  return prisma.project.update({ where: { id }, data });
}

/**
 * Replaces the `projects` JSON on an existing record, saving the previous content
 * as a numbered ProjectVersion snapshot first.
 * Returns the updated Project with versions included.
 */
export async function replaceProjectsWithVersion(
  id: string,
  userId: string,
  newProjects: unknown[],
) {
  return prisma.$transaction(async (tx) => {
    // Fetch current record — also need to know the current max version number
    const existing = await tx.project.findUnique({
      where: { id },
      include: { versions: { orderBy: { versionNumber: "desc" }, take: 1 } },
    });
    if (!existing) throw new AppError(404, "Project not found");
    if (existing.userId !== userId) throw new AppError(403, "Forbidden");

    const nextVersionNumber = (existing.versions[0]?.versionNumber ?? 0) + 1;
    const label = `Version ${nextVersionNumber} — before regen ${new Date().toISOString().slice(0, 10)}`;

    // Snapshot the current content
    await tx.projectVersion.create({
      data: {
        projectId: id,
        versionNumber: nextVersionNumber,
        projects: existing.projects as Prisma.InputJsonValue,
        label,
      },
    });

    // Replace with new content
    const updated = await tx.project.update({
      where: { id },
      data: { projects: newProjects as Prisma.InputJsonValue },

      include: {
        versions: { orderBy: { versionNumber: "desc" } },
      },
    });

    return updated;
  });
}

/**
 * Returns all version snapshots for a project (newest first).
 */
export async function getProjectVersions(id: string, userId: string) {
  const project = await prisma.project.findUnique({ where: { id }, select: { userId: true } });
  if (!project) throw new AppError(404, "Project not found");
  if (project.userId !== userId) throw new AppError(403, "Forbidden");

  return prisma.projectVersion.findMany({
    where: { projectId: id },
    orderBy: { versionNumber: "desc" },
  });
}

/**
 * Rolls back a project's `projects` JSON to a specific version snapshot.
 * The current content is itself snapshotted first so nothing is lost.
 */
export async function rollbackToVersion(
  projectId: string,
  versionId: string,
  userId: string,
) {
  return prisma.$transaction(async (tx) => {
    const project = await tx.project.findUnique({
      where: { id: projectId },
      include: { versions: { orderBy: { versionNumber: "desc" }, take: 1 } },
    });
    if (!project) throw new AppError(404, "Project not found");
    if (project.userId !== userId) throw new AppError(403, "Forbidden");

    const target = await tx.projectVersion.findUnique({ where: { id: versionId } });
    if (!target || target.projectId !== projectId) throw new AppError(404, "Version not found");

    // Snapshot current state before rollback
    const nextVersionNumber = (project.versions[0]?.versionNumber ?? 0) + 1;
    await tx.projectVersion.create({
      data: {
        projectId,
        versionNumber: nextVersionNumber,
        projects: project.projects as Prisma.InputJsonValue,
        label: `Version ${nextVersionNumber} — before rollback to v${target.versionNumber} ${new Date().toISOString().slice(0, 10)}`,
      },
    });

    // Apply rollback
    const updated = await tx.project.update({
      where: { id: projectId },
      data: { projects: target.projects as Prisma.InputJsonValue },

      include: { versions: { orderBy: { versionNumber: "desc" } } },
    });

    return updated;
  });
}

/**
 * Checks that the user has enough credits for project generation WITHOUT deducting.
 * Throws AppError(402) if balance is insufficient.
 * Call this before starting the stream to gate the request.
 */
export async function checkGenerationCreditBalance(userId: string): Promise<void> {
  const cost = await getFeatureCost("project_generate", DEFAULT_COST_GENERATE);
  const balance = await prisma.userCreditBalance.findUnique({ where: { userId } });
  const available = new Prisma.Decimal(balance?.totalAvailable?.toString() ?? "0");
  if (available.lt(cost)) {
    throw new AppError(
      402,
      `Insufficient credits. Required: ${cost}, Available: ${available}`,
    );
  }
}

/**
 * Deducts credits for project generation — cost read from DB, defaults to 4.
 * Call this ONLY after confirming at least one valid project was parsed.
 */
export async function deductGenerationCredits(
  userId: string,
): Promise<{ creditsRemaining: number }> {
  const cost = await getFeatureCost("project_generate", DEFAULT_COST_GENERATE);
  return deductCredits(userId, cost, "AI_PROJECT_GENERATE");
}

/**
 * @deprecated Use checkGenerationCreditBalance + deductGenerationCredits instead.
 * Kept for backwards-compat; will be removed in a future cleanup.
 */
export async function checkAndDeductGenerationCredits(
  userId: string,
): Promise<{ creditsRemaining: number }> {
  return deductGenerationCredits(userId);
}

/**
 * Regenerates a single section of an existing project using AI (1 credit).
 */
export async function editProjectComponent(
  userId: string,
  projectId: string,
  sectionKey: string,
  projectContext: string,
): Promise<{ sectionKey: string; value: unknown }> {
  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) throw new AppError(404, "Project not found");
  if (project.userId !== userId) throw new AppError(403, "Forbidden");

  const editCost = await getFeatureCost("project_edit_component", DEFAULT_COST_EDIT_COMPONENT);
  const { creditsRemaining } = await deductCredits(
    userId,
    editCost,
    "AI_PROJECT_EDIT_COMPONENT",
  );

  const prompt = `
You are a senior technical strategist regenerating a single section for a project documentation system.

PROJECT CONTEXT:
${projectContext}

SECTION KEY TO REGENERATE: "${sectionKey}"

Rules:
1. Output ONLY the JSON value for the "content" field of this section (not the full section object).
2. Match the appropriate content shape for the section type — bullets=string[], narrative=string, metrics=array, etc.
3. Be specific, realistic, and quantified. Include real tools, metrics (%, ms, $, scale numbers).
4. No markdown fences, no commentary, just the raw JSON value.

Output the new content value now:
`.trim();

  const editStream = await ai.chat.send({
    chatRequest: {
      model: PROJECTS_MODEL,
      messages: [
        { role: "system" as const, content: "You are an expert technical content generator outputting raw JSON only." },
        { role: "user" as const, content: prompt },
      ],
      stream: true as const,
      maxTokens: 2000,
    },
  });

  let raw = "";
  for await (const chunk of editStream) {
    raw += (chunk as any).choices?.[0]?.delta?.content || "";
  }

  // Clean markdown fences if present
  raw = raw.replace(/^```[a-z]*\n?/i, "").replace(/\n?```$/i, "").trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = raw;
  }

  // Persist the updated section's content back into the stored projects JSON
  const projects = Array.isArray(project.projects) ? project.projects : [];
  const updated = projects.map((p: any) => ({
    ...p,
    sections: Array.isArray(p.sections)
      ? p.sections.map((s: any) =>
          s.key === sectionKey ? { ...s, content: parsed } : s,
        )
      : p.sections,
  }));
  await prisma.project.update({
    where: { id: projectId },
    data: { projects: updated },
  });

  return { sectionKey, value: parsed };
}
