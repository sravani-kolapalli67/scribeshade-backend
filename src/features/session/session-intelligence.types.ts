import type { AIAnswerLiveContextMetadata } from "./ai-answer.dto";

export type AnswerTrust = "none" | "weak" | "strong";

export type AnswerKind =
  | "provisional"
  | "final"
  | "followup"
  | "regenerate"
  | "correction";

export type LiveRequestKind =
  | "latest_question"
  | "true_followup"
  | "selected_card_followup"
  | "regenerate"
  | "code_generation"
  | "code_followup"
  | "scenario"
  | "project_question"
  | "challenge_or_correction"
  | "provisional_guidance"
  | "noise";

export type InterviewerTone =
  | "neutral"
  | "clarification"
  | "deep_dive"
  | "challenge"
  | "skeptical"
  | "stress_test"
  | "urgency";

export type ScenarioEvidencePacket = {
  detected: boolean;
  domain: string;
  actors: string[];
  constraints: string[];
  numbers: string[];
  failureSymptom?: string;
  finalAsk: string;
  transcriptLines: string[];
  compactQuery: string;
};

export type SanitizedLiveRequest = {
  kind: LiveRequestKind;
  effectiveAnswerClickMode: string;
  metadata: AIAnswerLiveContextMetadata;
  latestQuestionHint?: string;
  clearReason?: string;
  allowSelectedAnswer: boolean;
  allowPreviousAnswer: boolean;
  allowPreviousAnswers: boolean;
  allowCodeMemory: boolean;
  allowProjectContext: boolean;
  allowHistory: boolean;
  answerKind: AnswerKind;
  answerTrust: AnswerTrust;
  interviewerTone: InterviewerTone;
  scenarioDetected: boolean;
  scenarioPacket?: ScenarioEvidencePacket;
};

export type SessionAskState =
  | "setup_in_progress"
  | "answerable_question"
  | "provisional_guidance"
  | "true_followup"
  | "challenge_or_correction"
  | "topic_switch"
  | "code_task";

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
  sessionId: string;
  activeTopic?: string;
  latestCleanQuestion?: string;
  questionChain: string[];
  askState: SessionAskState;
  interviewerTone: InterviewerTone;
  activeScenarioId?: string;
  activeCodeTaskId?: string;
  activeFollowupTargetId?: string;
  updatedAt: string;
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

export type MemoryDocType =
  | "transcript_turn"
  | "clean_question"
  | "qa_summary"
  | "code_task"
  | "code_block"
  | "scenario_packet"
  | "candidate_fact"
  | "project_fact"
  | "resume_fact"
  | "interviewer_challenge";

export type MemoryDoc = {
  id: string;
  sessionId: string;
  userId: string;
  type: MemoryDocType;
  topic: string;
  text: string;
  speaker?: "interviewer" | "candidate" | "assistant";
  timestamp: string;
  trust: Exclude<AnswerTrust, "none">;
  answerId?: string;
  projectId?: string;
  codeHash?: string;
  embedding: number[];
};

export type ContextBudgets = {
  resume: number;
  projects: number;
  history: number;
  code: number;
  scenario: number;
  documents: number;
  total: number;
};

export type RoutedAnswerContext = {
  includeResume: boolean;
  includeProjects: boolean;
  includeHistory: boolean;
  includeCodeMemory: boolean;
  includeScenarioMemory: boolean;
  includeDocuments: boolean;
  budgets: ContextBudgets;
  retrieveTypes: MemoryDocType[];
  excludeTypes: MemoryDocType[];
  topicFilters: string[];
  trustFilter: Array<Exclude<AnswerTrust, "none">>;
};

export type AnswerValidationResult = {
  persistCard: boolean;
  updateMemory: boolean;
  trust: AnswerTrust;
  reasons: string[];
};
