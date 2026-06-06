import type {
  AnswerLedger,
  IntentLedger,
} from "./question-composer.service";
import type {
  InterviewerTone,
  LiveRequestKind,
  ScenarioEvidencePacket,
  SanitizedLiveRequest,
  TranscriptEvidenceV3,
} from "./ai-answer-context-guards";

export type SessionAskState =
  | "setup_in_progress"
  | "answerable_question"
  | "provisional_guidance"
  | "true_followup"
  | "challenge_or_correction"
  | "topic_switch";

export type CodeTaskMemory = {
  answerId: string;
  question: string;
  language: string;
  codeSummary: string;
  codePreview: string;
  codeHash: string;
  keyFunctions: string[];
  assumptions: string[];
  complexity?: string;
  edgeCases: string[];
  topic: string;
};

export type SessionStateV3 = {
  activeTopic?: string;
  questionChain: string[];
  latestQuestion?: string;
  askState: SessionAskState;
  interviewerTone: InterviewerTone;
  answeredQuestions: Array<{
    answerId: string;
    question: string;
    answerSummary: string;
    topic: string;
  }>;
  codeTaskState?: {
    language?: string;
    problem?: string;
    dataShape?: string;
    latestCodeHash?: string;
  };
  scenarioState?: ScenarioEvidencePacket;
};

export type RoutedAnswerContext = {
  resumeBudget: number;
  projectBudget: number;
  historyBudget: number;
  codeBudget: number;
  scenarioBudget: number;
  documentBudget: number;
  includeResume: boolean;
  includeProjects: boolean;
  includeHistory: boolean;
  includeCodeMemory: boolean;
  includeScenarioMemory: boolean;
  includeDocument: boolean;
};

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
  return (text || "").replace(/\s+/g, " ").trim();
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

function languageFromCode(code: string): string {
  const text = code.toLowerCase();
  if (/\bselect\b|\bfrom\b|\bwhere\b|\bjoin\b/.test(text)) return "sql";
  if (/\bfrom pyspark\b|\bpyspark\b|\bwithcolumn\b|\bwindow\b/.test(text)) return "python/pyspark";
  if (/\bdef\b|\bimport\b/.test(text)) return "python";
  if (/\bconst\b|\blet\b|\bfunction\b|=>/.test(text)) return "javascript/typescript";
  return "text";
}

function extractFunctions(code: string): string[] {
  const matches = [
    ...Array.from(code.matchAll(/\b(?:def|function)\s+([a-zA-Z_][a-zA-Z0-9_]*)/g)).map((match) => match[1]),
    ...Array.from(code.matchAll(/\b(row_number|lag|lead|collect_list|broadcast|groupBy|withColumn|join)\b/g)).map((match) => match[1]),
  ];
  return [...new Set(matches.filter(Boolean))].slice(0, 8);
}

function inferAskState(input: {
  sanitizedRequest: SanitizedLiveRequest;
  transcriptEvidence?: TranscriptEvidenceV3;
}): SessionAskState {
  if (input.sanitizedRequest.kind === "true_followup" || input.sanitizedRequest.kind === "code_followup") {
    return "true_followup";
  }
  if (
    input.sanitizedRequest.interviewerTone === "challenge" ||
    input.sanitizedRequest.interviewerTone === "skeptical"
  ) {
    return "challenge_or_correction";
  }
  if (input.transcriptEvidence?.scenarioDetected) {
    return input.transcriptEvidence.scenarioQuestion ? "answerable_question" : "setup_in_progress";
  }
  if (input.sanitizedRequest.kind === "noise") return "setup_in_progress";
  return "answerable_question";
}

function answerLedgerCodeMemory(answerLedger: AnswerLedger): CodeTaskMemory | undefined {
  const answer = [...(answerLedger.answers || [])].reverse().find((entry) => entry.codeBlocks?.length);
  const codeBlock = answer?.codeBlocks?.[0];
  if (!answer || !codeBlock) return undefined;
  const codePreview = clip(codeBlock.summary || "", 360);
  return {
    answerId: answer.answerId,
    question: answer.question,
    language: codeBlock.language || languageFromCode(codePreview),
    codeSummary: codeBlock.summary || codePreview,
    codePreview,
    codeHash: codeBlock.codeHash,
    keyFunctions: extractFunctions(codePreview),
    assumptions: [],
    edgeCases: [],
    topic: answer.topic,
  };
}

export function buildSessionStateV3(input: {
  sanitizedRequest: SanitizedLiveRequest;
  intentLedger: IntentLedger;
  answerLedger: AnswerLedger;
  transcriptEvidence?: TranscriptEvidenceV3;
  fallbackTopic: string;
}): SessionStateV3 {
  const answeredQuestions = (input.answerLedger.answers || []).slice(-8).map((answer) => ({
    answerId: answer.answerId,
    question: answer.question,
    answerSummary: answer.answerSummary,
    topic: answer.topic,
  }));
  const questionChain = (input.intentLedger.intents || [])
    .slice(-8)
    .map((intent) => intent.question)
    .filter(Boolean);
  const latestQuestion =
    input.transcriptEvidence?.scenarioQuestion ||
    input.transcriptEvidence?.currentQuestionHint ||
    questionChain.at(-1);
  const codeMemory = answerLedgerCodeMemory(input.answerLedger);
  const activeTopic = input.sanitizedRequest.allowPreviousAnswer
    ? answeredQuestions.at(-1)?.topic || input.fallbackTopic || undefined
    : input.fallbackTopic || answeredQuestions.at(-1)?.topic || undefined;

  return {
    activeTopic,
    questionChain,
    ...(latestQuestion ? { latestQuestion } : {}),
    askState: inferAskState({
      sanitizedRequest: input.sanitizedRequest,
      transcriptEvidence: input.transcriptEvidence,
    }),
    interviewerTone: input.sanitizedRequest.interviewerTone,
    answeredQuestions,
    ...(codeMemory
      ? {
          codeTaskState: {
            language: codeMemory.language,
            problem: codeMemory.question,
            dataShape: codeMemory.keyFunctions.join(", "),
            latestCodeHash: codeMemory.codeHash,
          },
        }
      : {}),
    ...(input.transcriptEvidence?.scenarioPacket
      ? { scenarioState: input.transcriptEvidence.scenarioPacket }
      : {}),
  };
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
  const coding = kind === "coding";
  const regenerate = kind === "regenerate";
  const scenario = !coding && (kind === "scenario" || input.cieComplexity === "scenario_based");
  const systemDesign = !coding && input.cieComplexity === "system_design";
  const followup = kind === "true_followup" || kind === "code_followup" || kind === "selected_card_followup";
  const questionText = normalizeSpaces(
    [
      input.question || "",
      input.sessionState.latestQuestion || "",
    ].join(" "),
  ).toLowerCase();
  const asksProjectContext =
    /\b(projects?|portfolio|project work|things you built|worked on|built|developed)\b/.test(questionText);
  const asksProfileContext =
    /\b(experience|skill set|skills|work experience|professional experience|years? of experience|profile|background|introduce yourself)\b/.test(questionText);
  const asksExperienceContext =
    /\b(experience|skill set|skills|work experience|professional experience|years? of experience|profile|background)\b/.test(questionText);
  const profileProjectRequest =
    kind === "project_question" ||
    (input.answerIntent === "behavioral_project_experience" && (asksProjectContext || asksExperienceContext)) ||
    (asksProfileContext && asksProjectContext);
  const project = profileProjectRequest;
  const profile = asksProfileContext || project;
  const simpleAtomic = input.cieComplexity === "simple_atomic";
  const simpleContextual = input.cieComplexity === "simple_contextual";
  const simple = simpleAtomic || simpleContextual;

  return {
    resumeBudget: project || regenerate ? 650 : profile ? 550 : scenario || systemDesign ? 350 : coding ? 120 : simpleContextual ? 250 : simple ? 180 : 300,
    projectBudget: project || regenerate ? 900 : scenario || systemDesign ? 550 : coding ? 0 : simple ? 120 : 250,
    historyBudget: followup ? 450 : scenario || systemDesign ? 260 : 0,
    codeBudget: kind === "code_followup" ? 650 : 0,
    scenarioBudget: scenario ? 450 : 0,
    documentBudget: scenario || systemDesign ? 180 : 0,
    includeResume: input.hasResume && !coding && (project || profile || regenerate || scenario || systemDesign || simpleContextual || !simple),
    includeProjects: input.hasProjects && !coding && (project || regenerate || scenario || systemDesign),
    includeHistory: !coding && !regenerate && (followup || scenario || input.sessionState.askState === "challenge_or_correction"),
    includeCodeMemory: kind === "code_followup" && !!input.sessionState.codeTaskState,
    includeScenarioMemory: scenario && !!input.sessionState.scenarioState,
    includeDocument: input.hasDocument && (scenario || systemDesign),
  };
}

export function applyRoutedAnswerContext(input: {
  context: RuntimeContextForRouting;
  routedContext: RoutedAnswerContext;
}): RoutedRuntimeContext {
  return {
    resume: input.routedContext.includeResume
      ? clipTokens(input.context.resume, input.routedContext.resumeBudget)
      : "",
    projects: input.routedContext.includeProjects
      ? clipTokens(input.context.projects, input.routedContext.projectBudget)
      : "",
    document: input.routedContext.includeDocument
      ? clipTokens(input.context.document, input.routedContext.documentBudget)
      : "",
    history: input.routedContext.includeHistory
      ? clipTokens(input.context.history, input.routedContext.historyBudget)
      : "",
  };
}

export function compactSessionStateForPrompt(input: {
  sessionState: SessionStateV3;
  routedContext: RoutedAnswerContext;
}): string {
  const state = input.sessionState;
  const lines = [
    `Session state: ${state.askState}`,
    `Interviewer tone: ${state.interviewerTone}`,
    state.activeTopic ? `Active topic: ${state.activeTopic}` : "",
    state.latestQuestion ? `Latest question: ${clip(state.latestQuestion, 180)}` : "",
    state.questionChain.length
      ? `Question chain: ${state.questionChain.slice(-4).map((question) => clip(question, 90)).join(" -> ")}`
      : "",
  ];
  if (input.routedContext.includeScenarioMemory && state.scenarioState) {
    lines.push(
      `Scenario: ${state.scenarioState.domain}; ask=${clip(state.scenarioState.finalAsk, 120)}`,
      state.scenarioState.numbers.length ? `Scenario numbers: ${state.scenarioState.numbers.join(", ")}` : "",
      state.scenarioState.constraints.length ? `Scenario constraints: ${state.scenarioState.constraints.join("; ")}` : "",
    );
  }
  if (input.routedContext.includeCodeMemory && state.codeTaskState) {
    lines.push(
      `Code memory: ${state.codeTaskState.language || "unknown"}; ${clip(state.codeTaskState.problem || "", 160)}`,
      state.codeTaskState.latestCodeHash ? `Code hash: ${state.codeTaskState.latestCodeHash}` : "",
    );
  }
  if (input.routedContext.includeHistory && state.answeredQuestions.length) {
    lines.push(
      `Prior answer: ${clip(state.answeredQuestions.at(-1)?.answerSummary || "", 220)}`,
    );
  }
  return lines.filter(Boolean).join("\n");
}
