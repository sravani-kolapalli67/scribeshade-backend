import type { AIAnswerLiveContextMetadata } from "./ai-answer.dto";
import type { AISessionDecision } from "./ai-session-decision";
import { isFreshCodeGenerationRequest } from "./ai-answer-context-guards";

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
const POLICY_BLOCK_MAX_CHARS = 1400;
const CODE_BLOCK_CHARS_MAX = 1200;
const CROSS_INTENT_CONCEPT_RE =
  /\b(what is|what are|explain|define|difference between|how does|what could be the reason|what could be a reason|can (?:you|we) (?:create|use))\b/i;
const EXPLICIT_EXPERIENCE_RE =
  /\b(introduce (?:yourself|yourselves)|tell me about yourself|your profile|walk me through (?:your )?profile|skill set|your skills|your background|your experience|your project|your company|tell me about your project|from your project|in your company|in your project|years? of experience|how many years|professional experience|work experience|project details?|your role|responsibilit(?:y|ies)|tech stack|impact|metrics?|worked on|services you worked on|critical situation|critical challenge|situation you faced|how did you handle it|rate yourself|how confident|your confidence|your tasks|included in your tasks|manage and secure sensitive credentials|client id and client secret|where do you store|key vault|secrets manager)\b/i;
const PROJECT_OVERVIEW_RE =
  /\b(explain|describe|tell me about|walk me through|list|share)\b[\s\w]{0,30}\b(projects|project work|work done|things you built)\b/i;
const CODE_REF_RE =
  /\b(this code|the code|above code|previous code|code you wrote|that code|the query|that query|that function|this function|your function|the function you wrote|function that you (?:have )?written|row_number|row number|year\s*-\s*row_number|lag\(|lag function|\blag\b|lead\(|lead function|\blead\b|window function|how this works|same query|the same query|same code|the same code|same logic|same script|query you wrote|query you wrote before|first line|explain (?:it|the code again)|explain (?:this|that|the|your|previous|above)\s+(?:code|query|snippet|function|logic)|why (?:is|was) this used|why did you use this|optimi[sz]e (?:this|it|the code|the query)|debug (?:this|it|the code|the query)|fix (?:this|it|the code|the query))\b/i;
const DEBUG_RE = /\b(debug|fix|issue|bug|error|why failing)\b/i;
const OPT_RE = /\b(optimi[sz]e|improve performance|make it faster|refactor|what if (?:the|this|that|same)\b.*\b(?:query|code|logic)|slow(?:er)?|performance issue|hitting (?:all|every|maximum|max)|full (?:table )?scan)\b/i;
const CODE_GEN_RE =
  /\b(write|implement|give|show|create|build)\b.{0,40}\b(code|snippet|function|class|query|api|component|hook)\b/i;
const SYSTEM_DESIGN_RE =
  /\b(system design|design a|architect|architecture|scalab|throughput|latency|distributed|microservice)\b/i;
const SCENARIO_RE =
  /\b(scenario setup|scenario|suppose|imagine|case where|incident|outage|what would you do|how would you handle|how will you tackle|continue from (?:database|backend|frontend|api|architecture|deployment|security|scaling) part|database part|architecture part|production|e-?commerce|inventory|stock|oversell|oversold|multiple users?|concurrent|race condition|high traffic|negative orders?)\b/i;
const FOLLOWUP_RE =
  /\b(why did you use this|why this is used|explain this|explain that|explain the code again|explain more|go deeper|clarify|tell me more|continue|continue from|what about that|how this works|how come|are you sure|is that correct|not correct|in context of|you mentioned|you said|previous answer|above answer)\b/i;
const TECH_CONCEPT_RE =
  /\b(python\s+)?(generator|decorator)s?\b|\bspark\s*(session|context)\b|\bdata skew\b|\brepartition\b|\bcoalesce\b|\bbroadcast join\b|\bspark ui\b|\bexecutor\b|\bdriver\b|\btable statistics\b|\bcolumn statistics\b|\bstats\b|\bdatabricks\b|\bnumpy\b|\bpandas\b/i;
const SQL_JOIN_CONCEPT_RE =
  /\b(inner join|left join|right join|full join|join count|output rows?|output records?|records? (?:will|would) (?:come|appear)|table1|table2)\b/i;
const CLOUD_CREDENTIAL_SECURITY_RE =
  /(?=.*\b(?:azure)\b)(?=.*\b(?:aws|amazon web services)\b)(?=.*\b(?:credentials?|client ids?|client secrets?|secrets?|key vault|secrets manager|parameter store)\b)/i;

function clip(text: string, max: number): string {
  return (text || "").trim().slice(0, max);
}

export function classifyAnswerIntent(input: {
  question: string;
  answerMode?: AIAnswerLiveContextMetadata["answerMode"];
  previousCodeBlocks?: string[];
  cieComplexity?: string;
  aiDecision?: AISessionDecision;
}): AnswerIntent {
  const q = (input.question || "").toLowerCase().trim();
  const hasPrevCode = !!(input.previousCodeBlocks && input.previousCodeBlocks.length > 0);
  const isFreshCodeGeneration =
    input.answerMode === "code_required" ||
    input.answerMode === "minimal_code" ||
    CODE_GEN_RE.test(q) ||
    isFreshCodeGenerationRequest(input.question);

  if (isFreshCodeGeneration && input.answerMode !== "explain_existing_code") {
    return "code_generation";
  }

  if (input.aiDecision && input.aiDecision.confidence >= 0.62) {
    switch (input.aiDecision.intent) {
      case "EXPLAIN_CODE":
        return "code_explanation_followup";
      case "DEBUG_CODE":
        return "code_debug_followup";
      case "OPTIMIZE_CODE":
        return "code_optimization_followup";
      case "SCENARIO_QUESTION":
        return "scenario_based";
      case "EXPERIENCE_QUESTION":
        return "behavioral_project_experience";
      case "FOLLOW_UP":
      case "CONTINUE_PREVIOUS":
        return "general_followup";
      default:
        break;
    }
  }

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
  if (input.cieComplexity === "scenario_based") return "scenario_based";
  if (PROJECT_OVERVIEW_RE.test(q)) return "behavioral_project_experience";
  if (EXPLICIT_EXPERIENCE_RE.test(q)) return "behavioral_project_experience";
  if (SYSTEM_DESIGN_RE.test(q)) return "system_design";
  if (SCENARIO_RE.test(q)) return "scenario_based";
  if (isFreshCodeGeneration) return "code_generation";
  if (CROSS_INTENT_CONCEPT_RE.test(q) || TECH_CONCEPT_RE.test(q) || SQL_JOIN_CONCEPT_RE.test(q)) return "concept_explanation";
  if (FOLLOWUP_RE.test(q)) return "general_followup";
  return "general_followup";
}

export function buildRequestScopedPolicy(input: {
  question: string;
  metadata?: AIAnswerLiveContextMetadata;
  cieComplexity?: string;
  aiDecision?: AISessionDecision;
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
    aiDecision: input.aiDecision,
  });

  const aiDecisionMode =
    input.aiDecision &&
    input.aiDecision.confidence >= 0.62 &&
    input.aiDecision.answerMode !== "auto"
      ? input.aiDecision.answerMode
      : undefined;
  const explicitMode = aiDecisionMode || (metadata.answerMode && metadata.answerMode !== "auto"
    ? metadata.answerMode
    : undefined);

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
    input.aiDecision
      ? `- ai_decision: ${input.aiDecision.intent} confidence=${input.aiDecision.confidence.toFixed(2)} context=${input.aiDecision.contextToUse}`
      : "",
  ].filter(Boolean);

  if (experienceSuppressed) {
    lines.push("- do_not_add_personal_experience: true unless explicitly asked");
  }
  if (answerIntent === "behavioral_project_experience") {
    lines.push("- include_resume_or_project_backed_examples: true");
    lines.push("- project_source_precedence: selected_projects_first; resume_context_secondary_only_for_missing_details_or_when_projects_absent");
    lines.push("- experience_skill_project_structure: include Experience, Skill Set, and Projects when the question asks for profile/experience/skills/projects together");
    lines.push("- introduction_years_rule: open with verified name, role, and total experience; then cover requested projects and skills; omit unavailable facts");
    lines.push("- years_rule: state exact years/work experience only if present in runtime context; otherwise describe experience level without inventing years");
    if (CLOUD_CREDENTIAL_SECURITY_RE.test(input.question || "")) {
      lines.push("- credential_security_answer_shape: Azure Key Vault; runtime retrieval from Azure Data Factory or Databricks; Azure RBAC or managed identity; AWS Secrets Manager or Systems Manager Parameter Store; runtime retrieval from Glue or Lambda; IAM least privilege; encryption, audit logging, and secret rotation");
      lines.push("- credential_storage_rule: explicitly state that secrets must not be stored in local files, source code, repositories, notebooks, or plain-text configuration");
      lines.push("- credential_scope_rule: answer credential storage and access security only; do not drift into generic cloud storage, compute, database, or pipeline architecture");
    }
    const isProjectOverview = PROJECT_OVERVIEW_RE.test(input.question || "");
    if (isProjectOverview) {
      lines.push("- project_coverage: include_all_selected_projects");
      lines.push("- project_depth_per_item: business_problem, role, architecture_or_flow, stack_from_context, key_work, impact_without_invented_metrics");
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
    lines.push("- answer_shape: bullets for **Direct answer:**, **Referenced code:**, **Why it works:**, **Edge case/performance:**");
  }
  if (answerIntent === "behavioral_project_experience") {
    lines.push("- answer_shape: bullets for **Direct answer:**, **Experience/project:**, **Stack/responsibilities:**, **Impact:**, **Closing line:**");
    lines.push("- project_answer_structure: brief_intro; project_or_work_item; my_role; tech_used; what_i_built; challenge_or_decision; result_or_learning");
    lines.push("- combined_profile_answer_shape: **Experience**, **Skill Set**, **Projects** when all are requested");
    lines.push("- do_not_include_architecture_diagram_unless_explicitly_asked: true");
  }
  if (answerIntent === "scenario_based" || answerIntent === "system_design") {
    lines.push("- answer_shape: bullets/sections for **Diagnosis:**, **Action plan:**, **Production fix:**, **Trade-off:**, **Recommendation:**");
  }
  if (answerIntent === "code_generation") {
    lines.push("- answer_shape: bullets for **Approach:**, fenced code block, **Reasoning:**, **Complexity/edge cases:**");
  }
  if (answerIntent === "concept_explanation") {
    lines.push("- answer_shape: bullets for **Core idea:**, **Where it is used:**, **Trade-off/example:** when more than 2 sentences are needed");
  }
  if (answerIntent === "general_followup") {
    lines.push("- answer_shape: bullets for **Direct answer:**, **Context:**, **Next point:** when more than 2 sentences are needed");
  }
  if (answerIntent === "general_followup" && Array.isArray(metadata.previousCodeBlocks) && metadata.previousCodeBlocks.length > 0) {
    lines.push("- technical_context: previous answer included code; maintain technical depth, show updated/modified code when the question implies a code change or scenario extension");
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
