import type { AIAnswerLiveContextMetadata } from "./ai-answer.dto";

export type AnswerIntent =
  | "concept_explanation"
  | "behavioral_project_experience"
  | "code_generation"
  | "code_explanation_followup"
  | "code_debug_followup"
  | "code_optimization_followup"
  | "system_design"
  | "scenario_based"
  | "general_followup";

const PREV_ANSWER_EXCERPT_MAX = 700;
const POLICY_BLOCK_MAX_CHARS = 1200;
const CODE_BLOCK_CHARS_MAX = 1200;
const CROSS_INTENT_CONCEPT_RE =
  /\b(what is|what are|explain|define|difference between|how does)\b/i;
const EXPLICIT_EXPERIENCE_RE =
  /\b(your experience|your project|your company|tell me about your project|from your project|in your company|in your project)\b/i;
const PROJECT_OVERVIEW_RE =
  /\b(explain|describe|tell me about|walk me through|list|share)\b[\s\w]{0,30}\b(projects|project work|work done|things you built)\b/i;
const CODE_REF_RE =
  /\b(this code|above code|previous code|code you wrote|that code|the query|query you wrote|query you wrote before|first line)\b/i;
const DEBUG_RE = /\b(debug|fix|issue|bug|error|why failing)\b/i;
const OPT_RE = /\b(optimi[sz]e|improve performance|make it faster|refactor)\b/i;
const CODE_GEN_RE =
  /\b(write|implement|give|show|create|build)\b.{0,24}\b(code|snippet|function|class|query|api)\b|\b(code|snippet)\b/i;
const SYSTEM_DESIGN_RE =
  /\b(system design|design a|architecture|scalab|throughput|latency|distributed|microservice)\b/i;
const SCENARIO_RE =
  /\b(scenario|suppose|imagine|case where|incident|outage|what would you do)\b/i;
const FOLLOWUP_RE =
  /\b(why did you use this|explain this|explain more|go deeper|clarify|tell me more)\b/i;

function clip(text: string, max: number): string {
  return (text || "").trim().slice(0, max);
}

export function classifyAnswerIntent(input: {
  question: string;
  answerMode?: AIAnswerLiveContextMetadata["answerMode"];
  previousCodeBlocks?: string[];
  cieComplexity?: string;
}): AnswerIntent {
  const q = (input.question || "").toLowerCase().trim();
  const hasPrevCode = !!(input.previousCodeBlocks && input.previousCodeBlocks.length > 0);

  if (input.answerMode === "system_design") return "system_design";
  if (input.answerMode === "explain_existing_code" && hasPrevCode) {
    if (DEBUG_RE.test(q)) return "code_debug_followup";
    if (OPT_RE.test(q)) return "code_optimization_followup";
    return "code_explanation_followup";
  }

  if (CODE_REF_RE.test(q)) {
    if (DEBUG_RE.test(q)) return "code_debug_followup";
    if (OPT_RE.test(q)) return "code_optimization_followup";
    return "code_explanation_followup";
  }
  if (EXPLICIT_EXPERIENCE_RE.test(q)) return "behavioral_project_experience";
  if (SYSTEM_DESIGN_RE.test(q)) return "system_design";
  if (SCENARIO_RE.test(q) || input.cieComplexity === "scenario_based") return "scenario_based";
  if (CODE_GEN_RE.test(q) || input.answerMode === "code_required" || input.answerMode === "minimal_code") {
    return "code_generation";
  }
  if (CROSS_INTENT_CONCEPT_RE.test(q)) return "concept_explanation";
  if (FOLLOWUP_RE.test(q)) return "general_followup";
  return "general_followup";
}

export function buildRequestScopedPolicy(input: {
  question: string;
  metadata?: AIAnswerLiveContextMetadata;
  cieComplexity?: string;
}): {
  answerIntent: AnswerIntent;
  effectiveAnswerMode:
    | "auto"
    | "theory_only"
    | "minimal_code"
    | "code_required"
    | "explain_existing_code"
    | "system_design";
  policyBlock: string;
  codeContextBlock: string;
  previousAiAnswerExcerptLength: number;
  codeBlocksInjectedCount: number;
  isCodeFollowup: boolean;
  experienceSuppressed: boolean;
} {
  const metadata = input.metadata || {};
  const answerIntent = classifyAnswerIntent({
    question: input.question,
    answerMode: metadata.answerMode,
    previousCodeBlocks: metadata.previousCodeBlocks,
    cieComplexity: input.cieComplexity,
  });

  const explicitMode = metadata.answerMode && metadata.answerMode !== "auto"
    ? metadata.answerMode
    : undefined;

  const effectiveAnswerMode = explicitMode || (() => {
    if (
      answerIntent === "code_explanation_followup" ||
      answerIntent === "code_debug_followup" ||
      answerIntent === "code_optimization_followup"
    ) return "explain_existing_code";
    if (answerIntent === "code_generation") return "minimal_code";
    if (answerIntent === "system_design") return "system_design";
    if (answerIntent === "concept_explanation") return "theory_only";
    return "auto";
  })();

  const explicitExperienceRequested = EXPLICIT_EXPERIENCE_RE.test(input.question || "");
  const experienceSuppressed =
    answerIntent === "concept_explanation" && !explicitExperienceRequested;

  const lines: string[] = [
    "REQUEST-SCOPED POLICY (THIS REQUEST ONLY):",
    `- intent: ${answerIntent}`,
    `- mode: ${effectiveAnswerMode}`,
    "- style: direct, interview-ready, procedural, concise",
  ];

  if (experienceSuppressed) {
    lines.push("- do_not_add_personal_experience: true unless explicitly asked");
  }
  if (answerIntent === "behavioral_project_experience") {
    lines.push("- include_resume_or_project_backed_examples: true");
    const isProjectOverview = PROJECT_OVERVIEW_RE.test(input.question || "");
    if (isProjectOverview) {
      lines.push("- project_coverage: include_all_selected_projects");
      lines.push("- project_depth_per_item: problem, role, architecture, stack, decisions, impact_metrics");
      lines.push("- avoid_generic_summary: true");
    } else {
      lines.push("- project_depth_single: include_problem_role_stack_architecture_challenge_impact");
    }
  }
  if (answerIntent === "code_generation") {
    lines.push("- code_policy: minimal practical code + short explanation");
  }
  if (answerIntent === "concept_explanation") {
    lines.push("- concept_policy: explain concept first; optional tiny example only if useful");
  }
  if (answerIntent === "system_design" || answerIntent === "scenario_based") {
    lines.push("- structure: numbered sections; cover all sub-parts explicitly");
  }
  if (
    answerIntent === "code_explanation_followup" ||
    answerIntent === "code_debug_followup" ||
    answerIntent === "code_optimization_followup"
  ) {
    lines.push("- followup_code_policy: prioritize referenced previous code context");
  }

  let codeContextBlock = "";
  let codeBlocksInjectedCount = 0;
  const isCodeFollowup =
    answerIntent === "code_explanation_followup" ||
    answerIntent === "code_debug_followup" ||
    answerIntent === "code_optimization_followup";

  if (isCodeFollowup && Array.isArray(metadata.previousCodeBlocks) && metadata.previousCodeBlocks.length > 0) {
    const blocks = metadata.previousCodeBlocks
      .slice(0, 2)
      .map((b) => clip(b, CODE_BLOCK_CHARS_MAX))
      .filter(Boolean);
    codeBlocksInjectedCount = blocks.length;
    const prevExcerpt = metadata.previousAiAnswer
      ? clip(metadata.previousAiAnswer, PREV_ANSWER_EXCERPT_MAX)
      : "";
    const prevSection = prevExcerpt
      ? `\nPrevious answer excerpt:\n${prevExcerpt}`
      : "";
    codeContextBlock = `\nFOLLOW-UP CODE CONTEXT (for this request only):${prevSection}\n` +
      blocks.map((b, i) => `Code block ${i + 1}:\n${b}`).join("\n\n");
  }

  const policyBlock = clip(lines.join("\n"), POLICY_BLOCK_MAX_CHARS);
  return {
    answerIntent,
    effectiveAnswerMode,
    policyBlock,
    codeContextBlock,
    previousAiAnswerExcerptLength: metadata.previousAiAnswer
      ? clip(metadata.previousAiAnswer, PREV_ANSWER_EXCERPT_MAX).length
      : 0,
    codeBlocksInjectedCount,
    isCodeFollowup,
    experienceSuppressed,
  };
}
