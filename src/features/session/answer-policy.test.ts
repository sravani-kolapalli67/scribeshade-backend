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
  assert.equal(policy.policyBlock.includes("output_format: markdown_only_under_answer_marker"), false);
  assert.equal(policy.policyBlock.includes("candidate_voice_rule"), false);
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

test("classifies project overview as experience, not concept explanation", () => {
  const policy = buildRequestScopedPolicy({
    question: "Explain my projects",
    metadata: { transcript: "Explain my projects", answerMode: "auto" } as any,
    cieComplexity: "simple_contextual",
  });

  assert.equal(policy.answerIntent, "behavioral_project_experience");
  assert.equal(policy.effectiveAnswerMode, "auto");
  assert.equal(policy.experienceSuppressed, false);
  assert.ok(policy.policyBlock.includes("project_coverage: include_all_selected_projects"));
  assert.ok(policy.policyBlock.includes("project_source_precedence: selected_projects_first"));
  assert.equal(policy.policyBlock.includes("candidate_voice_rule"), false);
  assert.equal(policy.policyBlock.includes("project names, exact numbers"), false);
  assert.ok(policy.policyBlock.includes("project_depth_per_item"));
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

test("AI decision can force SQL performance followup into code optimization mode", () => {
  const policy = buildRequestScopedPolicy({
    question: "What if the same query takes 2 seconds while fetching records?",
    metadata: {
      transcript: "What if the same query takes 2 seconds while fetching records?",
      previousCodeBlocks: ["SELECT employee_id, salary FROM employees;"],
      previousAiAnswer: "```sql\nSELECT employee_id, salary FROM employees;\n```",
    } as any,
    aiDecision: {
      intent: "OPTIMIZE_CODE",
      isFollowUp: true,
      targetAnswerId: "salary-sql",
      requiresPreviousCode: true,
      answerMode: "explain_existing_code",
      topic: "sql",
      confidence: 0.92,
      reason: "same query performance followup",
      contextToUse: "previous_code",
    },
  });

  assert.equal(policy.answerIntent, "code_optimization_followup");
  assert.equal(policy.effectiveAnswerMode, "explain_existing_code");
  assert.equal(policy.isCodeFollowup, true);
  assert.ok(policy.codeContextBlock.includes("FOLLOW-UP CODE CONTEXT"));
});
