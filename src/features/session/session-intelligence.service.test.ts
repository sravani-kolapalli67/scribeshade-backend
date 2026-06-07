import test from "node:test";
import assert from "node:assert/strict";
import {
  buildSessionStateV3,
  compactSessionStateForPrompt,
} from "./session-intelligence.service";
import {
  applyContextRouterV3,
  routeAnswerContextV3,
} from "./context/context-router-v3.service";
import type { SanitizedLiveRequest } from "./ai-answer-context-guards";

const latestRequest: SanitizedLiveRequest = {
  kind: "latest_question",
  effectiveAnswerClickMode: "answer_latest_unanswered",
  metadata: { answerClickMode: "answer_latest_unanswered" },
  allowPreviousAnswer: false,
  allowPreviousAnswers: false,
  allowSelectedAnswer: false,
  allowCodeMemory: false,
  allowProjectContext: true,
  allowHistory: false,
  answerKind: "final",
  answerTrust: "strong",
  interviewerTone: "neutral",
  scenarioDetected: false,
};

test("SessionStateV3 builds compact question chain and answered memory", () => {
  const state = buildSessionStateV3({
    sessionId: "session-1",
    sanitizedRequest: latestRequest,
    fallbackTopic: "spark",
    intentLedger: {
      activeIntentId: "i2",
      intents: [
        {
          id: "i1",
          question: "How do you process 1TB daily?",
          normalizedQuestion: "how do you process 1tb daily",
          intent: "system_design",
          status: "answered",
          evidenceChunkIds: [],
          transcriptExcerpt: "",
          topic: "spark",
          createdAt: new Date(0).toISOString(),
        },
        {
          id: "i2",
          question: "How many nodes and cores are needed?",
          normalizedQuestion: "how many nodes and cores are needed",
          intent: "system_design",
          status: "unanswered",
          evidenceChunkIds: [],
          transcriptExcerpt: "",
          topic: "spark",
          createdAt: new Date(1).toISOString(),
        },
      ],
    },
    answerLedger: {
      answers: [
        {
          answerId: "a1",
          intentId: "i1",
          question: "How do you process 1TB daily?",
          answerSummary: "Use Spark, Databricks, autoscaling, and monitoring.",
          keyClaims: ["1TB daily processing"],
          topic: "spark",
          createdAt: new Date(0).toISOString(),
        },
      ],
    },
  });

  assert.equal(state.activeTopic, "spark");
  assert.equal(state.askState, "answerable_question");
  assert.equal(state.questionChain.length, 2);
  assert.equal(state.latestCleanQuestion, "How many nodes and cores are needed?");
  assert.equal(state.answeredQuestions[0].answerId, "a1");
});

test("ContextRouterV3 includes scoped code memory only for code followups", () => {
  const codeRequest: SanitizedLiveRequest = {
    ...latestRequest,
    kind: "code_followup",
    allowPreviousAnswer: true,
    allowCodeMemory: true,
    interviewerTone: "clarification",
  };
  const state = buildSessionStateV3({
    sessionId: "session-1",
    sanitizedRequest: codeRequest,
    fallbackTopic: "pyspark",
    intentLedger: { intents: [] },
    answerLedger: {
      answers: [
        {
          answerId: "code-1",
          intentId: "intent-code",
          question: "Write PySpark for consecutive IPL winners.",
          answerSummary: "Used row_number and year - rn grouping.",
          keyClaims: ["row_number grouping"],
          codeBlocks: [
            {
              language: "python",
              purpose: "consecutive winner detection",
              summary: "df.withColumn('rn', row_number().over(window)).withColumn('grp', col('year') - col('rn'))",
              codeHash: "hash123",
            },
          ],
          topic: "pyspark",
          createdAt: new Date(0).toISOString(),
        },
      ],
    },
  });
  const routed = routeAnswerContextV3({
    sanitizedRequest: codeRequest,
    sessionState: state,
    cieComplexity: "followup",
    hasResume: true,
    hasProjects: true,
    hasDocument: false,
  });
  const summary = compactSessionStateForPrompt({ sessionState: state, routedContext: routed });

  assert.equal(routed.includeCodeMemory, true);
  assert.ok(summary.includes("Code memory: python"));
  assert.ok(summary.includes("hash123"));
});

test("ContextRouterV3 excludes stale history for fresh coding requests", () => {
  const codingRequest: SanitizedLiveRequest = {
    ...latestRequest,
    kind: "code_generation",
    clearReason: "latest_coding_context_cleared",
  };
  const state = buildSessionStateV3({
    sessionId: "session-1",
    sanitizedRequest: codingRequest,
    fallbackTopic: "react",
    intentLedger: { intents: [] },
    answerLedger: {
      answers: [
        {
          answerId: "old-react",
          intentId: "intent-react",
          question: "Explain useEffect and Context API.",
          answerSummary: "Old React explanation.",
          keyClaims: ["useEffect", "Context API"],
          topic: "react",
          createdAt: new Date(0).toISOString(),
        },
      ],
    },
  });
  const routed = routeAnswerContextV3({
    sanitizedRequest: codingRequest,
    sessionState: state,
    cieComplexity: "system_design",
    hasResume: true,
    hasProjects: true,
    hasDocument: true,
  });

  assert.equal(routed.includeHistory, false);
  assert.equal(routed.includeCodeMemory, false);
  assert.equal(routed.includeProjects, false);
  assert.equal(routed.includeDocuments, false);
});

test("SessionStateV3 marks skeptical requests as challenge or correction", () => {
  const challengeRequest: SanitizedLiveRequest = {
    ...latestRequest,
    interviewerTone: "skeptical",
  };
  const state = buildSessionStateV3({
    sessionId: "session-1",
    sanitizedRequest: challengeRequest,
    fallbackTopic: "sql",
    intentLedger: { intents: [] },
    answerLedger: { answers: [] },
  });

  assert.equal(state.askState, "challenge_or_correction");
});

test("applyRoutedAnswerContext omits disallowed runtime sections", () => {
  const routed = routeAnswerContextV3({
    sanitizedRequest: latestRequest,
    sessionState: {
      sessionId: "session-1",
      activeTopic: "redis",
      questionChain: [],
      askState: "answerable_question",
      interviewerTone: "neutral",
      updatedAt: new Date(0).toISOString(),
      answeredQuestions: [],
    },
    cieComplexity: "simple_atomic",
    hasResume: true,
    hasProjects: true,
    hasDocument: true,
  });
  const runtime = applyContextRouterV3({
    routedContext: routed,
    context: {
      resume: "Candidate has Node.js and Redis experience.",
      projects: "Large project context that should not enter simple concept prompts.",
      document: "Supporting document context that should be skipped.",
      history: "Prior answer summary that should be skipped.",
    },
  });

  assert.equal(routed.includeResume, false);
  assert.equal(routed.includeProjects, false);
  assert.equal(routed.includeHistory, false);
  assert.equal(routed.includeDocuments, false);
  assert.equal(runtime.resume, "");
  assert.equal(runtime.projects, "");
  assert.equal(runtime.document, "");
  assert.equal(runtime.history, "");
});

test("ContextRouterV3 keeps resume for simple contextual intro questions", () => {
  const routed = routeAnswerContextV3({
    sanitizedRequest: latestRequest,
    sessionState: {
      sessionId: "session-1",
      activeTopic: "introduction",
      latestCleanQuestion: "Introduce yourself",
      questionChain: [],
      askState: "answerable_question",
      interviewerTone: "neutral",
      updatedAt: new Date(0).toISOString(),
      answeredQuestions: [],
    },
    cieComplexity: "simple_contextual",
    hasResume: true,
    hasProjects: true,
    hasDocument: true,
  });
  const runtime = applyContextRouterV3({
    routedContext: routed,
    context: {
      resume: "Name: Tushar\nBackend engineer with Node.js, Redis, PostgreSQL, and AWS experience.",
      projects: "Project context should not be included for a pure intro.",
      document: "Supporting document should not be included for a pure intro.",
      history: "Previous answer should not be included for a pure intro.",
    },
  });

  assert.equal(routed.includeResume, true);
  assert.equal(routed.budgets.resume, 550);
  assert.equal(routed.includeProjects, false);
  assert.equal(routed.includeHistory, false);
  assert.equal(routed.includeDocuments, false);
  assert.ok(runtime.resume.includes("Backend engineer"));
  assert.equal(runtime.projects, "");
  assert.equal(runtime.document, "");
  assert.equal(runtime.history, "");
});

test("ContextRouterV3 includes resume and projects for combined profile project questions", () => {
  const routed = routeAnswerContextV3({
    sanitizedRequest: latestRequest,
    sessionState: {
      sessionId: "session-1",
      activeTopic: "profile",
      latestCleanQuestion: "Can you please let me know your experience, your skill set, and your projects?",
      questionChain: [],
      askState: "answerable_question",
      interviewerTone: "neutral",
      updatedAt: new Date(0).toISOString(),
      answeredQuestions: [],
    },
    cieComplexity: "simple_contextual",
    answerIntent: "behavioral_project_experience",
    question: "Can you please let me know your experience, your skill set, and your projects?",
    hasResume: true,
    hasProjects: true,
    hasDocument: false,
  });
  const runtime = applyContextRouterV3({
    routedContext: routed,
    context: {
      resume: "Name: Tushar\nTotal Experience: 1 year\nCompany: WebSenor\nSkills: React, Node.js, MongoDB, Redis",
      projects: "Project: WebSenor MERN dashboard | Role: MERN Stack Developer | Stack: React, Node.js, MongoDB",
      history: "Previous answer should not enter a fresh profile/project question.",
    },
  });

  assert.equal(routed.includeResume, true);
  assert.equal(routed.includeProjects, true);
  assert.equal(routed.includeHistory, false);
  assert.ok(runtime.resume.includes("Total Experience"));
  assert.ok(runtime.projects.includes("WebSenor MERN dashboard"));
  assert.equal(runtime.history, "");
});

test("ContextRouterV3 keeps verified resume and project context for regenerate", () => {
  const regenerateRequest: SanitizedLiveRequest = {
    ...latestRequest,
    kind: "regenerate",
    allowPreviousAnswer: true,
    allowSelectedAnswer: true,
  };
  const routed = routeAnswerContextV3({
    sanitizedRequest: regenerateRequest,
    sessionState: {
      sessionId: "session-1",
      activeTopic: "projects",
      latestCleanQuestion: "Tell me about your projects.",
      questionChain: [],
      askState: "answerable_question",
      interviewerTone: "neutral",
      updatedAt: new Date(0).toISOString(),
      answeredQuestions: [],
    },
    cieComplexity: "simple_contextual",
    answerIntent: "behavioral_project_experience",
    question: "Tell me about your projects.",
    hasResume: true,
    hasProjects: true,
    hasDocument: false,
  });

  assert.equal(routed.includeResume, true);
  assert.equal(routed.includeProjects, true);
  assert.equal(routed.includeHistory, false);
});

test("applyRoutedAnswerContext clips allowed runtime sections by route budgets", () => {
  const projectRequest: SanitizedLiveRequest = {
    ...latestRequest,
    kind: "project_question",
  };
  const routed = routeAnswerContextV3({
    sanitizedRequest: projectRequest,
    sessionState: {
      sessionId: "session-1",
      activeTopic: "projects",
      questionChain: [],
      askState: "answerable_question",
      interviewerTone: "neutral",
      updatedAt: new Date(0).toISOString(),
      answeredQuestions: [],
    },
    cieComplexity: "experience_context",
    hasResume: true,
    hasProjects: true,
    hasDocument: false,
  });
  const runtime = applyContextRouterV3({
    routedContext: routed,
    context: {
      resume: "resume ".repeat(1000),
      projects: "project ".repeat(1000),
      document: "document ".repeat(1000),
      history: "history ".repeat(1000),
    },
  });

  assert.equal(routed.includeResume, true);
  assert.equal(routed.includeProjects, true);
  assert.ok(runtime.resume.length <= routed.budgets.resume * 4);
  assert.ok(runtime.projects.length <= routed.budgets.projects * 4);
  assert.equal(runtime.document, "");
});
