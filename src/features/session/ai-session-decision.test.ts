import test from "node:test";
import assert from "node:assert/strict";
import {
  buildAISessionDecisionMessages,
  fallbackAISessionDecision,
  normalizeAISessionDecision,
  shouldUseAISessionDecision,
  toDecisionContextTargets,
} from "./ai-session-decision";
import { resolveFollowupTarget, toAnswerHistory } from "./answer-quality";
import { buildRequestScopedPolicy } from "./answer-policy";

test("normalizes AI decision for slow SQL query followup", () => {
  const history = toAnswerHistory([
    {
      messageId: "salary-sql",
      role: "AI_ASSISTANT",
      question: "Write SQL to fetch employee salaries",
      answer: "```sql\nSELECT employee_id, salary FROM employees;\n```",
      timestamp: new Date("2026-05-21T10:00:00Z").toISOString(),
    },
  ]);
  const input = {
    currentQuestion: "What if the same query takes 2 seconds while fetching records?",
    answerHistory: toDecisionContextTargets(history),
    deterministic: {
      conversationIntent: "NEW_QUESTION" as const,
      isExplicitFollowupReference: false,
      fallbackTargetId: null,
      fallbackTargetHasCode: false,
      fallbackTargetTopic: null,
    },
  };

  const decision = normalizeAISessionDecision(
    {
      intent: "OPTIMIZE_CODE",
      isFollowUp: true,
      targetAnswerId: "salary-sql",
      requiresPreviousCode: true,
      answerMode: "explain_existing_code",
      topic: "sql",
      confidence: 0.91,
      reason: "The user refers to the same query being slow.",
      contextToUse: "previous_code",
    },
    input,
  );

  assert.equal(decision?.intent, "OPTIMIZE_CODE");
	  assert.equal(decision?.targetAnswerId, "salary-sql");
	  assert.equal(decision?.boundPreviousAnswerId, "salary-sql");
	  assert.equal(
	    decision?.resolvedTargetQuestion,
	    "What if the same query takes 2 seconds while fetching records?",
	  );
	  assert.equal(decision?.requestIntent, "code_explanation_question");
	  assert.equal(decision?.segmentation, "follow_up");
	  assert.deepEqual(decision?.contextSourcesNeeded, ["previous_code"]);
	  assert.equal(decision?.requiresPreviousCode, true);
	  assert.equal(decision?.answerMode, "explain_existing_code");
	});

test("normalizes AI decision resolved target and evidence span for partial transcript", () => {
  const input = {
    currentQuestion: "data lake migration approach",
    recentTranscriptWindow: [
      "Interviewer: in your current migration from legacy pipelines",
      "Interviewer: data lake migration approach",
    ],
    answerHistory: [],
    deterministic: {
      conversationIntent: "UNKNOWN" as const,
      isExplicitFollowupReference: false,
      fallbackTargetId: null,
      fallbackTargetHasCode: false,
      fallbackTargetTopic: null,
    },
  };

  const decision = normalizeAISessionDecision(
    {
      intent: "NEW_QUESTION",
      isFollowUp: false,
      targetAnswerId: null,
      boundPreviousAnswerId: null,
      resolvedTargetQuestion:
        "How would you approach migrating legacy pipelines into a data lake?",
      requestIntent: "partial_evolving_question",
      segmentation: "partial_evolving",
      evidenceSpan: {
        source: "recent_transcript",
        text: "data lake migration approach",
        startIndex: 1,
        endIndex: 1,
      },
      contextSourcesNeeded: ["recent_transcript", "resume", "projects"],
      shouldAnswerPartial: true,
      requiresPreviousCode: false,
      answerMode: "auto",
      topic: "data engineering",
      confidence: 0.74,
      reason: "Partial interviewer wording resolves to a migration approach question.",
      contextToUse: "recent_transcript",
    },
    input,
  );

  assert.equal(
    decision?.resolvedTargetQuestion,
    "How would you approach migrating legacy pipelines into a data lake?",
  );
  assert.equal(decision?.requestIntent, "partial_evolving_question");
  assert.equal(decision?.segmentation, "partial_evolving");
  assert.equal(decision?.shouldAnswerPartial, true);
  assert.equal(decision?.evidenceSpan?.source, "recent_transcript");
  assert.deepEqual(decision?.contextSourcesNeeded, [
    "recent_transcript",
    "resume",
    "projects",
  ]);
});

test("rejects decision that points to missing answer id", () => {
  const input = {
    currentQuestion: "Explain that",
    answerHistory: [],
    deterministic: {
      conversationIntent: "FOLLOW_UP" as const,
      isExplicitFollowupReference: true,
      fallbackTargetId: null,
      fallbackTargetHasCode: false,
      fallbackTargetTopic: null,
    },
  };

  const decision = normalizeAISessionDecision(
    {
      intent: "FOLLOW_UP",
      isFollowUp: true,
      targetAnswerId: "missing-id",
      requiresPreviousCode: false,
      answerMode: "auto",
      topic: "general",
      confidence: 0.8,
      reason: "Bad target.",
      contextToUse: "previous_answer",
    },
    input,
  );

  assert.equal(decision, null);
});

test("active branch guard keeps ambiguous continue on most recent scenario", () => {
  const history = toAnswerHistory([
    {
      messageId: "salary-sql",
      role: "AI_ASSISTANT",
      question: "Write SQL",
      answer: "```sql\nSELECT * FROM employees;\n```",
      timestamp: new Date("2026-05-21T10:00:00Z").toISOString(),
    },
    {
      messageId: "production-scenario",
      role: "AI_ASSISTANT",
      question: "Production API is slow. What would you check?",
      answer: "- **Database:** I would check slow queries, locks, indexes, and connection pools.",
      timestamp: new Date("2026-05-21T10:02:00Z").toISOString(),
    },
  ]);
  const decision = normalizeAISessionDecision(
    {
      intent: "CONTINUE_PREVIOUS",
      isFollowUp: true,
      targetAnswerId: "salary-sql",
      requiresPreviousCode: true,
      answerMode: "code_required",
      topic: "sql",
      confidence: 0.9,
      reason: "Model incorrectly chose old SQL branch.",
      contextToUse: "previous_code",
    },
    {
      currentQuestion: "Continue from the database part of that production API scenario.",
      answerHistory: toDecisionContextTargets(history),
      deterministic: {
        conversationIntent: "CONTINUE_PREVIOUS",
        isExplicitFollowupReference: true,
        fallbackTargetId: "production-scenario",
        fallbackTargetHasCode: false,
        fallbackTargetTopic: "backend",
      },
    },
  );

  assert.equal(decision?.targetAnswerId, "production-scenario");
  assert.equal(decision?.requiresPreviousCode, false);
  assert.equal(decision?.contextToUse, "previous_answer");
});

test("active branch guard does not override explicit same-query code continuation", () => {
  const history = toAnswerHistory([
    {
      messageId: "salary-sql",
      role: "AI_ASSISTANT",
      question: "Write SQL",
      answer: "```sql\nSELECT * FROM employees;\n```",
      timestamp: new Date("2026-05-21T10:00:00Z").toISOString(),
    },
    {
      messageId: "scenario",
      role: "AI_ASSISTANT",
      question: "Production API is slow.",
      answer: "Check API and database metrics.",
      timestamp: new Date("2026-05-21T10:02:00Z").toISOString(),
    },
  ]);
  const decision = normalizeAISessionDecision(
    {
      intent: "OPTIMIZE_CODE",
      isFollowUp: true,
      targetAnswerId: "salary-sql",
      requiresPreviousCode: true,
      answerMode: "explain_existing_code",
      topic: "sql",
      confidence: 0.9,
      reason: "Same query optimization.",
      contextToUse: "previous_code",
    },
    {
      currentQuestion: "Continue with the same query optimization.",
      answerHistory: toDecisionContextTargets(history),
      deterministic: {
        conversationIntent: "OPTIMIZE_CODE",
        isExplicitFollowupReference: true,
        fallbackTargetId: "salary-sql",
        fallbackTargetHasCode: true,
        fallbackTargetTopic: "sql",
      },
    },
  );

  assert.equal(decision?.targetAnswerId, "salary-sql");
  assert.equal(decision?.requiresPreviousCode, true);
  assert.equal(decision?.contextToUse, "previous_code");
});


test("fallback decision preserves deterministic target and code requirement", () => {
  const history = toAnswerHistory([
    {
      messageId: "sql-1",
      role: "AI_ASSISTANT",
      question: "Write SQL",
      answer: "```sql\nSELECT * FROM employees;\n```",
      timestamp: new Date("2026-05-21T10:00:00Z").toISOString(),
    },
  ]);
  const followup = resolveFollowupTarget({
    question: "Explain the query",
    history,
  });

  const decision = fallbackAISessionDecision({
    currentQuestion: "Explain the query",
    conversationIntent: "EXPLAIN_CODE",
    followup,
  });

  assert.equal(decision.isFollowUp, true);
  assert.equal(decision.requiresPreviousCode, true);
  assert.equal(decision.targetAnswerId, "sql-1");
  assert.equal(decision.contextToUse, "previous_code");
});

test("decision prompt asks model to prefer semantic context over keyword matching", () => {
  const messages = buildAISessionDecisionMessages({
    currentQuestion: "What if it is slow?",
    answerHistory: [],
    deterministic: {
      conversationIntent: "UNKNOWN",
      isExplicitFollowupReference: false,
      fallbackTargetId: null,
      fallbackTargetHasCode: false,
      fallbackTargetTopic: null,
    },
  });

	  assert.ok(messages.system.includes("Prefer semantic context over keyword matching"));
	  assert.ok(messages.system.includes("same query/code being slow"));
	  assert.ok(messages.user.includes("resolvedTargetQuestion"));
	  assert.ok(messages.user.includes("evidenceSpan"));
	});

test("realistic session replay uses AI decisions for code, scenario, theory, experience, and unrelated turns", () => {
  const history = toAnswerHistory([
    {
      messageId: "salary-sql",
      role: "AI_ASSISTANT",
      question: "How would you pull employee salary records for active payroll review?",
      answer: [
        "**QUESTION:**",
        "How would you pull employee salary records for active payroll review?",
        "",
        "**ANSWER:**",
        "- **Approach:** I would fetch active employees and their current salary rows.",
        "```sql",
        "SELECT e.employee_id, e.full_name, s.salary",
        "FROM employees e",
        "JOIN salaries s ON s.employee_id = e.employee_id",
        "WHERE e.status = 'ACTIVE';",
        "```",
      ].join("\n"),
      timestamp: new Date("2026-05-21T10:00:00Z").toISOString(),
    },
    {
      messageId: "api-scenario",
      role: "AI_ASSISTANT",
      question: "A production API slows down during payroll export. What would you check?",
      answer: [
        "**QUESTION:**",
        "A production API slows down during payroll export. What would you check?",
        "",
        "**ANSWER:**",
        "- **Diagnosis:** I would separate API latency, database latency, and queue backlog.",
        "- **Database:** I would inspect slow queries, indexes, locks, and row counts.",
        "- **Fix:** I would add observability, pagination, and targeted indexes.",
      ].join("\n"),
      timestamp: new Date("2026-05-21T10:02:00Z").toISOString(),
    },
  ]);
  const answerHistory = toDecisionContextTargets(history);

  const currentQuestion = "Interviewer: what if the same query takes around two seconds while fetching records?";
  const decisionInput = {
    currentQuestion,
    recentTranscriptWindow: [
      "[interviewer]: Let us talk about payroll data now.",
      "[candidate]: I can write a query for that.",
      "[interviewer]: what if the same query takes around two seconds while fetching records?",
    ],
    speakerSeparatedTranscript: [
      {
        speakerType: "interviewer" as const,
        content: "Let us talk about payroll data now.",
        timestamp: 1,
      },
      {
        speakerType: "candidate" as const,
        content: "I can write a query for that.",
        timestamp: 2,
      },
      {
        speakerType: "interviewer" as const,
        content: "what if the same query takes around two seconds while fetching records?",
        timestamp: 3,
      },
    ],
    answerHistory,
    deterministic: {
      conversationIntent: "NEW_QUESTION" as const,
      isExplicitFollowupReference: false,
      fallbackTargetId: null,
      fallbackTargetHasCode: false,
      fallbackTargetTopic: null,
    },
  };
  const decisionPrompt = buildAISessionDecisionMessages(decisionInput);
  assert.ok(decisionPrompt.user.includes("speakerSeparatedTranscript"));
  assert.ok(decisionPrompt.user.includes("salary-sql"));

  const sqlDecision = normalizeAISessionDecision(
    {
      intent: "OPTIMIZE_CODE",
      isFollowUp: true,
      targetAnswerId: "salary-sql",
      requiresPreviousCode: true,
      answerMode: "explain_existing_code",
      topic: "sql",
      confidence: 0.93,
      reason: "The interviewer refers to the same SQL query and asks about runtime.",
      contextToUse: "previous_code",
    },
    decisionInput,
  );
  assert.equal(sqlDecision?.intent, "OPTIMIZE_CODE");

  const sqlPolicy = buildRequestScopedPolicy({
    question: currentQuestion,
    metadata: {
      transcript: currentQuestion,
      previousAiAnswer: history[0].answer,
      previousCodeBlocks: history[0].codeBlocks,
      speakerSeparatedTranscript: decisionInput.speakerSeparatedTranscript,
      recentTranscriptWindow: decisionInput.recentTranscriptWindow,
    } as any,
    aiDecision: sqlDecision!,
  });
  assert.equal(sqlPolicy.answerIntent, "code_optimization_followup");
  assert.ok(sqlPolicy.codeContextBlock.includes("FOLLOW-UP CODE CONTEXT"));
  assert.ok(sqlPolicy.codeContextBlock.includes("SELECT e.employee_id"));

  const scenarioFollowup = normalizeAISessionDecision(
    {
      intent: "CONTINUE_PREVIOUS",
      isFollowUp: true,
      targetAnswerId: "api-scenario",
      requiresPreviousCode: false,
      answerMode: "auto",
      topic: "database",
      confidence: 0.82,
      reason: "Manual follow-up asks to continue from the database part of the scenario.",
      contextToUse: "previous_answer",
    },
    {
      currentQuestion: "Manual: continue from the database part",
      answerHistory,
      deterministic: {
        conversationIntent: "CONTINUE_PREVIOUS",
        isExplicitFollowupReference: true,
        fallbackTargetId: "api-scenario",
        fallbackTargetHasCode: false,
        fallbackTargetTopic: "backend",
      },
    },
  );
  assert.equal(scenarioFollowup?.targetAnswerId, "api-scenario");
  assert.equal(scenarioFollowup?.contextToUse, "previous_answer");

  const theoryDecision = normalizeAISessionDecision(
    {
      intent: "FOLLOW_UP",
      isFollowUp: true,
      targetAnswerId: "salary-sql",
      requiresPreviousCode: false,
      answerMode: "auto",
      topic: "sql-indexing",
      confidence: 0.78,
      reason: "The interviewer asks why indexing helps after the SQL performance answer.",
      contextToUse: "previous_answer",
    },
    {
      currentQuestion: "Interviewer: why would indexing help here?",
      answerHistory,
      deterministic: {
        conversationIntent: "NEW_QUESTION",
        isExplicitFollowupReference: false,
        fallbackTargetId: null,
        fallbackTargetHasCode: false,
        fallbackTargetTopic: null,
      },
    },
  );
  assert.equal(theoryDecision?.intent, "FOLLOW_UP");

  const experienceDecision = normalizeAISessionDecision(
    {
      intent: "EXPERIENCE_QUESTION",
      isFollowUp: false,
      targetAnswerId: null,
      requiresPreviousCode: false,
      answerMode: "auto",
      topic: "experience",
      confidence: 0.86,
      reason: "The interviewer asks where the candidate used similar performance work.",
      contextToUse: "recent_transcript",
    },
    {
      currentQuestion: "Interviewer: where have you used this kind of optimization in your projects?",
      answerHistory,
      deterministic: {
        conversationIntent: "EXPERIENCE_QUESTION",
        isExplicitFollowupReference: false,
        fallbackTargetId: null,
        fallbackTargetHasCode: false,
        fallbackTargetTopic: null,
      },
    },
  );
  assert.equal(experienceDecision?.intent, "EXPERIENCE_QUESTION");

  const unrelatedDecision = normalizeAISessionDecision(
    {
      intent: "NEW_QUESTION",
      isFollowUp: false,
      targetAnswerId: null,
      requiresPreviousCode: false,
      answerMode: "auto",
      topic: "general",
      confidence: 0.9,
      reason: "Weather question is outside the active interview/code context.",
      contextToUse: "none",
    },
    {
      currentQuestion: "Candidate manual: what is the weather in Delhi tomorrow?",
      answerHistory,
      deterministic: {
        conversationIntent: "NEW_QUESTION",
        isExplicitFollowupReference: false,
        fallbackTargetId: null,
        fallbackTargetHasCode: false,
        fallbackTargetTopic: null,
      },
    },
  );
  assert.equal(unrelatedDecision?.isFollowUp, false);
  assert.equal(unrelatedDecision?.contextToUse, "none");
});

test("decision gate: clear question-shaped new question stays on deterministic fast path", () => {
  const reason = shouldUseAISessionDecision({
    isCustomQuery: false,
    isRegenerate: false,
    question: "How would you design a rate limiter for a public API?",
    routerConfidence: 0.72,
    routerRequestType: "new_question",
    routerSegmentation: "single_question",
    routerHasBoundTarget: false,
    shortFollowupDetected: false,
    sanitizedKind: "latest_question",
  });
  assert.equal(reason, null);
});

test("decision gate: explicit click classified as noise escalates to AI decision", () => {
  const reason = shouldUseAISessionDecision({
    isCustomQuery: false,
    isRegenerate: false,
    question: "so yeah the thing about",
    routerConfidence: 0.72,
    routerRequestType: "new_question",
    routerSegmentation: "single_question",
    routerHasBoundTarget: false,
    shortFollowupDetected: false,
    sanitizedKind: "noise",
  });
  assert.equal(reason, "static_noise_or_provisional");
});

test("decision gate: unbound short follow-up escalates to AI decision", () => {
  const reason = shouldUseAISessionDecision({
    isCustomQuery: true,
    isRegenerate: false,
    question: "explain",
    routerConfidence: 0.2,
    routerRequestType: "followup",
    routerSegmentation: "follow_up",
    routerHasBoundTarget: false,
    shortFollowupDetected: true,
    sanitizedKind: "true_followup",
  });
  assert.equal(reason, "unbound_followup");
});

test("decision gate: bound follow-up stays deterministic", () => {
  const reason = shouldUseAISessionDecision({
    isCustomQuery: true,
    isRegenerate: false,
    question: "give me an example",
    routerConfidence: 0.9,
    routerRequestType: "followup",
    routerSegmentation: "follow_up",
    routerHasBoundTarget: true,
    shortFollowupDetected: true,
    sanitizedKind: "true_followup",
  });
  assert.equal(reason, null);
});

test("decision gate: multi-question window escalates", () => {
  const reason = shouldUseAISessionDecision({
    isCustomQuery: false,
    isRegenerate: false,
    question: "what is spark and how does shuffle work and why does skew happen",
    routerConfidence: 0.72,
    routerRequestType: "new_question",
    routerSegmentation: "multiple_questions",
    routerHasBoundTarget: false,
    shortFollowupDetected: false,
    sanitizedKind: "latest_question",
  });
  assert.equal(reason, "multi_question_window");
});

test("decision gate: low router confidence escalates", () => {
  const reason = shouldUseAISessionDecision({
    isCustomQuery: false,
    isRegenerate: false,
    question: "the broadcast join thing again",
    routerConfidence: 0.4,
    routerRequestType: "new_question",
    routerSegmentation: "single_question",
    routerHasBoundTarget: false,
    shortFollowupDetected: false,
    sanitizedKind: "latest_question",
  });
  assert.equal(reason, "low_router_confidence");
});

test("decision gate: short non-question partial window escalates", () => {
  const reason = shouldUseAISessionDecision({
    isCustomQuery: false,
    isRegenerate: false,
    question: "data lake migration approach",
    routerConfidence: 0.72,
    routerRequestType: "new_question",
    routerSegmentation: "single_question",
    routerHasBoundTarget: false,
    shortFollowupDetected: false,
    sanitizedKind: "latest_question",
  });
  assert.equal(reason, "partial_or_ambiguous_question");
});

test("decision gate: regenerate always stays deterministic", () => {
  const reason = shouldUseAISessionDecision({
    isCustomQuery: false,
    isRegenerate: true,
    question: "anything",
    routerConfidence: 0.1,
    routerRequestType: "followup",
    routerSegmentation: "multiple_questions",
    routerHasBoundTarget: false,
    shortFollowupDetected: true,
    sanitizedKind: "noise",
  });
  assert.equal(reason, null);
});

test("decision gate: empty resolved question escalates", () => {
  const reason = shouldUseAISessionDecision({
    isCustomQuery: false,
    isRegenerate: false,
    question: "   ",
  });
  assert.equal(reason, "empty_resolved_question");
});
