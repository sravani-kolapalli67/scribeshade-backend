import test from "node:test";
import assert from "node:assert/strict";
import { routeAIAnswerSessionContext } from "./session-context-router.service";
import type { LatestSuccessfulAnswer } from "./ai-answer-ledger.service";

function latestAnswer(input: {
  id: string;
  question: string;
  answer: string;
  createdAt: Date;
}): LatestSuccessfulAnswer {
  return {
    id: input.id,
    question: input.question,
    answer: input.answer,
    topic: "react",
    createdAt: input.createdAt,
    codeBlocks: [],
    source: "db_ledger",
  };
}

test("short example followup binds to latest successful React hooks answer", () => {
  const latestSuccessfulAnswer = latestAnswer({
    id: "hooks-answer",
    question: "What is useEffect and what is useRef?",
    answer: "useEffect runs side effects and useRef stores mutable refs without rerendering.",
    createdAt: new Date("2026-06-11T10:00:00Z"),
  });

  const decision = routeAIAnswerSessionContext({
    rawInput: "example",
    normalizedInput: "example",
    isCustomQuery: true,
    metadata: { manualQueryType: "short_followup" },
    history: [],
    latestSuccessfulAnswer,
  });

  assert.equal(decision.requestType, "followup");
  assert.equal(decision.bindingSource, "latest_successful_answer");
  assert.equal(decision.targetAnswerId, "hooks-answer");
  assert.equal(decision.targetQuestion, "example");
  assert.equal(decision.boundTarget?.question, "What is useEffect and what is useRef?");
  assert.equal(decision.codeIntentDetected, false);
  assert.equal(decision.codeIntentSuppressedReason, "short_followup_without_explicit_code_request");
});

test("short explain followup targets latest answer instead of older questions", () => {
  const decision = routeAIAnswerSessionContext({
    rawInput: "explain it",
    normalizedInput: "explain it",
    isCustomQuery: true,
    metadata: { manualQueryType: "short_followup" },
    history: [
      {
        id: "old-react",
        question: "What is React?",
        answer: "React is a UI library.",
        timestamp: new Date("2026-06-11T09:00:00Z").getTime(),
        codeBlocks: [],
        topic: "react",
        orderIndex: 0,
      },
    ],
    latestSuccessfulAnswer: latestAnswer({
      id: "hooks-answer",
      question: "What is useEffect and what is useRef?",
      answer: "useEffect runs side effects and useRef stores mutable refs without rerendering.",
      createdAt: new Date("2026-06-11T10:00:00Z"),
    }),
  });

  assert.equal(decision.targetAnswerId, "hooks-answer");
  assert.equal(decision.boundTarget?.question, "What is useEffect and what is useRef?");
  assert.equal(decision.oldQuestionMergeBlocked, true);
});

test("short followup uses transcript fallback only when transcript question is newer", () => {
  const latestSuccessfulAnswer = latestAnswer({
    id: "hooks-answer",
    question: "What is useEffect and what is useRef?",
    answer: "useEffect runs side effects and useRef stores mutable refs without rerendering.",
    createdAt: new Date("2026-06-11T10:00:00Z"),
  });

  const decision = routeAIAnswerSessionContext({
    rawInput: "more",
    normalizedInput: "more",
    isCustomQuery: true,
    metadata: { manualQueryType: "short_followup" },
    transcriptEvidence: {
      lines: [
        {
          speaker: "interviewer",
          text: "What are React hooks?",
          timestamp: new Date("2026-06-11T09:00:00Z").getTime(),
          source: "payload",
        },
      ],
      text: "- interviewer: What are React hooks?",
      compactQuery: "What are React hooks?",
    },
    history: [],
    latestSuccessfulAnswer,
  });

  assert.equal(decision.bindingSource, "latest_successful_answer");
  assert.equal(decision.targetAnswerId, "hooks-answer");
});

test("router classifies expanded live AI answer request intents", () => {
  const cases = [
    {
      input: "Design a notification system for one million events per day",
      expected: "system_design",
    },
    {
      input: "Debug why this code is failing in production",
      expected: "debugging",
    },
    {
      input: "Tell me about your selected project architecture",
      expected: "project_question",
    },
    {
      input: "Walk me through your experience and skill set",
      expected: "resume_question",
    },
    {
      input: "data lake migration approach",
      expected: "partial_evolving",
    },
  ] as const;

  for (const item of cases) {
    const decision = routeAIAnswerSessionContext({
      rawInput: item.input,
      normalizedInput: item.input,
      isCustomQuery: false,
      history: [],
      latestSuccessfulAnswer: null,
    });

    assert.equal(decision.requestType, item.expected);
  }
});
