import type {
  MemoryDocType,
  RoutedAnswerContext,
  SanitizedLiveRequest,
  SessionStateV3,
} from "../session-intelligence.types";

export type RuntimeContextForRouting = {
  resume?: string | null;
  projects?: string | null;
  document?: string | null;
  history?: string | null;
};

export type RoutedRuntimeContext = {
  resume: string;
  projects: string;
  document: string;
  history: string;
};

function normalizeSpaces(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function clip(text: string, maxChars: number): string {
  const normalized = normalizeSpaces(text);
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 3)).trim()}...`;
}

function clipTokens(text: string | null | undefined, tokenBudget: number): string {
  if (tokenBudget <= 0) return "";
  return clip(text || "", tokenBudget * 4);
}

function allMemoryTypes(): MemoryDocType[] {
  return [
    "transcript_turn",
    "clean_question",
    "qa_summary",
    "code_task",
    "code_block",
    "scenario_packet",
    "candidate_fact",
    "project_fact",
    "resume_fact",
    "interviewer_challenge",
  ];
}

function retrievalTypes(input: {
  request: SanitizedLiveRequest;
  includeResume: boolean;
  includeProjects: boolean;
  includeHistory: boolean;
  includeCodeMemory: boolean;
  includeScenarioMemory: boolean;
}): MemoryDocType[] {
  const types: MemoryDocType[] = ["clean_question"];
  if (input.includeHistory) {
    types.push("transcript_turn", "qa_summary");
  }
  if (input.includeCodeMemory) {
    types.push("code_task", "code_block");
  }
  if (input.includeScenarioMemory) {
    types.push("scenario_packet");
  }
  if (input.includeProjects) {
    types.push("project_fact");
  }
  if (input.includeResume) {
    types.push("candidate_fact", "resume_fact");
  }
  if (input.request.kind === "challenge_or_correction") {
    types.push("interviewer_challenge");
  }
  return [...new Set(types)];
}

export function routeAnswerContextV3(input: {
  sanitizedRequest: SanitizedLiveRequest;
  sessionState: SessionStateV3;
  cieComplexity?: string;
  answerIntent?: string;
  question?: string;
  hasResume: boolean;
  hasProjects: boolean;
  hasDocument: boolean;
}): RoutedAnswerContext {
  const kind = input.sanitizedRequest.kind;
  const coding = kind === "code_generation";
  const regenerate = kind === "regenerate";
  const scenario =
    !coding &&
    (kind === "scenario" || input.cieComplexity === "scenario_based");
  const systemDesign =
    !coding && input.cieComplexity === "system_design";
  const followup =
    kind === "true_followup" ||
    kind === "code_followup" ||
    kind === "selected_card_followup" ||
    kind === "challenge_or_correction";
  const questionText = normalizeSpaces(
    [
      input.question || "",
      input.sessionState.latestCleanQuestion || "",
    ].join(" "),
  ).toLowerCase();
  const asksProjectContext =
    /\b(projects?|portfolio|project work|things you built|worked on|built|developed)\b/.test(
      questionText,
    );
  const asksProfileContext =
    /\b(experience|skill set|skills|work experience|professional experience|years? of experience|profile|background|introduce yourself|education|educational|academic|degree|qualification|college|university)\b/.test(
      questionText,
    );
  const profileProjectRequest =
    kind === "project_question" ||
    (input.answerIntent === "behavioral_project_experience" &&
      asksProjectContext) ||
    (asksProfileContext && asksProjectContext);
  const project =
    input.sanitizedRequest.allowProjectContext && profileProjectRequest;
  const profile = asksProfileContext || project;
  const simpleAtomic = input.cieComplexity === "simple_atomic";
  const simpleContextual = input.cieComplexity === "simple_contextual";
  const simple = simpleAtomic || simpleContextual;
  const includeResume =
    input.hasResume &&
    !coding &&
    (project ||
      profile ||
      regenerate ||
      scenario ||
      systemDesign ||
      simpleContextual ||
      !simple);
  const includeProjects =
    input.hasProjects &&
    !coding &&
    input.sanitizedRequest.allowProjectContext &&
    (project || regenerate || scenario || systemDesign);
  const includeHistory =
    input.sanitizedRequest.allowHistory &&
    !coding &&
    !regenerate &&
    (followup || scenario);
  const includeCodeMemory =
    input.sanitizedRequest.allowCodeMemory &&
    kind === "code_followup" &&
    Boolean(input.sessionState.codeTaskState);
  const includeScenarioMemory =
    scenario && Boolean(input.sessionState.scenarioState);
  const includeDocuments =
    input.hasDocument && (scenario || systemDesign);
  const budgets = {
    resume:
      project || regenerate
        ? 650
        : profile
          ? 550
          : scenario || systemDesign
            ? 350
            : coding
              ? 0
              : simpleContextual
                ? 250
                : simple
                  ? 180
                  : 300,
    projects:
      project || regenerate
        ? 900
        : scenario || systemDesign
          ? 550
          : 0,
    history: followup ? 450 : scenario || systemDesign ? 260 : 0,
    code: kind === "code_followup" ? 650 : 0,
    scenario: scenario ? 450 : 0,
    documents: scenario || systemDesign ? 180 : 0,
    total: 0,
  };
  budgets.total =
    budgets.resume +
    budgets.projects +
    budgets.history +
    budgets.code +
    budgets.scenario +
    budgets.documents;
  const retrieveTypes = retrievalTypes({
    request: input.sanitizedRequest,
    includeResume,
    includeProjects,
    includeHistory,
    includeCodeMemory,
    includeScenarioMemory,
  });
  const retrieveTypeSet = new Set(retrieveTypes);

  return {
    includeResume,
    includeProjects,
    includeHistory,
    includeCodeMemory,
    includeScenarioMemory,
    includeDocuments,
    budgets,
    retrieveTypes,
    excludeTypes: allMemoryTypes().filter(
      (type) => !retrieveTypeSet.has(type),
    ),
    topicFilters: input.sessionState.activeTopic
      ? [input.sessionState.activeTopic]
      : [],
    trustFilter:
      input.sanitizedRequest.answerTrust === "strong"
        ? ["strong"]
        : ["weak", "strong"],
  };
}

export function applyContextRouterV3(input: {
  context: RuntimeContextForRouting;
  routedContext: RoutedAnswerContext;
}): RoutedRuntimeContext {
  return {
    resume: input.routedContext.includeResume
      ? clipTokens(input.context.resume, input.routedContext.budgets.resume)
      : "",
    projects: input.routedContext.includeProjects
      ? clipTokens(input.context.projects, input.routedContext.budgets.projects)
      : "",
    document: input.routedContext.includeDocuments
      ? clipTokens(
          input.context.document,
          input.routedContext.budgets.documents,
        )
      : "",
    history: input.routedContext.includeHistory
      ? clipTokens(input.context.history, input.routedContext.budgets.history)
      : "",
  };
}
