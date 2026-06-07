import type {
  AnswerLedger,
  IntentLedger,
} from "./question-composer.service";
import type {
  TranscriptEvidenceV3,
} from "./ai-answer-context-guards";
import type {
  CodeTaskMemory,
  RoutedAnswerContext,
  SanitizedLiveRequest,
  SessionAskState,
  SessionStateV3,
} from "./session-intelligence.types";

export type {
  CodeTaskMemory,
  SessionStateV3,
} from "./session-intelligence.types";

function normalizeSpaces(text: string): string {
  return (text || "").replace(/\s+/g, " ").trim();
}

function clip(text: string, maxChars: number): string {
  const normalized = normalizeSpaces(text);
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 3)).trim()}...`;
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
  if (
    input.sanitizedRequest.kind === "code_generation" ||
    input.sanitizedRequest.kind === "code_followup"
  ) {
    return "code_task";
  }
  if (input.sanitizedRequest.kind === "provisional_guidance") {
    return "provisional_guidance";
  }
  if (input.sanitizedRequest.kind === "true_followup") {
    return "true_followup";
  }
  if (
    input.sanitizedRequest.kind === "challenge_or_correction" ||
    input.sanitizedRequest.interviewerTone === "challenge" ||
    input.sanitizedRequest.interviewerTone === "skeptical"
  ) {
    return "challenge_or_correction";
  }
  if (input.sanitizedRequest.metadata.activeQuestionDetection?.topicChanged) {
    return "topic_switch";
  }
  if (input.transcriptEvidence?.scenarioDetected) {
    return input.transcriptEvidence.scenarioQuestion ? "answerable_question" : "setup_in_progress";
  }
  if (input.sanitizedRequest.kind === "noise") return "setup_in_progress";
  return "answerable_question";
}

export function applyLiveRequestToSessionStateV3(input: {
  state: SessionStateV3;
  sanitizedRequest: SanitizedLiveRequest;
  transcriptEvidence?: TranscriptEvidenceV3;
  fallbackTopic: string;
}): SessionStateV3 {
  const latestCleanQuestion =
    input.sanitizedRequest.latestQuestionHint ||
    input.transcriptEvidence?.scenarioQuestion ||
    input.transcriptEvidence?.currentQuestionHint ||
    input.state.latestCleanQuestion;
  const activeTopic =
    input.fallbackTopic && input.fallbackTopic !== "general"
      ? input.fallbackTopic
      : input.state.activeTopic;

  return {
    ...input.state,
    ...(activeTopic ? { activeTopic } : {}),
    ...(latestCleanQuestion ? { latestCleanQuestion } : {}),
    askState: inferAskState({
      sanitizedRequest: input.sanitizedRequest,
      transcriptEvidence: input.transcriptEvidence,
    }),
    interviewerTone: input.sanitizedRequest.interviewerTone,
    activeFollowupTargetId: input.sanitizedRequest.allowSelectedAnswer
      ? input.sanitizedRequest.metadata.selectedAnswerId
      : undefined,
  };
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
  sessionId: string;
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
  const latestCleanQuestion =
    input.transcriptEvidence?.scenarioQuestion ||
    input.transcriptEvidence?.currentQuestionHint ||
    questionChain.at(-1);
  const codeMemory = answerLedgerCodeMemory(input.answerLedger);
  const activeTopic = input.sanitizedRequest.allowPreviousAnswer
    ? answeredQuestions.at(-1)?.topic || input.fallbackTopic || undefined
    : input.fallbackTopic || answeredQuestions.at(-1)?.topic || undefined;

  return {
    sessionId: input.sessionId,
    activeTopic,
    questionChain,
    ...(latestCleanQuestion ? { latestCleanQuestion } : {}),
    askState: inferAskState({
      sanitizedRequest: input.sanitizedRequest,
      transcriptEvidence: input.transcriptEvidence,
    }),
    interviewerTone: input.sanitizedRequest.interviewerTone,
    ...(input.sanitizedRequest.metadata.selectedAnswerId
      ? {
          activeFollowupTargetId:
            input.sanitizedRequest.metadata.selectedAnswerId,
        }
      : {}),
    updatedAt: new Date().toISOString(),
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

export function compactSessionStateForPrompt(input: {
  sessionState: SessionStateV3;
  routedContext: RoutedAnswerContext;
}): string {
  const state = input.sessionState;
  const lines = [
    `Session state: ${state.askState}`,
    `Interviewer tone: ${state.interviewerTone}`,
    state.activeTopic ? `Active topic: ${state.activeTopic}` : "",
    state.latestCleanQuestion
      ? `Latest question: ${clip(state.latestCleanQuestion, 180)}`
      : "",
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
