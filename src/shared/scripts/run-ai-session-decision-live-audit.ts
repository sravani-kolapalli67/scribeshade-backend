import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { OpenRouter } from "@openrouter/sdk";
import {
  buildAISessionDecisionMessages,
  decideAISessionState,
  fallbackAISessionDecision,
  toDecisionContextTargets,
  type AISessionDecision,
} from "../../features/session/ai-session-decision";
import {
  buildEffectiveLiveContextMetadata,
  classifyConversationIntent,
  resolveFollowupTarget,
  selectTargetCodeContext,
  toAnswerHistory,
} from "../../features/session/answer-quality";
import { buildRequestScopedPolicy } from "../../features/session/answer-policy";
import {
  buildAnswerTaskMessage,
  buildRuntimeContextMessage,
  buildSystemMessage,
  type AnswerPlan,
} from "../lib/prompt";

type SpeakerEntry = {
  speakerType: "interviewer" | "candidate" | "assistant" | "system";
  content: string;
  timestamp: number;
};

type ReplayTurn = {
  id: string;
  source: "interviewer" | "candidate_manual";
  input: string;
  expectation: string;
  expected: {
    intents: string[];
    contextToUse?: string[];
    targetAnswerId?: string;
    codeContextInjected?: boolean;
  };
};

type AuditMessage = {
  messageId: string;
  role: "AI_ASSISTANT";
  question: string;
  answer: string;
  timestamp: string;
};

const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) {
  throw new Error("OPENROUTER_API_KEY is required for live AI session decision audit.");
}

const model = process.env.AI_SESSION_LIVE_AUDIT_MODEL || process.env.OPENROUTER_MODEL;
if (!model) {
  throw new Error("OPENROUTER_MODEL or AI_SESSION_LIVE_AUDIT_MODEL is required.");
}

const ai = new OpenRouter({
  apiKey,
  httpReferer: "https://scribeshade.com",
  appTitle: "ScribeShade Live Audit",
});

const provider = {
  sort: "latency",
  allowFallbacks: true,
  preferredMaxLatency: 3,
  preferredMinThroughput: 30,
};

const sessionContextBase = {
  company: "Fintech Payroll Systems",
  role: "Senior Data Engineer",
  language: "SQL / Python / Spark",
  simpleLanguage: false,
  instructions:
    "Answer like a senior data engineer in a live interview. Use concrete SQL/data engineering examples. Keep Markdown format.",
  resume:
    "Candidate has 5.9 years of experience as a Data Engineer with SQL, PostgreSQL, Spark, Databricks, Azure Data Factory, ETL pipelines, and production query optimization.",
  document:
    "Recent work includes payroll/reporting pipelines, large table joins, slow query debugging, indexing, partitioning, and production incident handling.",
  projects:
    "Payroll Analytics Platform: built SQL and Spark pipelines for salary, attendance, and payroll reconciliation with PostgreSQL, Databricks, ADF, and dashboard reporting. Improved reporting latency using indexes, partitioning, and query rewrites.",
  hasSelectedProjects: true,
  projectPriorityMode: "project_questions_only",
};

const turns: ReplayTurn[] = [
  {
    id: "salary-sql",
    source: "interviewer",
    input:
      "We have employee and salary tables. In a payroll review, how would you pull active employee salary records without overcomplicating it?",
    expectation: "Generate a technical SQL answer with code.",
    expected: {
      intents: ["NEW_QUESTION"],
      contextToUse: ["none"],
      codeContextInjected: false,
    },
  },
  {
    id: "salary-sql-slow",
    source: "interviewer",
    input:
      "Okay, now same one is taking like two seconds when records are being fetched. What would you do there?",
    expectation:
      "AI decision should treat this as a follow-up to the previous SQL code and answer with query optimization, not generic theory.",
    expected: {
      intents: ["OPTIMIZE_CODE", "DEBUG_CODE"],
      contextToUse: ["previous_code", "previous_answer"],
      targetAnswerId: "salary-sql",
      codeContextInjected: true,
    },
  },
  {
    id: "salary-sql-explain",
    source: "candidate_manual",
    input: "Explain why your query changes help.",
    expectation: "Theory follow-up should stay attached to the SQL optimization context.",
    expected: {
      intents: ["FOLLOW_UP", "EXPLAIN_CODE"],
      contextToUse: ["previous_answer", "previous_code"],
      targetAnswerId: "salary-sql-slow",
    },
  },
  {
    id: "production-scenario",
    source: "interviewer",
    input:
      "Switching topic. Imagine the payroll export API slows down during month-end and users complain reports are stuck. What would you check first?",
    expectation: "New scenario/system answer, not tied to the SQL code answer as code.",
    expected: {
      intents: ["SCENARIO_QUESTION", "NEW_QUESTION"],
      contextToUse: ["none", "recent_transcript"],
      codeContextInjected: false,
    },
  },
  {
    id: "production-scenario-db-followup",
    source: "candidate_manual",
    input: "Continue from the database part of that production API scenario and make it practical.",
    expectation: "Scenario continuation should bind to the previous production scenario.",
    expected: {
      intents: ["CONTINUE_PREVIOUS", "FOLLOW_UP", "SCENARIO_QUESTION"],
      contextToUse: ["previous_answer", "recent_transcript"],
      targetAnswerId: "production-scenario",
      codeContextInjected: false,
    },
  },
  {
    id: "experience-question",
    source: "interviewer",
    input:
      "Where have you handled this kind of database or pipeline optimization in your actual projects?",
    expectation: "Experience answer should use resume/project context.",
    expected: {
      intents: ["EXPERIENCE_QUESTION"],
      contextToUse: ["recent_transcript", "previous_answer"],
      codeContextInjected: false,
    },
  },
  {
    id: "outside-context",
    source: "candidate_manual",
    input: "What is the weather in Delhi tomorrow?",
    expectation: "Fresh outside-context question should not reuse stale SQL/scenario context.",
    expected: {
      intents: ["NEW_QUESTION", "UNKNOWN"],
      contextToUse: ["none"],
      codeContextInjected: false,
    },
  },
];

function extractCodeBlocks(text: string): string[] {
  return Array.from(text.matchAll(/```[a-zA-Z0-9_-]*\n([\s\S]*?)```/g))
    .map((m) => (m[1] || "").trim())
    .filter(Boolean);
}

function buildHistoryText(messages: AuditMessage[]) {
  if (!messages.length) return "No previous interactions in this session.";
  return messages
    .slice(-6)
    .map((m, i) => {
      const answerPreview = m.answer.replace(/```[\s\S]*?```/g, "[code block]").slice(0, 700);
      return `Turn ${i + 1}\nQ: ${m.question}\nA: ${answerPreview}`;
    })
    .join("\n\n");
}

function evaluateTurn(turn: ReplayTurn, actual: {
  decision: AISessionDecision;
  answerMeta: {
    targetAnswerId: string | null;
    codeContextInjected: boolean;
  };
}) {
  const checks: Array<{
    name: string;
    passed: boolean;
    expected: Array<string | null>;
    actual: string | null;
  }> = [
    {
      name: "intent",
      passed: turn.expected.intents.includes(actual.decision.intent),
      expected: turn.expected.intents,
      actual: actual.decision.intent,
    },
  ];
  if (turn.expected.contextToUse) {
    checks.push({
      name: "contextToUse",
      passed: turn.expected.contextToUse.includes(actual.decision.contextToUse),
      expected: turn.expected.contextToUse,
      actual: actual.decision.contextToUse,
    });
  }
  if (turn.expected.targetAnswerId !== undefined) {
    checks.push({
      name: "targetAnswerId",
      passed: actual.answerMeta.targetAnswerId === turn.expected.targetAnswerId ||
        actual.decision.targetAnswerId === turn.expected.targetAnswerId,
      expected: [turn.expected.targetAnswerId],
      actual: actual.answerMeta.targetAnswerId || actual.decision.targetAnswerId || null,
    });
  }
  if (turn.expected.codeContextInjected !== undefined) {
    checks.push({
      name: "codeContextInjected",
      passed: actual.answerMeta.codeContextInjected === turn.expected.codeContextInjected,
      expected: [String(turn.expected.codeContextInjected)],
      actual: String(actual.answerMeta.codeContextInjected),
    });
  }
  return {
    passed: checks.every((c) => c.passed),
    checks,
  };
}

async function generateAnswer(params: {
  question: string;
  decision: AISessionDecision;
  messages: AuditMessage[];
  recentTranscriptWindow: string[];
  speakerSeparatedTranscript: SpeakerEntry[];
}) {
  const history = toAnswerHistory(params.messages);
  const target = params.decision.targetAnswerId
    ? history.find((h) => h.id === params.decision.targetAnswerId) || null
    : params.decision.requiresPreviousCode
      ? [...history].reverse().find((h) => h.codeBlocks.length > 0) || null
      : null;
  const codeContext = selectTargetCodeContext(target);
  const metadata = buildEffectiveLiveContextMetadata({
    question: params.question,
    selectedTarget: target,
    metadata: {
      transcript: params.question,
      recentTranscriptWindow: params.recentTranscriptWindow,
      speakerSeparatedTranscript: params.speakerSeparatedTranscript,
      previousAiAnswer: target?.answer,
      previousCodeBlocks: codeContext.codeBlocks,
      answerMode: params.decision.answerMode,
    } as any,
  });
  const context = {
    ...sessionContextBase,
    complexity: params.decision.intent === "SCENARIO_QUESTION" ? "scenario_based" : "followup",
    isProjectQuestion: params.decision.intent === "EXPERIENCE_QUESTION",
    history: buildHistoryText(params.messages),
  };
  const policy = buildRequestScopedPolicy({
    question: params.question,
    metadata,
    cieComplexity: context.complexity,
    aiDecision: params.decision,
  });
  const systemPrompt = buildSystemMessage(context);
  const runtimeContextMessage = buildRuntimeContextMessage(context);
  const answerPlan: AnswerPlan = {
    mode: "live_ai_answer",
    questions: [params.question],
    intent: policy.answerIntent,
    transcriptExcerpt: params.recentTranscriptWindow.slice(-4).join("\n"),
    ...(target
      ? {
          followupAnchor: {
            topic: target.topic || "general",
            priorQuestion: target.question,
            priorAnswerSummary: target.answer.replace(/```[\s\S]*?```/g, "[code omitted]").slice(0, 360),
            ...(codeContext.preview
              ? { codeSummary: `${codeContext.language || "code"}: ${codeContext.preview}`.slice(0, 360) }
              : {}),
          },
        }
      : {}),
    requestDeltas: [
      "Answer only the question listed above.",
      params.decision.requiresPreviousCode && codeContext.codeBlocks.length > 0
        ? "Use the follow-up anchor for prior code continuity."
        : "",
      "If the active input explicitly asks for code, provide a working implementation.",
    ].filter(Boolean),
  };
  const userMessage = buildAnswerTaskMessage(answerPlan);
  const result = ai.callModel({
    model,
    maxOutputTokens: 1600,
    provider: provider as any,
    store: false,
    input: [
      { role: "system", type: "message", content: systemPrompt },
      { role: "user", type: "message", content: runtimeContextMessage },
      { role: "user", type: "message", content: userMessage },
    ],
  });
  const answer = await result.getText();
  return {
    answer,
    targetAnswerId: target?.id || null,
    codeContextInjected: params.decision.requiresPreviousCode && codeContext.codeBlocks.length > 0,
    answerIntent: policy.answerIntent,
    answerMode: policy.effectiveAnswerMode,
  };
}

async function main() {
  const messages: AuditMessage[] = [];
  const transcript: SpeakerEntry[] = [];
  const auditTurns = [];

  for (const [idx, turn] of turns.entries()) {
    transcript.push({
      speakerType: turn.source === "interviewer" ? "interviewer" : "candidate",
      content: turn.input,
      timestamp: Date.now() + idx,
    });

    const history = toAnswerHistory(messages);
    const followup = resolveFollowupTarget({
      question: turn.input,
      history,
    });
    const conversationIntent = classifyConversationIntent(turn.input);
    const fallback = fallbackAISessionDecision({
      currentQuestion: turn.input,
      conversationIntent,
      followup,
    });
    const decisionInput = {
      currentQuestion: turn.input,
      recentTranscriptWindow: transcript.slice(-8).map((t) => `[${t.speakerType}]: ${t.content}`),
      speakerSeparatedTranscript: transcript.slice(-8),
      answerHistory: toDecisionContextTargets(history),
      deterministic: {
        conversationIntent,
        isExplicitFollowupReference: followup.isExplicitFollowupReference,
        fallbackTargetId: followup.target?.id || null,
        fallbackTargetHasCode: !!followup.target?.codeBlocks?.length,
        fallbackTargetTopic: followup.target?.topic || null,
        reasonForNoTarget: followup.reasonForNoTarget,
      },
    };
    const decisionMessages = buildAISessionDecisionMessages(decisionInput);
    const decisionResult = await decideAISessionState({
      ai,
      model,
      provider: provider as any,
      input: decisionInput,
      fallback,
      timeoutMs: Number(process.env.AI_SESSION_DECISION_TIMEOUT_MS || 10000),
    });

    const answerResult = await generateAnswer({
      question: turn.input,
      decision: decisionResult.decision,
      messages,
      recentTranscriptWindow: decisionInput.recentTranscriptWindow,
      speakerSeparatedTranscript: decisionInput.speakerSeparatedTranscript,
    });

    const messageId = turn.id;
    messages.push({
      messageId,
      role: "AI_ASSISTANT",
      question: turn.input,
      answer: answerResult.answer,
      timestamp: new Date().toISOString(),
    });

    const answerMeta = {
      targetAnswerId: answerResult.targetAnswerId,
      codeContextInjected: answerResult.codeContextInjected,
      answerIntent: answerResult.answerIntent,
      answerMode: answerResult.answerMode,
      codeBlocksExtracted: extractCodeBlocks(answerResult.answer).length,
    };
    const evaluation = evaluateTurn(turn, {
      decision: decisionResult.decision,
      answerMeta,
    });

    auditTurns.push({
      turn: idx + 1,
      id: turn.id,
      source: turn.source,
      input: turn.input,
      expectation: turn.expectation,
      decision: decisionResult.decision,
      decisionFallbackUsed: decisionResult.fallbackDecisionUsed,
      decisionError: decisionResult.error || null,
      rawDecisionResponse: decisionResult.rawResponse || null,
      decisionPrompt: {
        system: decisionMessages.system,
        user: decisionMessages.user,
      },
      answer: answerResult.answer,
      answerMeta,
      evaluation,
    });
  }

  const report = {
    auditName: "AI session decision live OpenRouter audit",
    project: "ScribeShade",
    createdAt: new Date().toISOString(),
    liveModelCall: true,
    model,
    decisionModel: process.env.AI_SESSION_DECISION_MODEL || "openai/gpt-4o-mini",
    turns: auditTurns,
    summary: {
      totalTurns: auditTurns.length,
      fallbackDecisionCount: auditTurns.filter((t) => t.decisionFallbackUsed).length,
      codeContextInjectedCount: auditTurns.filter((t) => t.answerMeta.codeContextInjected).length,
      passedTurns: auditTurns.filter((t) => t.evaluation.passed).length,
      failedTurns: auditTurns.filter((t) => !t.evaluation.passed).length,
      intents: auditTurns.map((t) => t.decision.intent),
    },
  };

  const outPath = path.resolve(process.cwd(), "docs/ai-session-decision-live-audit.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`Saved live audit: ${outPath}`);
  console.log(JSON.stringify(report.summary, null, 2));
}

main().catch((err) => {
  console.error("[live-ai-session-audit] failed", err);
  process.exit(1);
});
