import test from "node:test";
import assert from "node:assert/strict";
import type { AIAnswerLiveContextMetadata } from "./ai-answer.dto";
import type { TranscriptEvidenceV3 } from "./ai-answer-context-guards";
import { buildCodeTaskMemory } from "./memory/code-task-memory.service";
import {
  sessionMemoryV3Key,
  sessionStateV3Key,
} from "./memory/session-memory.keys";
import {
  applyLiveRequestToSessionStateV3,
  buildSessionStateV3,
} from "./session-intelligence.service";
import type { LiveRequestKind } from "./session-intelligence.types";
import { sanitizeLiveRequestContextV4 } from "./state/live-request-sanitizer-v4";
import { buildScenarioEvidencePacket } from "./transcript/scenario-evidence-builder";

type AcceptanceCase = {
  name: string;
  question: string;
  metadata?: AIAnswerLiveContextMetadata;
  scenarioDetected?: boolean;
  isRegenerate?: boolean;
  expectedKind: LiveRequestKind;
  expectedTrust: "none" | "weak" | "strong";
};

function evidence(input: {
  question: string;
  scenarioDetected: boolean;
}): TranscriptEvidenceV3 {
  return {
    lines: input.question
      ? [
          {
            speaker: "interviewer",
            text: input.question,
            source: "payload",
          },
        ]
      : [],
    text: input.question,
    compactQuery: input.question,
    currentQuestionHint: input.question || undefined,
    scenarioDetected: input.scenarioDetected,
    ...(input.scenarioDetected
      ? {
          scenarioQuestion: input.question,
          scenarioPacket: {
            detected: true,
            domain: "ecommerce",
            actors: ["customers"],
            constraints: ["inventory must not go negative"],
            numbers: ["5"],
            finalAsk: input.question,
            transcriptLines: [input.question],
            compactQuery: input.question,
          },
        }
      : {}),
  };
}

const acceptanceCases: AcceptanceCase[] = [
  {
    name: "fresh question",
    question: "What is dependency injection?",
    expectedKind: "latest_question",
    expectedTrust: "strong",
  },
  {
    name: "true followup",
    question: "Can you explain more about that decision?",
    metadata: {
      activeQuestionDetection: {
        activeQuestion: "Can you explain more about that decision?",
        cleanedQuestion: "Can you explain more about that decision?",
        isFollowUp: true,
        topicChanged: false,
        confidenceScore: 0.9,
        ignoredNoise: false,
      },
      previousAiAnswer: "Use dependency injection for testability.",
    },
    expectedKind: "true_followup",
    expectedTrust: "strong",
  },
  {
    name: "selected followup",
    question: "Can you elaborate on that answer?",
    metadata: {
      answerClickMode: "answer_followup",
      selectedAnswerId: "answer-1",
      selectedAnswerText: "Use a queue.",
    },
    expectedKind: "selected_card_followup",
    expectedTrust: "strong",
  },
  {
    name: "regenerate",
    question: "Explain Redis.",
    metadata: {
      answerClickMode: "regenerate_answer",
      selectedAnswerId: "answer-2",
    },
    isRegenerate: true,
    expectedKind: "regenerate",
    expectedTrust: "strong",
  },
  {
    name: "code generation",
    question: "Write TypeScript code for an LRU cache.",
    expectedKind: "code_generation",
    expectedTrust: "strong",
  },
  {
    name: "code followup",
    question: "Optimize the previous code and explain its edge cases.",
    metadata: {
      activeQuestionDetection: {
        activeQuestion: "Optimize the previous code and explain its edge cases.",
        cleanedQuestion: "Optimize the previous code and explain its edge cases.",
        isFollowUp: true,
        topicChanged: false,
        confidenceScore: 0.9,
        ignoredNoise: false,
      },
      previousCodeBlocks: ["const cache = new Map();"],
    },
    expectedKind: "code_followup",
    expectedTrust: "strong",
  },
  {
    name: "scenario",
    question: "Inventory is 5 and concurrent orders make it negative. How would you fix it?",
    scenarioDetected: true,
    expectedKind: "scenario",
    expectedTrust: "strong",
  },
  {
    name: "project question",
    question: "Explain the architecture of the project you built.",
    expectedKind: "project_question",
    expectedTrust: "strong",
  },
  {
    name: "challenge",
    question: "Are you sure that query is correct?",
    expectedKind: "challenge_or_correction",
    expectedTrust: "strong",
  },
  {
    name: "provisional setup",
    question: "Let me explain the setup first",
    expectedKind: "provisional_guidance",
    expectedTrust: "weak",
  },
  {
    name: "noise",
    question: "okay",
    expectedKind: "noise",
    expectedTrust: "none",
  },
  {
    name: "topic switch",
    question: "What is React?",
    metadata: {
      activeQuestionDetection: {
        activeQuestion: "What is React?",
        cleanedQuestion: "What is React?",
        isFollowUp: false,
        topicChanged: true,
        confidenceScore: 0.9,
        ignoredNoise: false,
      },
    },
    expectedKind: "latest_question",
    expectedTrust: "strong",
  },
  {
    name: "stale metadata",
    question: "Explain Python generators.",
    metadata: {
      answerClickMode: "answer_latest_unanswered",
      selectedAnswerId: "react-answer",
      previousAiAnswer: "React useRef answer.",
    },
    expectedKind: "latest_question",
    expectedTrust: "strong",
  },
  {
    name: "missing state",
    question: "What is PostgreSQL?",
    expectedKind: "latest_question",
    expectedTrust: "strong",
  },
  {
    name: "missing vector",
    question: "Explain eventual consistency.",
    expectedKind: "latest_question",
    expectedTrust: "strong",
  },
  {
    name: "validation failure input",
    question: "Explain SQL joins.",
    expectedKind: "latest_question",
    expectedTrust: "strong",
  },
  {
    name: "selected code followup",
    question: "Debug this code.",
    metadata: {
      answerClickMode: "answer_followup",
      selectedAnswerId: "code-answer",
      selectedAnswerCodeBlocks: ["function run() {}"],
    },
    expectedKind: "code_followup",
    expectedTrust: "strong",
  },
  {
    name: "fresh code overrides project wording",
    question: "In my project, write code for a React hook.",
    metadata: {
      previousAiAnswer: "Earlier project architecture.",
    },
    expectedKind: "code_generation",
    expectedTrust: "strong",
  },
];

test("Session-State-First acceptance matrix covers 18 routing cases", () => {
  assert.equal(acceptanceCases.length, 18);
  for (const acceptanceCase of acceptanceCases) {
    const result = sanitizeLiveRequestContextV4({
      metadata: acceptanceCase.metadata,
      transcriptEvidence: evidence({
        question: acceptanceCase.question,
        scenarioDetected: acceptanceCase.scenarioDetected === true,
      }),
      isRegenerate: acceptanceCase.isRegenerate === true,
    });
    assert.equal(
      result.kind,
      acceptanceCase.expectedKind,
      acceptanceCase.name,
    );
    assert.equal(
      result.answerTrust,
      acceptanceCase.expectedTrust,
      acceptanceCase.name,
    );
  }
});

test("SessionStateV3 uses versioned Redis keys and marks topic switches", () => {
  const request = sanitizeLiveRequestContextV4({
    metadata: acceptanceCases[11].metadata,
    transcriptEvidence: evidence({
      question: acceptanceCases[11].question,
      scenarioDetected: false,
    }),
    isRegenerate: false,
  });
  const state = buildSessionStateV3({
    sessionId: "session-123",
    sanitizedRequest: request,
    intentLedger: { intents: [] },
    answerLedger: { answers: [] },
    fallbackTopic: "react",
  });
  assert.equal(sessionStateV3Key("session-123"), "session:session-123:state:v3");
  assert.equal(sessionMemoryV3Key("session-123"), "session:session-123:memory:v3");
  assert.equal(state.askState, "topic_switch");
});

test("current request overlays stale cached SessionStateV3 without mutating memory", () => {
  const request = sanitizeLiveRequestContextV4({
    transcriptEvidence: evidence({
      question: "Write TypeScript code for a debounce utility.",
      scenarioDetected: false,
    }),
    isRegenerate: false,
  });
  const cachedState = buildSessionStateV3({
    sessionId: "session-123",
    sanitizedRequest: sanitizeLiveRequestContextV4({
      metadata: acceptanceCases[1].metadata,
      transcriptEvidence: evidence({
        question: acceptanceCases[1].question,
        scenarioDetected: false,
      }),
      isRegenerate: false,
    }),
    intentLedger: { intents: [] },
    answerLedger: { answers: [] },
    fallbackTopic: "behavioral",
  });
  const requestState = applyLiveRequestToSessionStateV3({
    state: cachedState,
    sanitizedRequest: request,
    transcriptEvidence: evidence({
      question: "Write TypeScript code for a debounce utility.",
      scenarioDetected: false,
    }),
    fallbackTopic: "typescript",
  });

  assert.equal(requestState.askState, "code_task");
  assert.equal(requestState.activeTopic, "typescript");
  assert.match(requestState.latestCleanQuestion || "", /debounce/i);
  assert.equal(cachedState.askState, "true_followup");
});

test("old code turns cannot classify a later database followup as code generation", () => {
  const result = sanitizeLiveRequestContextV4({
    metadata: {
      activeQuestionDetection: {
        activeQuestion:
          "Continue from the database part and justify indexing choices.",
        cleanedQuestion:
          "Continue from the database part and justify indexing choices.",
        isFollowUp: true,
        topicChanged: false,
        confidenceScore: 1,
        ignoredNoise: false,
      },
    },
    transcriptEvidence: {
      lines: [
        {
          speaker: "interviewer",
          text: "Write TypeScript code for a debounce utility.",
          source: "payload",
        },
        {
          speaker: "interviewer",
          text: "Continue from the database part and justify indexing choices.",
          source: "payload",
        },
      ],
      text:
        "Write TypeScript code for a debounce utility. Continue from the database part and justify indexing choices.",
      compactQuery:
        "Write TypeScript code for a debounce utility. Continue from the database part and justify indexing choices.",
      currentQuestionHint:
        "Continue from the database part and justify indexing choices.",
    },
    isRegenerate: false,
  });

  assert.equal(result.kind, "challenge_or_correction");
  assert.notEqual(result.kind, "code_generation");
});

test("scenario and code memory builders preserve scoped evidence", () => {
  const scenario = buildScenarioEvidencePacket({
    lines: [
      {
        speaker: "interviewer",
        text: "Suppose inventory has 5 items and concurrent orders make it negative.",
        source: "payload",
      },
      {
        speaker: "interviewer",
        text: "How would you prevent overselling?",
        source: "payload",
      },
    ],
    currentQuestionHint: "How would you prevent overselling?",
  });
  const codeTask = buildCodeTaskMemory({
    answerId: "answer-code",
    question: "Write a cache.",
    answer: "```ts\nfunction getValue(key: string) { return cache.get(key); }\n```",
    topic: "typescript",
    explicitCodeTask: true,
  });
  const unrelatedCode = buildCodeTaskMemory({
    answerId: "answer-text",
    question: "Explain caching.",
    answer: "```ts\nconst cache = new Map();\n```",
    topic: "caching",
    explicitCodeTask: false,
  });

  assert.ok(scenario?.numbers.some((number) => number.includes("5")));
  assert.equal(codeTask?.language, "ts");
  assert.ok(codeTask?.keyFunctions.includes("getValue"));
  assert.equal(unrelatedCode, null);
});
