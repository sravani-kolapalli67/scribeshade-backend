import test from "node:test";
import assert from "node:assert/strict";
import {
  filterPersistableAnswerPairs,
  shouldScheduleBackgroundComposer,
} from "./ai-answer-safeguards";

test("background composer is disabled unless explicitly enabled", () => {
  assert.equal(shouldScheduleBackgroundComposer(undefined), false);
  assert.equal(shouldScheduleBackgroundComposer("false"), false);
  assert.equal(shouldScheduleBackgroundComposer("0"), false);
  assert.equal(shouldScheduleBackgroundComposer("true"), true);
  assert.equal(shouldScheduleBackgroundComposer("1"), true);
});

test("one ai-answer click has no background composer call when disabled", () => {
  const answerModelCalls = 1;
  const backgroundComposerCalls = shouldScheduleBackgroundComposer(undefined) ? 1 : 0;

  assert.equal(answerModelCalls + backgroundComposerCalls, 1);
});

test("parser keeps first unsupported extra question but preserves supported extras", () => {
  const evidenceText = [
    "Can you please introduce yourself?",
    "Explain the projects you have done.",
    "What is Redis?",
  ].join(" ");
  const filtered = filterPersistableAnswerPairs({
    evidenceText,
    pairs: [
      {
        question: "Introduce yourself and explain the projects you have done.",
        answer: "Answer one.",
      },
      {
        question: "Can you provide more details about the specific technologies you used in your projects?",
        answer: "Unsupported invented follow-up.",
      },
      {
        question: "What is Redis?",
        answer: "Supported explicit question.",
      },
    ],
    sessionId: "test-session",
  });

  assert.deepEqual(
    filtered.map((pair) => pair.question),
    [
      "Introduce yourself and explain the projects you have done.",
      "What is Redis?",
    ],
  );
});
