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
  assert.ok(prompt.includes("answer in that order: Experience, Skill Set, Projects"));
  assert.ok(prompt.includes("open with the verified candidate name, role, and exact Total Experience"));
  assert.ok(prompt.includes("include total years and work experience only when available"));
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

test("answer runtime context honors routed project token budget", () => {
  const marker = "SCENARIO_PROJECT_DOMAIN_MARKER";
  const projectDigest = `${"checkout inventory project flow ".repeat(60)}${marker} ${"tail ".repeat(40)}`;
  const compactRuntime = buildAnswerRuntimeContext({
    company: "Acme",
    role: "Backend Engineer",
    language: "TypeScript",
    simpleLanguage: false,
    projectDigest,
    isProjectQuestion: false,
  });
  const routedRuntime = buildAnswerRuntimeContext({
    company: "Acme",
    role: "Backend Engineer",
    language: "TypeScript",
    simpleLanguage: false,
    projectDigest,
    isProjectQuestion: false,
    projectDigestTokenBudget: 550,
  });

  assert.equal(compactRuntime.includes(marker), false);
  assert.equal(routedRuntime.includes(marker), true);
});

test("selected project runtime context is exclusive and blocks generic fallback projects", () => {
  const system = buildSystemMessage({
    ...baseContext,
    hasSelectedProjects: true,
    projectPriorityMode: "project_questions_only",
  });
  const runtime = buildAnswerRuntimeContext({
    company: "Acme",
    role: "Backend Engineer",
    language: "TypeScript",
    simpleLanguage: false,
    projectMode: "selected_projects_present",
    projectPriority: "project_questions_only",
    resumeDigest: "Experience with backend APIs and Redis.",
    projectDigest: [
      "━━━ PRIMARY PROJECT: Voice-Enabled Secure Payment Gateway ━━━",
      "Role: Backend Engineer",
      "Tech: Backend: NestJS, Node.js | Database: MongoDB | Cache: Redis | Cloud: AWS EC2",
    ].join("\n"),
    isProjectQuestion: true,
  });

  assert.ok(system.includes("exclusive project evidence"));
  assert.ok(system.includes("Do not substitute resume-backed projects"));
  assert.ok(runtime.includes("Project source: selected AI projects only"));
  assert.ok(runtime.includes("Voice-Enabled Secure Payment Gateway"));
  assert.equal(runtime.includes("Fintech Payment Platform"), false);
});

test("selected project unavailable context tells model not to invent projects", () => {
  const runtime = buildAnswerRuntimeContext({
    company: "Acme",
    role: "Backend Engineer",
    language: "TypeScript",
    simpleLanguage: false,
    projectMode: "selected_projects_present",
    projectPriority: "project_questions_only",
    resumeDigest: "Experience with backend APIs and Redis.",
    projectDigest: [
      "SELECTED_PROJECT_CONTEXT_UNAVAILABLE",
      "Selected project IDs attached to this session: project-a",
      "Unresolved selected project IDs: project-a",
      "Do not invent project names, companies, tools, metrics, or project details.",
    ].join("\n"),
    isProjectQuestion: true,
  });

  assert.ok(runtime.includes("SELECTED_PROJECT_CONTEXT_UNAVAILABLE"));
  assert.ok(runtime.includes("Do not invent project names"));
  assert.equal(runtime.includes("Project-backed experience: SELECTED_PROJECT_CONTEXT_UNAVAILABLE"), false);
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

test("answer runtime context preserves verified experience and skills when provided", () => {
  const runtime = buildAnswerRuntimeContext({
    company: "Acme",
    role: "Full Stack Developer",
    language: "TypeScript",
    simpleLanguage: false,
    resumeDigest: [
      "Name: Tushar Vaghela",
      "Total Experience: 1 year",
      "Companies: WebSenor | Full Stack Developer Intern | Aug 2024 - Oct 2024",
      "Skills: React, Node.js, NestJS, MongoDB, Redis, Docker, AWS",
    ].join("\n"),
    projectDigest: "Project: WebSenor MERN dashboard | Role: MERN Stack Developer | Stack: React, Node.js, MongoDB",
    isProjectQuestion: true,
  });

  assert.ok(runtime.includes("Total Experience: 1 year"));
  assert.ok(runtime.includes("WebSenor"));
  assert.ok(runtime.includes("Skills: React"));
  assert.ok(runtime.includes("React"));
  assert.equal(runtime.includes("Candidate facts: Not provided."), false);
  assert.equal(runtime.includes("Known skills: Not provided."), false);
});

test("answer runtime context can carry expanded profile walkthrough evidence", () => {
  const educationMarker = "SIES Graduate School of Technology";
  const profile = [
    "VERIFIED_CANDIDATE_PROFILE",
    "Name: Tushar Vaghela",
    "Total Experience: 5.9 years",
    "Resume Summary:",
    `Data engineer with experience across Azure, AWS, Spark, Databricks, and enterprise ETL systems. ${"Profile detail ".repeat(90)}`,
    "Work History:",
    "3i Infotech | Data Engineer | Current",
    "Wipro | Data Engineer | Previous",
    "Skills:",
    "Languages: Python, SQL",
    "Frameworks: PySpark, Spark SQL",
    "Tools: Azure Data Factory, Databricks, AWS",
    "Education:",
    `B.E. Computer Engineering | ${educationMarker} | Mumbai University`,
  ].join("\n");
  const compactRuntime = buildAnswerRuntimeContext({
    company: "Acme",
    role: "Data Engineer",
    language: "Python",
    simpleLanguage: false,
    resumeDigest: profile,
  });
  const expandedRuntime = buildAnswerRuntimeContext({
    company: "Acme",
    role: "Data Engineer",
    language: "Python",
    simpleLanguage: false,
    resumeDigest: profile,
    candidateProfileTokenBudget: 650,
  });

  assert.equal(compactRuntime.includes(educationMarker), false);
  assert.ok(expandedRuntime.includes("Total Experience: 5.9 years"));
  assert.ok(expandedRuntime.includes("3i Infotech"));
  assert.ok(expandedRuntime.includes("Wipro"));
  assert.ok(expandedRuntime.includes(educationMarker));
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

test("live active task includes bounded recent and raw click transcript sections", () => {
  const task = buildActiveTaskV3({
    mode: "live_ai_answer",
    transcriptEvidence: "- candidate: Explain the project.",
    recentTranscriptContext: [
      "- interviewer: Earlier setup about the React component.",
      "- candidate: The state comes from context.",
    ].join("\n"),
    clickRawTranscript: "- candidate: Write a code in React.",
    currentQuestionHint: "Write a code in React.",
    language: "TypeScript",
    hasCodeFollowupAnchor: false,
    noCodeFollowupGuidance: false,
  });

  assert.ok(task.includes("Recent Transcript Context (~1-2 min, memory only):"));
  assert.ok(task.includes("Raw Click Transcript (~15 sec, highest priority evidence):"));
  assert.ok(task.includes("- candidate: Write a code in React."));
  assert.ok(task.includes("Use Raw Click Transcript as the highest priority evidence for the current ask."));
  assert.ok(task.includes("do not let it override the latest explicit ask"));
  assert.ok(task.includes("Never output ===NO_NEW_QUESTION==="));
});

test("live active task instructs scenario answers to use setup", () => {
  const task = buildActiveTaskV3({
    mode: "live_ai_answer",
    transcriptEvidence: [
      "Scenario Setup:",
      "- candidate: Ecommerce sale has inventory left 5.",
      "- candidate: Multiple users buy the same product and orders go negative.",
      "",
      "Question:",
      "How will you tackle this issue?",
    ].join("\n"),
    currentQuestionHint: "How will you tackle this issue?",
    language: "TypeScript",
    hasCodeFollowupAnchor: false,
    noCodeFollowupGuidance: false,
  });

  assert.ok(task.includes("For scenario/problem-solving questions, use the full scenario setup before the final ask."));
  assert.ok(task.includes("Do not answer only the final sentence when it depends on earlier Transcript Evidence."));
  assert.ok(task.includes("domain, actors, constraints, numbers, failure symptom, and final ask"));
});

test("answer followup active task forbids unrelated prior topics and diagrams", () => {
  const task = buildActiveTaskV3({
    mode: "live_ai_answer",
    transcriptEvidence: "- candidate: Can you explain that function?",
    currentQuestionHint:
      "Follow-up to selected answer: Can you explain the function of the useEffect hook? User asks: Can you explain that function?",
    language: "TypeScript",
    answerClickMode: "answer_followup",
    hasCodeFollowupAnchor: false,
    noCodeFollowupGuidance: false,
  });

  assert.ok(task.includes("Answer Click Mode: answer_followup"));
  assert.ok(task.includes("selected answer card"));
  assert.ok(task.includes("Do not use unrelated prior transcript/history/code"));
  assert.ok(task.includes("project architecture, system diagrams, or older topics"));
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

test("screen prompts always answer and remain compact", () => {
  const system = buildScreenSystemMessage(baseContext);
  const user = buildScreenAnalysisMessage(baseContext);

  assert.ok(system.includes("Always return a useful answer"));
  assert.ok(system.includes("Never return a no-question sentinel"));
  assert.ok(system.includes("screenshot is the sole authority"));
  assert.ok(system.includes("Never reuse a previous transcript question"));
  assert.ok(system.includes("If no explicit question is visible"));
  assert.equal(system.includes("===NO_NEW_QUESTION==="), false);
  assert.equal(user.includes("===NO_NEW_QUESTION==="), false);
  assert.ok(user.includes("===NEXT_QUESTION==="));
  assert.ok(user.includes("Ignore questions from earlier conversation turns"));
  assert.ok(system.length < 2400);
  assert.ok(user.length < 900);
  assert.equal(user.includes("Banking Gateway"), false);
});
