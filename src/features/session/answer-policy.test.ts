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
  assert.ok(policy.policyBlock.includes("output_format: markdown_only_under_answer_marker"));
  assert.ok(policy.policyBlock.includes("**Core idea:**"));
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
  assert.ok(policy.policyBlock.includes("**Referenced code:**"));
});

test("classifies optimize code followup from natural phrase", () => {
  const policy = buildRequestScopedPolicy({
    question: "Can you optimize this code?",
    metadata: {
      transcript: "Can you optimize this code?",
      previousCodeBlocks: ["for (const x of items) result.push(x);"],
      previousAiAnswer: "Earlier code used a loop.",
    } as any,
    cieComplexity: "followup",
  });
  assert.equal(policy.answerIntent, "code_optimization_followup");
  assert.equal(policy.isCodeFollowup, true);
  assert.ok(policy.policyBlock.includes("**Edge case/performance:**"));
});

test("classifies years of experience as project experience", () => {
  const intent = classifyAnswerIntent({
    question: "How many years of experience do you have?",
    answerMode: "auto",
    previousCodeBlocks: [],
  });
  assert.equal(intent, "behavioral_project_experience");

  const policy = buildRequestScopedPolicy({
    question: "How many years of experience do you have?",
    metadata: { transcript: "How many years of experience do you have?" } as any,
  });
  assert.ok(policy.policyBlock.includes("**Experience/project:**"));
  assert.ok(policy.policyBlock.includes("**Impact:**"));
});

test("classifies behavioral project experience", () => {
  const intent = classifyAnswerIntent({
    question: "Tell me about your project",
    answerMode: "auto",
    previousCodeBlocks: [],
  });
  assert.equal(intent, "behavioral_project_experience");
});

test("emits scenario markdown answer shape", () => {
  const policy = buildRequestScopedPolicy({
    question: "In production, how would you debug a slow API?",
    metadata: { transcript: "In production, how would you debug a slow API?" } as any,
    cieComplexity: "scenario_based",
  });

  assert.equal(policy.answerIntent, "scenario_based");
  assert.ok(policy.policyBlock.includes("**Diagnosis:**"));
  assert.ok(policy.policyBlock.includes("**Recommendation:**"));
});
