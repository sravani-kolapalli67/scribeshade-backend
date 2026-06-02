import type { AIAnswerLiveContextMetadata } from "./ai-answer.dto";
import {
  getCandidateDigestForAnswer,
  type CandidateContextDigestValue,
} from "./candidate-digest.service";
import { decideAnswer, type AnswerDecision } from "./answer-decision.service";
import {
  reconstructQuestion,
  type ReconstructedQuestion,
} from "./question-reconstructor.service";
import {
  mergeNormalizedBlocks,
  normalizeTranscriptForAI,
  type NormalizedTranscriptBlock,
} from "./transcript-normalizer.service";
import {
  getActiveTopicMemory,
  type ActiveTopicMemory,
} from "./topic-memory.service";
import {
  getRelevantTurnMemory,
  type TurnMemoryEntry,
} from "./turn-memory.service";

export type QuestionMetaCorrection = {
  from: string;
  to: string;
  reason: string;
};

export type QuestionMeta = {
  displayQuestion: string;
  intent: string;
  confidence: number;
  topic: string;
  isFollowUp: boolean;
  shouldAnswer: boolean;
  source: string;
  corrections: QuestionMetaCorrection[];
};

export type ContextOrchestrationResult = {
  normalizedTranscript: string;
  normalizedBlocks: NormalizedTranscriptBlock[];
  reconstructedQuestion: ReconstructedQuestion;
  decision: AnswerDecision;
  questionMeta: QuestionMeta;
  candidateDigest: CandidateContextDigestValue;
  activeTopic: ActiveTopicMemory | null;
  turnMemory: TurnMemoryEntry[];
  contextPacket: string;
};

type OrchestrateAIContextInput = {
  sessionId: string;
  resolvedQuestion: string;
  metadata?: AIAnswerLiveContextMetadata;
};

function normalizeSpaces(text: string): string {
  return (text || "").replace(/\s+/g, " ").trim();
}

function formatCandidateDigest(digest: CandidateContextDigestValue): string {
  const projectLines = digest.projectCards
    .slice(0, 4)
    .map((card) => {
      const stack = card.stack.length ? ` stack=${card.stack.join(", ")}` : "";
      const role = card.role ? ` role=${card.role}` : "";
      const impact = card.impact ? ` impact=${card.impact}` : "";
      return `- ${card.name}${stack}${role}${impact}`;
    });
  return [
    `CANDIDATE DIGEST STATUS: ${digest.status}`,
    `Resume digest: ${digest.resumeDigest.slice(0, 1200)}`,
    digest.skills.length ? `Skills: ${digest.skills.slice(0, 30).join(", ")}` : "",
    projectLines.length ? `Projects:\n${projectLines.join("\n")}` : "",
    digest.experienceFacts.length
      ? `Experience facts:\n${digest.experienceFacts.slice(0, 6).map((fact) => `- ${fact}`).join("\n")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function formatTopicMemory(topic: ActiveTopicMemory | null): string {
  if (!topic) return "No active topic memory.";
  return [
    `Topic: ${topic.topicTitle}`,
    topic.topicKeywords.length ? `Keywords: ${topic.topicKeywords.join(", ")}` : "",
    `Summary: ${topic.currentSummary}`,
    topic.lastQuestion ? `Last question: ${topic.lastQuestion}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function formatTurnMemory(turnMemory: TurnMemoryEntry[]): string {
  if (turnMemory.length === 0) return "No compact turn memory.";
  return turnMemory
    .slice(0, 3)
    .map((entry, index) => {
      const codeNote = entry.codeBlocks.length
        ? `\n  Code blocks:\n${entry.codeBlocks
            .slice(0, 2)
            .map((block, blockIndex) => `  Code ${blockIndex + 1}:\n\`\`\`\n${block.slice(0, 1200)}\n\`\`\``)
            .join("\n")}`
        : "";
      return `Turn ${index + 1}: ${entry.questionClean}\n  Summary: ${entry.answerSummary.slice(0, 500)}${codeNote}`;
    })
    .join("\n\n");
}

function collectCorrections(blocks: NormalizedTranscriptBlock[]): QuestionMetaCorrection[] {
  return blocks.flatMap((block) => block.corrections).slice(0, 12);
}

function questionSource(metadata?: AIAnswerLiveContextMetadata): string {
  const source = (metadata?.activeQuestionDetection as any)?.source;
  return typeof source === "string" && source.trim() ? source : "backend_reconstruction";
}

function buildContextPacket(input: {
  reconstructedQuestion: ReconstructedQuestion;
  decision: AnswerDecision;
  candidateDigest: CandidateContextDigestValue;
  activeTopic: ActiveTopicMemory | null;
  turnMemory: TurnMemoryEntry[];
}): string {
  return [
    "STRICT CONTEXT PACKET:",
    `CURRENT QUESTION: ${input.decision.questionForLLM}`,
    `QUESTION INTENT: ${input.reconstructedQuestion.intent}`,
    `ANSWER DECISION: ${input.decision.reason}`,
    "",
    "QUESTION EVIDENCE:",
    input.reconstructedQuestion.rawEvidence.map((line) => `- ${line}`).join("\n") || "- none",
    "",
    "CANDIDATE CONTEXT:",
    formatCandidateDigest(input.candidateDigest),
    "",
    "ACTIVE TOPIC MEMORY:",
    formatTopicMemory(input.activeTopic),
    "",
    "RECENT TURN MEMORY:",
    formatTurnMemory(input.turnMemory),
    "",
    "HARD RULE: Answer only the CURRENT QUESTION above. Do not invent or merge another question.",
  ].join("\n");
}

export async function orchestrateAIContext(
  input: OrchestrateAIContextInput,
): Promise<ContextOrchestrationResult> {
  const [activeTopic, candidateDigest] = await Promise.all([
    getActiveTopicMemory(input.sessionId),
    getCandidateDigestForAnswer(input.sessionId),
  ]);
  const dictionaryTerms = [
    ...candidateDigest.skills,
    ...candidateDigest.domainKeywords,
    ...candidateDigest.projectCards.map((card) => card.name),
  ];
  const activeTopicKeywords = activeTopic?.topicKeywords || [];
  const confidence =
    input.metadata?.activeQuestionDetection?.confidenceScore ??
    (input.resolvedQuestion.trim() ? 0.62 : 0);
  const normalizedBlocks = normalizeTranscriptForAI({
    rawText: input.resolvedQuestion,
    metadata: input.metadata,
    dictionaryTerms,
    activeTopicKeywords,
    confidence,
  });
  const normalizedTranscript = mergeNormalizedBlocks(normalizedBlocks);
  const reconstructedQuestion = reconstructQuestion({
    normalizedBlocks,
    fallbackQuestion: normalizedTranscript || input.resolvedQuestion,
    metadata: input.metadata,
    activeTopic,
  });
  const decision = decideAnswer({
    reconstructedQuestion,
    activeTopic,
    selectedAnswerPresent: Boolean(
      input.metadata?.selectedAnswerId ||
        input.metadata?.selectedAnswerText ||
        input.metadata?.selectedAnswerCodeBlocks?.length,
    ),
  });

  const turnMemory = decision.shouldAnswer
    ? await getRelevantTurnMemory({
        sessionId: input.sessionId,
        question: reconstructedQuestion.llmQuestion,
        followupTargetId: reconstructedQuestion.followupTargetId,
        limit: 3,
      })
    : [];
  const questionMeta: QuestionMeta = {
    displayQuestion: reconstructedQuestion.displayQuestion,
    intent: reconstructedQuestion.intent,
    confidence: reconstructedQuestion.confidence,
    topic: normalizeSpaces(activeTopic?.topicTitle || reconstructedQuestion.topicId || "general"),
    isFollowUp: reconstructedQuestion.isFollowUp,
    shouldAnswer: decision.shouldAnswer,
    source: questionSource(input.metadata),
    corrections: collectCorrections(normalizedBlocks),
  };

  return {
    normalizedTranscript,
    normalizedBlocks,
    reconstructedQuestion,
    decision,
    questionMeta,
    candidateDigest,
    activeTopic,
    turnMemory,
    contextPacket: buildContextPacket({
      reconstructedQuestion,
      decision,
      candidateDigest,
      activeTopic,
      turnMemory,
    }),
  };
}
