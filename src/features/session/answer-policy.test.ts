import test from "node:test";
import assert from "node:assert/strict";
import { buildRequestScopedPolicy, classifyAnswerIntent } from "./answer-policy";

test("classifies concept explanation and suppresses experience", () => {
  const intent = classifyAnswerIntent({
    question: "Explain this concept: CAP theorem",
    answerMode: "auto",
    previousCodeBlocks: [],
  });
  assert.equal(intent, "concept_explanation");

  const policy = buildRequestScopedPolicy({
    question: "Explain this concept: CAP theorem",
    metadata: { transcript: "Explain this concept: CAP theorem" } as any,
    cieComplexity: "simple_contextual",
  });
  assert.equal(policy.answerIntent, "concept_explanation");
  assert.equal(policy.experienceSuppressed, true);
});

test("classifies code followup when previous code blocks exist", () => {
  const policy = buildRequestScopedPolicy({
    question: "Explain this code",
    metadata: {
      transcript: "Explain this code",
      previousCodeBlocks: ["function x(){return 1;}"],
      previousAiAnswer: "Earlier I wrote function x(){return 1;}",
    } as any,
    cieComplexity: "followup",
  });
  assert.equal(policy.answerIntent, "code_explanation_followup");
  assert.equal(policy.isCodeFollowup, true);
  assert.equal(policy.codeBlocksInjectedCount, 1);
  assert.ok(policy.codeContextBlock.includes("FOLLOW-UP CODE CONTEXT"));
});

test("classifies behavioral project experience", () => {
  const intent = classifyAnswerIntent({
    question: "Tell me about your project",
    answerMode: "auto",
    previousCodeBlocks: [],
  });
  assert.equal(intent, "behavioral_project_experience");
});

