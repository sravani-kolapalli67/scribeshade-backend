import { OpenRouter } from "@openrouter/sdk";
import path from "path";
import { Prisma } from "@prisma/client";
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

const OPENROUTER_MODEL =
  process.env.OPENROUTER_MODEL || "google/gemini-2.5-flash";

if (!process.env.OPENROUTER_API_KEY) {
  throw new Error("OPENROUTER_API_KEY environment variable is not defined");
}

const ai = new OpenRouter({
  apiKey: process.env.OPENROUTER_API_KEY,
});

/**
 * Parses a JSON response string from AI.
 */
export function parseJsonResponse<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]) as T;
      } catch {
        return null;
      }
    }
    return null;
  }
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
    const resume = await prisma.resume.findUnique({ where: { id: resumeId } });
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
          const ext = path.extname(resume.path).toLowerCase();
          resumeContext = await resumeService.extractTextFromFile(resume.path, ext);
        }
      } else {
        const ext = path.extname(resume.path).toLowerCase();
        resumeContext = await resumeService.extractTextFromFile(resume.path, ext);
      }
    }
  }

  // Guard: if resume was provided but yields < 2 identifiable skills, reject early
  if (resumeId && resumeContext && resumeContext.startsWith("EXTRACTED SKILLS LIST:")) {
    // Count comma-separated skills
    const skillCount = resumeContext.split("\n")[1]?.split(",").length ?? 0;
    if (skillCount < 2) {
      throw new AppError(422, "Insufficient skills detected in resume. Please upload a resume with at least 2 identifiable skills.");
    }
  }

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
type "steps"                 → content: [ { "step": string, "description": string } ]
type "challenge_cards"       → content: [ { "challenge": string, "solution": string } ]
type "metrics"               → content: [ { "metric": string, "value": string, "description": string, "before"?: string, "after"?: string } ]
type "quote_cards"           → content: string[]  (3–4 first-person learning reflections)
type "key_value_pairs"       → content: [ { "key": string, "value": string } ]
type "comparison_table"      → content: [ { "decision": string, "winner": string, "loser": string, "rationale": string } ]
type "cards"                 → content: [ { "title": string, "body": string, "badge"?: string } ]
type "table"                 → content: { "headers": string[], "rows": string[][] }
type "timeline"              → content: [ { "date": string, "event": string, "description": string } ]
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

 1. Output EXACTLY 3 JSON objects, each covering all applicable sections above.
 2. NO markdown wrappers (no \`\`\`json), NO explanations, NO extra text outside JSON.
 3. After each project's closing brace, append exactly: |||PROJECT_END|||
 4. Sections array must follow the numbered order above.
 5. Quantify everything: real numbers (%, $, ms, records/day, GB, users, team size).
 6. All 3 projects must be meaningfully different scenarios within the same role.
 7. No placeholder text. Every field must contain real, role-appropriate, interview-ready content.
 8. code_snippets must contain actual realistic code (not pseudocode), 15–40 lines each.
 9. architecture_diagram must be a proper ASCII art diagram with boxes, arrows (→, ↓, ↑, ←, ↔).
12. Projects must directly address real requirements from the job description where one is provided.
13. Tailor complexity and scope to the specified experience level.
14. thirty_second_summary hook must be a single memorable opening sentence (max 20 words). mainPoints must be exactly 3 strings. closingLine is a confident one-liner.
15. architecture_tree must include ALL four layers (Frontend, Backend, Database, Infrastructure) unless role has none of that layer; each layer must have 2–4 nodes.`.trim();

  let prompt: string;

  if (generationMode === "resume_enhanced") {
    // ── RESUME-ENHANCED MODE ───────────────────────────────────────────────
    // Deeply analyse what the candidate has already done and produce polished,
    // embellished case-studies from their real experience.
    prompt = `
You are a senior career strategist and technical documentation expert.

MODE: RESUME-ENHANCED — Your job is to transform the candidate's EXISTING experience from their resume into 3 polished, interview-ready project case studies. You are NOT inventing new projects; you are extracting, enriching, and professionally packaging what the candidate has already done.

---
## INPUTS

RESUME (primary source — extract REAL projects, roles, technologies, and accomplishments from this):
${resumeContext || "No resume provided — generate plausible projects from the position and job description."}

POSITION / ROLE:
${position}

INDUSTRY DOMAIN:
${industry || "Not specified — infer from position and JD."}

EXPERIENCE LEVEL:
${experienceLevel || "Not specified — infer from position."}

JOB DESCRIPTION:
${jobDescription || "Not provided — tailor projects to the position."}

---
${OUTPUT_FORMAT}

---
${SECTION_TYPE_REFERENCE}

---
${MASTER_SECTION_LIST}

---
${SHARED_CRITICAL_RULES}

## RESUME-ENHANCED SPECIFIC RULES

10. Base each project on a REAL piece of work from the resume. If the resume mentions only 1–2 projects, expand each into a full case-study and create a plausible third that is consistent with the candidate's demonstrated tech stack and seniority.
11. EMBELLISH and ENRICH: add architecture diagrams, code snippets, metrics, and STAR stories that are consistent with the experience described — even if not literally present in the resume.
12. NEVER invent technologies the resume does not suggest the candidate knows.
13. Each project must clearly map to a different role, company, or phase of the candidate's career where possible.
14. resume_ready_bullets must rewrite the candidate's bullet points to be achievement-oriented (XYZ formula: "Accomplished X by doing Y which resulted in Z").
15. Performance metrics and timelines should be realistic and consistent with the scale described in the resume.

Now transform the resume into 3 polished project case studies.
`.trim();

  } else {
    // ── NEW PROJECTS MODE (default) ────────────────────────────────────────
    // Invent brand-new fictional projects. Resume is used only for tech-stack
    // plausibility — never as a source of existing work.
    prompt = `
You are a senior technical strategist and documentation expert specializing in portfolio-ready project case studies.

MODE: NEW PROJECTS — Generate EXACTLY 3 completely new, fictional, production-grade project case studies. Use the resume ONLY to infer which technologies/skills the candidate knows. Do NOT describe, reference, or enhance any project already in their resume.

---
## INPUTS

RESUME (read for SKILLS & TECHNOLOGIES ONLY — do NOT copy, reference, or enhance any existing projects listed in the resume):
${resumeContext || "No resume provided — infer plausible skills from the position and job description."}

POSITION / ROLE:
${position}

INDUSTRY DOMAIN:
${industry || "Not specified — infer from position and JD."}

EXPERIENCE LEVEL:
${experienceLevel || "Not specified — infer from position."}

JOB DESCRIPTION:
${jobDescription || "Not provided — generate role-appropriate projects based on position."}

---
${OUTPUT_FORMAT}

---
${SECTION_TYPE_REFERENCE}

---
${MASTER_SECTION_LIST}

---
${SHARED_CRITICAL_RULES}

## NEW PROJECTS SPECIFIC RULES

10. Projects must be BRAND NEW — invent fictional but realistic companies and scenarios. Never describe a project already in the candidate's resume.
11. Every project must only use technologies/skills that are plausible for the candidate based on their resume. Do not introduce technologies they have never used.

Now generate the 3 new projects.
`.trim();
  }

  const messages = [
    { role: "system" as const, content: "You are an expert technical architect and career strategist." },
    { role: "user" as const, content: prompt },
  ];

  // Retry once on AI model failure (FR: AI Model Failure → retry once → 503)
  let stream;
  try {
    stream = await ai.chat.send({ chatRequest: { model: OPENROUTER_MODEL, messages, stream: true } });
  } catch (firstErr) {
    try {
      stream = await ai.chat.send({ chatRequest: { model: OPENROUTER_MODEL, messages, stream: true } });
    } catch {
      throw new AppError(503, "AI generation service is temporarily unavailable. Please try again.");
    }
  }

  for await (const chunk of stream) {
    const text = chunk.choices[0]?.delta?.content || "";
    if (text) yield text;
  }
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

  const stream = await ai.chat.send({
    chatRequest: {
      model: OPENROUTER_MODEL,
      messages: [
        { role: "system", content: "You are an expert technical content generator outputting raw JSON only." },
        { role: "user", content: prompt },
      ],
      stream: true,
    },
  });

  let raw = "";
  for await (const chunk of stream) {
    raw += chunk.choices[0]?.delta?.content || "";
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
