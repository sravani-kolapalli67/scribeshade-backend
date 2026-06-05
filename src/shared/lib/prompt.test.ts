import test from "node:test";
import assert from "node:assert/strict";
import {
  buildActiveTaskV3,
  buildAnswerRuntimeContext,
  buildAnswerTaskMessage,
  buildRuntimeContextMessage,
  buildScreenAnalysisMessage,
  buildScreenSystemMessage,
  buildSystemMessage,
  buildUserMessage,
  type AnswerPlan,
} from "./prompt";

const baseContext = {
  company: "Acme",
  role: "Data Engineer",
  language: "Python",
  resume: "5.9 years of data engineering experience with Spark and Databricks.",
  document: "Architecture notes for a banking data platform.",
  history:
    "STRICT CONTEXT PACKET:\nCURRENT QUESTION: Tell me about yourself.\nQUESTION EVIDENCE:\n- noisy evidence\n\n1. Q: Introduce yourself. A: I am a data engineer.",
  instructions: "Keep answers concise.",
  projects:
    "━━━ PRIMARY PROJECT: Banking Gateway ━━━\nBuilt Databricks pipelines with Azure Data Factory.",
  simpleLanguage: false,
  hasSelectedProjects: true,
  isProjectQuestion: true,
  projectPriorityMode: "project_questions_only",
  vectorContext: "Recent transcript chunk about Delta Lake.",
};

function approxTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

test("system prompt remains behavior-only and keeps parser contract", () => {
  const prompt = buildSystemMessage(baseContext);

  assert.ok(prompt.includes("MANDATORY MARKDOWN ANSWER FORMAT"));
  assert.ok(prompt.includes("CONTEXT PRIORITY"));
  assert.ok(prompt.includes("Candidate speech may contain the question they want help answering"));
  assert.ok(prompt.includes("**QUESTION:**"));
  assert.ok(prompt.includes("**ANSWER:**"));
  assert.equal(prompt.includes(baseContext.resume), false);
  assert.equal(prompt.includes("Banking Gateway"), false);
  assert.equal(prompt.includes("STRICT CONTEXT PACKET"), false);
});

test("runtime context is compressed stable evidence without request artifacts", () => {
  const runtime = buildRuntimeContextMessage(baseContext);

  assert.ok(runtime.startsWith("RUNTIME_CONTEXT v3"));
  assert.ok(runtime.includes("CANDIDATE_PROFILE"));
  assert.ok(runtime.includes("PROJECT_CONTEXT"));
  assert.ok(runtime.includes("Banking Gateway"));
  assert.equal(runtime.includes("MANDATORY MARKDOWN ANSWER FORMAT"), false);
  assert.equal(runtime.includes("STRICT CONTEXT PACKET"), false);
  assert.equal(runtime.includes("CURRENT QUESTION"), false);
  assert.equal(runtime.includes("QUESTION EVIDENCE"), false);
  assert.equal(runtime.includes("AI SEGMENTER DECISION"), false);
  assert.equal(runtime.includes("BOUNDED RAW TRANSCRIPT"), false);
});

test("answer runtime context respects compact token budget for heavy evidence", () => {
  const runtime = buildAnswerRuntimeContext({
    company: "Acme",
    role: "Data Engineer",
    language: "Python",
    simpleLanguage: false,
    projectMode: "selected_projects_present",
    projectPriority: "project_questions_only",
    resumeDigest: `${baseContext.resume} `.repeat(80),
    projectDigest: `${baseContext.projects} `.repeat(80),
    historySummary: "Previous generated answer with lots of details. ".repeat(80),
    memorySummary: "Current topic is notification system design. ".repeat(80),
    documentSummary: "Supporting document summary. ".repeat(80),
    isProjectQuestion: false,
  });

  assert.ok(approxTokens(runtime) <= 1100);
  assert.equal(runtime.includes("CURRENT QUESTION"), false);
});

test("answer runtime context uses candidate profile fallback without fake resume", () => {
  const runtime = buildAnswerRuntimeContext({
    company: "Acme",
    role: "Backend Engineer",
    language: "TypeScript",
    simpleLanguage: false,
    resumeDigest: "No resume provided.",
    projectDigest: "",
  });

  assert.ok(runtime.includes("CANDIDATE_PROFILE"));
  assert.ok(runtime.includes("Candidate facts: Not provided."));
  assert.ok(runtime.includes("Known skills: Not provided."));
  assert.equal(runtime.includes("CANDIDATE_PROFILE\nNo resume provided."), false);
  assert.equal(runtime.includes("[Candidate Name]"), false);
});

test("live active task keeps transcript evidence multiline and forbids invented questions", () => {
  const task = buildActiveTaskV3({
    mode: "live_ai_answer",
    transcriptEvidence: [
      "- candidate: Can you please introduce yourself?",
      "- candidate: while you introduce yourself, explain the projects you have done.",
    ].join("\n"),
    currentQuestionHint: "Can you please introduce yourself and explain your projects?",
    language: "TypeScript",
    hasCodeFollowupAnchor: false,
    noCodeFollowupGuidance: false,
  });

  assert.ok(task.includes("- candidate: Can you please introduce yourself?\n- candidate: while you introduce yourself"));
  assert.ok(task.includes("Output exactly one Q&A block unless Transcript Evidence contains two or more explicit independent interview questions."));
  assert.ok(task.includes("Do not invent follow-up questions"));
  assert.ok(task.includes("Treat compound asks like 'introduce yourself and explain your projects' as one Q&A block."));
  assert.ok(task.includes("Do not use placeholders like [Candidate Name]"));
});

test("answer task contains one authoritative single-question location", () => {
  const plan: AnswerPlan = {
    mode: "live_ai_answer",
    intent: "system_design_followup",
    questions: ["Continue from the database part and justify indexing choices."],
    transcriptExcerpt:
      "Interviewer: Continue from the database part and justify indexing choices.",
    followupAnchor: {
      topic: "notification system",
      priorQuestion: "Design a notification system.",
      priorAnswerSummary: "Queue-based design with workers, retries, DLQ, and metadata database.",
    },
    requestDeltas: ["Answer only the question listed above."],
  };
  const task = buildAnswerTaskMessage(plan);

  assert.ok(task.includes("ACTIVE TASK"));
  assert.ok(task.includes("Question: Continue from the database part"));
  assert.ok(task.includes("Relevant transcript excerpt"));
  assert.ok(task.includes("Follow-up anchor"));
  assert.equal(task.includes("STRICT CONTEXT PACKET"), false);
  assert.equal(task.includes("AI SEGMENTER DECISION"), false);
  assert.equal(task.includes("confidence"), false);
  assert.equal(task.includes("resolvedIntentIds"), false);
});

test("answer task supports multi-intent without segmenter internals", () => {
  const task = buildAnswerTaskMessage({
    mode: "live_ai_answer",
    intent: "multi_intent",
    questions: ["Introduce yourself.", "What tech stack do you use?"],
    transcriptExcerpt:
      "Interviewer: Introduce yourself.\nInterviewer: What tech stack do you use?",
    requestDeltas: [
      "Produce one Q&A block per question in listed order and separate blocks with ===NEXT_QUESTION===.",
    ],
  });

  assert.ok(task.includes("Questions:"));
  assert.ok(task.includes("1. Introduce yourself."));
  assert.ok(task.includes("2. What tech stack do you use?"));
  assert.equal(task.includes("latestIntentId"), false);
  assert.equal(task.includes("BOUNDED RAW TRANSCRIPT"), false);
});

test("legacy user wrapper still produces compact active task", () => {
  const prompt = buildUserMessage("Explain Spark", true, false, baseContext);

  assert.ok(prompt.includes("Mode: manual_query"));
  assert.ok(prompt.includes("Question: Explain Spark"));
  assert.equal(prompt.includes("ACTIVE INPUT BLOCK"), false);
  assert.equal(prompt.includes("MANDATORY MARKDOWN ANSWER FORMAT"), false);
  assert.equal(prompt.includes("Banking Gateway"), false);
});

test("screen prompts keep markdown contract only in screen system prompt", () => {
  const system = buildScreenSystemMessage(baseContext);
  const user = buildScreenAnalysisMessage(baseContext);

  assert.ok(system.includes("MANDATORY MARKDOWN ANSWER FORMAT"));
  assert.ok(system.includes("===NO_NEW_QUESTION==="));
  assert.ok(user.includes("===NO_NEW_QUESTION==="));
  assert.ok(user.includes("===NEXT_QUESTION==="));
  assert.equal(user.includes("MANDATORY MARKDOWN ANSWER FORMAT"), false);
  assert.equal(user.includes("Banking Gateway"), false);
});
