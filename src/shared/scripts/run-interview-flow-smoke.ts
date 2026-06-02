import { writeFileSync } from "fs";
import path from "path";
import { PrismaClient } from "@prisma/client";

type SpeakerType = "interviewer" | "candidate";

type TranscriptEntry = {
  speakerType: SpeakerType;
  content: string;
  timestamp: number;
};

type AiHistoryEntry = {
  id: string;
  question: string;
  answer: string;
  codeBlocks: string[];
};

type TurnExpectation = {
  mustContain: string[];
  mustNotContain: string[];
  requireCodeBlock: boolean;
  requireArchitectureTextBlock: boolean;
};

type InterviewTurn = {
  id: string;
  interviewerQuestion: string;
  candidateReply: string;
  expectation: TurnExpectation;
};

type TurnResult = {
  id: string;
  question: string;
  answerPreview: string;
  checks: Array<{ check: string; pass: boolean; details: string }>;
  pass: boolean;
};

type SmokeReport = {
  apiBaseUrl: string;
  startedAt: string;
  endedAt: string;
  sessionId: string;
  userId: string;
  resumeId: string;
  projectIds: string[];
  totalTurns: number;
  passedTurns: number;
  failedTurns: number;
  turnResults: TurnResult[];
};

const prisma = new PrismaClient();
const API_BASE_URL = process.env.API_BASE_URL || "http://127.0.0.1:3200/api";
const TEST_BYPASS_KEY = process.env.TEST_BYPASS_KEY || "test-bypass-key-scribeshade-2026";
const TEST_USER_CLERK_ID = process.env.TEST_USER_CLERK_ID || "";
const REPORT_OUT =
  process.env.SMOKE_REPORT_OUT ||
  path.resolve(process.cwd(), "docs/interview-flow-smoke-report.json");

const TURNS: InterviewTurn[] = [
  {
    id: "intro-project",
    interviewerQuestion:
      "Before we start coding, introduce yourself and explain your selected project architecture in detail.",
    candidateReply: "Sure, I can walk through the project I worked on recently.",
    expectation: {
      mustContain: ["project", "architecture"],
      mustNotContain: [],
      requireCodeBlock: false,
      requireArchitectureTextBlock: true,
    },
  },
  {
    id: "code-write",
    interviewerQuestion:
      "Write TypeScript code for a debounce utility function and show practical usage in a React search input.",
    candidateReply: "Okay, I will write the debounce utility and usage.",
    expectation: {
      mustContain: ["debounce"],
      mustNotContain: [],
      requireCodeBlock: true,
      requireArchitectureTextBlock: false,
    },
  },
  {
    id: "code-followup-explain",
    interviewerQuestion:
      "Could you explain how the code you used performs and what makes it effective?",
    candidateReply: "Yes, I will explain the same code I just wrote.",
    expectation: {
      mustContain: ["code", "performance"],
      mustNotContain: ["I don't have a specific code snippet"],
      requireCodeBlock: false,
      requireArchitectureTextBlock: false,
    },
  },
  {
    id: "code-followup-related",
    interviewerQuestion:
      "How would you test that debounce logic and which edge cases would you cover?",
    candidateReply: "I will focus on timer behavior and cleanup edge cases.",
    expectation: {
      mustContain: ["test", "edge"],
      mustNotContain: [],
      requireCodeBlock: false,
      requireArchitectureTextBlock: false,
    },
  },
  {
    id: "topic-switch-behavioral",
    interviewerQuestion:
      "Switching topic now. Tell me about a conflict with a stakeholder and how you resolved it.",
    candidateReply: "I will share a stakeholder conflict example.",
    expectation: {
      mustContain: ["stakeholder", "resolved"],
      mustNotContain: [],
      requireCodeBlock: false,
      requireArchitectureTextBlock: false,
    },
  },
  {
    id: "topic-followup-behavioral",
    interviewerQuestion:
      "Related follow-up: what communication strategy did you use and what was the measurable outcome?",
    candidateReply: "I will explain the communication strategy and outcome.",
    expectation: {
      mustContain: ["communication", "outcome"],
      mustNotContain: [],
      requireCodeBlock: false,
      requireArchitectureTextBlock: false,
    },
  },
  {
    id: "topic-switch-system-design",
    interviewerQuestion:
      "New topic: design a notification system for 1 million events per day and explain scaling and reliability.",
    candidateReply: "I will outline architecture, scaling, and reliability trade-offs.",
    expectation: {
      mustContain: ["scal", "reliab"],
      mustNotContain: [],
      requireCodeBlock: false,
      requireArchitectureTextBlock: false,
    },
  },
  {
    id: "scenario-followup-db",
    interviewerQuestion:
      "Continue from the database part of that notification design and justify indexing choices.",
    candidateReply: "I will continue from database design and indexing rationale.",
    expectation: {
      mustContain: ["database", "index"],
      mustNotContain: [],
      requireCodeBlock: false,
      requireArchitectureTextBlock: false,
    },
  },
];

function normalize(text: string): string {
  return (text || "").toLowerCase();
}

function extractCodeBlocks(answer: string): string[] {
  const matches = answer.match(/```[\w-]*\n[\s\S]*?```/g);
  return matches ? matches : [];
}

function hasArchitectureTextBlock(answer: string): boolean {
  return /```text[\s\S]*?```/i.test(answer);
}

function extractQuestionBlock(answer: string): string {
  const match = answer.match(/\*\*QUESTION:\*\*\s*([\s\S]*?)\n+\*\*ANSWER:\*\*/i);
  if (!match || !match[1]) return "";
  return match[1].replace(/\s+/g, " ").trim();
}

function mustContainCheck(answer: string, phrases: string[]): Array<{ check: string; pass: boolean; details: string }> {
  const text = normalize(answer);
  return phrases.map((phrase) => {
    const pass = text.includes(normalize(phrase));
    return {
      check: `must_contain:${phrase}`,
      pass,
      details: pass ? "present" : "missing",
    };
  });
}

function mustNotContainCheck(answer: string, phrases: string[]): Array<{ check: string; pass: boolean; details: string }> {
  const text = normalize(answer);
  return phrases.map((phrase) => {
    const pass = !text.includes(normalize(phrase));
    return {
      check: `must_not_contain:${phrase}`,
      pass,
      details: pass ? "not present" : "found",
    };
  });
}

async function fetchText(
  url: string,
  method: string,
  body: unknown,
): Promise<{ status: number; text: string }> {
  const response = await fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      "x-test-bypass-key": TEST_BYPASS_KEY,
      ...(TEST_USER_CLERK_ID ? { "x-test-user-id": TEST_USER_CLERK_ID } : {}),
    },
    body: JSON.stringify(body),
  });

  const text = await response.text();
  return { status: response.status, text };
}

async function fetchJson<T>(
  url: string,
  method: string,
  body: unknown,
): Promise<T> {
  const response = await fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      "x-test-bypass-key": TEST_BYPASS_KEY,
      ...(TEST_USER_CLERK_ID ? { "x-test-user-id": TEST_USER_CLERK_ID } : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${text}`);
  }
  return JSON.parse(text) as T;
}

async function createSessionWithRecovery(
  body: Record<string, unknown>,
): Promise<{ sessionId: string }> {
  const createUrl = `${API_BASE_URL}/session/create-session`;
  const initial = await fetchText(createUrl, "POST", body);
  if (initial.status === 201 || initial.status === 200) {
    return JSON.parse(initial.text) as { sessionId: string };
  }

  if (initial.status === 409 && initial.text.includes("ACTIVE_SESSION_EXISTS:")) {
    const activeMatch = initial.text.match(/ACTIVE_SESSION_EXISTS:([a-f0-9-]{36})/i);
    const activeSessionId = activeMatch?.[1];
    if (activeSessionId) {
      await fetchText(`${API_BASE_URL}/session/${activeSessionId}/deactivate`, "POST", {});
      await fetchText(`${API_BASE_URL}/session/${activeSessionId}`, "DELETE", {});
      const retry = await fetchText(createUrl, "POST", body);
      if (retry.status === 201 || retry.status === 200) {
        return JSON.parse(retry.text) as { sessionId: string };
      }
      throw new Error(`Create session retry failed: HTTP ${retry.status} ${retry.text}`);
    }
  }

  throw new Error(`Create session failed: HTTP ${initial.status} ${initial.text}`);
}

async function resolveTestContext(): Promise<{
  userId: string;
  resumeId: string;
  projectIds: string[];
  primaryProjectId: string | null;
}> {
  const explicitUserId = process.env.SMOKE_USER_ID || "";
  const explicitResumeId = process.env.SMOKE_RESUME_ID || "";
  const explicitProjectIdsRaw = process.env.SMOKE_PROJECT_IDS || "";

  if (explicitUserId) {
    const projectIds = explicitProjectIdsRaw
      ? explicitProjectIdsRaw.split(",").map((entry) => entry.trim()).filter(Boolean).slice(0, 2)
      : [];
    return {
      userId: explicitUserId,
      resumeId: explicitResumeId,
      projectIds,
      primaryProjectId: projectIds.length > 0 ? projectIds[0] : null,
    };
  }

  const user = await prisma.user.findFirst({
    where: { resumes: { some: {} } },
    select: { id: true },
    orderBy: { createdAt: "desc" },
  });
  if (!user) {
    throw new Error("No user with resume found. Set SMOKE_USER_ID and SMOKE_RESUME_ID explicitly.");
  }

  const resume = await prisma.resume.findFirst({
    where: { userId: user.id },
    select: { id: true },
    orderBy: { uploadedAt: "desc" },
  });
  if (!resume) {
    throw new Error("No resume found for selected user.");
  }

  const projects = await prisma.project.findMany({
    where: { userId: user.id },
    select: { id: true },
    orderBy: { updatedAt: "desc" },
    take: 2,
  });
  const projectIds = projects.map((project) => project.id);

  return {
    userId: user.id,
    resumeId: resume.id,
    projectIds,
    primaryProjectId: projectIds.length > 0 ? projectIds[0] : null,
  };
}

function buildLiveContextPayload(
  question: string,
  transcriptEntries: TranscriptEntry[],
  aiHistory: AiHistoryEntry[],
): Record<string, unknown> {
  const recentTranscript = transcriptEntries.slice(-20);
  const previousAiAnswers = aiHistory.slice(-2).map((entry) => ({
    question: entry.question,
    answer: entry.answer.slice(0, 1000),
    codeBlocks: entry.codeBlocks.slice(0, 2).map((block) => block.slice(0, 1500)),
  }));
  const latestAi = aiHistory.length > 0 ? aiHistory[aiHistory.length - 1] : null;

  return {
    transcript:
      recentTranscript.length > 0
        ? recentTranscript
            .map((entry) =>
              `[${entry.speakerType === "interviewer" ? "Interviewer" : "User"}]: ${entry.content}`,
            )
            .join("\n")
        : question,
    currentQuestion: question,
    recentTranscriptWindow: recentTranscript.map((entry) =>
      `[${entry.speakerType === "interviewer" ? "Interviewer" : "User"}]: ${entry.content}`,
    ),
    speakerSeparatedTranscript: recentTranscript.map((entry) => ({
      speakerType: entry.speakerType,
      content: entry.content,
      timestamp: entry.timestamp,
    })),
    ...(previousAiAnswers.length > 0 ? { previousAiAnswers } : {}),
    ...(latestAi ? { previousAiAnswer: latestAi.answer.slice(0, 1000) } : {}),
    ...(latestAi && latestAi.codeBlocks.length > 0
      ? { previousCodeBlocks: latestAi.codeBlocks.slice(0, 2).map((block) => block.slice(0, 1500)) }
      : {}),
    ...(latestAi ? { selectedAnswerId: latestAi.id } : {}),
    ...(latestAi ? { selectedAnswerQuestion: latestAi.question.slice(0, 500) } : {}),
    ...(latestAi ? { selectedAnswerText: latestAi.answer.slice(0, 1000) } : {}),
    ...(latestAi && latestAi.codeBlocks.length > 0
      ? {
          selectedAnswerCodeBlocks: latestAi.codeBlocks
            .slice(0, 2)
            .map((block) => block.slice(0, 1500)),
        }
      : {}),
    activeQuestionDetection: {
      activeQuestion: question,
      cleanedQuestion: question,
      isFollowUp: /\b(continue|follow[- ]?up|explain|related)\b/i.test(question),
      topicChanged: /\b(switch|new topic)\b/i.test(question),
      confidenceScore: 1,
      ignoredNoise: false,
    },
    sourcePlatform: "web",
    answerMode: "auto",
  };
}

async function main(): Promise<void> {
  const startedAt = new Date();
  const context = await resolveTestContext();

  const createResponse = await createSessionWithRecovery({
    userId: context.userId,
    companyName: "SmokeTest Systems",
    jobDescription: "Senior full-stack interview with code + system design + behavioral rounds",
    resumeId: context.resumeId,
    language: "English",
    simpleLanguage: true,
    autoGenerateAI: false,
    saveTranscript: true,
    free: true,
    jobInputMode: "manual",
    projectIds: context.projectIds,
    ...(context.primaryProjectId ? { primaryProjectId: context.primaryProjectId } : {}),
  });

  const sessionId = createResponse.sessionId;
  if (!sessionId) throw new Error("Session ID missing from create-session response.");

  await fetchJson(`${API_BASE_URL}/session/${sessionId}/activate`, "POST", {});

  const transcriptEntries: TranscriptEntry[] = [];
  const aiHistory: AiHistoryEntry[] = [];
  const turnResults: TurnResult[] = [];

  for (const turn of TURNS) {
    await fetchJson(`${API_BASE_URL}/session/${sessionId}/save-message`, "POST", {
      role: "INTERVIEWER",
      question: turn.interviewerQuestion,
      answer: "",
      messageId: `smoke-int-${turn.id}`,
    });
    transcriptEntries.push({
      speakerType: "interviewer",
      content: turn.interviewerQuestion,
      timestamp: Date.now(),
    });

    if (turn.candidateReply.trim()) {
      await fetchJson(`${API_BASE_URL}/session/${sessionId}/save-message`, "POST", {
        role: "USER",
        question: turn.candidateReply,
        answer: "",
        messageId: `smoke-user-${turn.id}`,
      });
      transcriptEntries.push({
        speakerType: "candidate",
        content: turn.candidateReply,
        timestamp: Date.now(),
      });
    }

    const payload = buildLiveContextPayload(
      turn.interviewerQuestion,
      transcriptEntries,
      aiHistory,
    );
    const aiResponse = await fetchText(
      `${API_BASE_URL}/session/${sessionId}/ai-answer`,
      "POST",
      payload,
    );
    if (aiResponse.status >= 400) {
      throw new Error(
        `AI answer failed on turn ${turn.id}: HTTP ${aiResponse.status} ${aiResponse.text}`,
      );
    }

    const answerText = aiResponse.text.trim();
    aiHistory.push({
      id: `ai-${turn.id}`,
      question: turn.interviewerQuestion,
      answer: answerText,
      codeBlocks: extractCodeBlocks(answerText),
    });

    const checks: TurnResult["checks"] = [];
    checks.push(...mustContainCheck(answerText, turn.expectation.mustContain));
    checks.push(...mustNotContainCheck(answerText, turn.expectation.mustNotContain));

    const questionBlock = extractQuestionBlock(answerText);
    if (questionBlock) {
      const maxExpectedLength = Math.max(
        Math.floor(turn.interviewerQuestion.length * 2.2),
        320,
      );
      const purityByLength = questionBlock.length <= maxExpectedLength;
      checks.push({
        check: "question_block_not_overmerged",
        pass: purityByLength,
        details: `question_block_len=${questionBlock.length},max=${maxExpectedLength}`,
      });

      const previousTurnQuestions = TURNS
        .slice(0, TURNS.findIndex((entry) => entry.id === turn.id))
        .map((entry) => entry.interviewerQuestion)
        .filter((entry) => entry.length > 30);
      const containsPreviousQuestion = previousTurnQuestions.some((previousQuestion) =>
        normalize(questionBlock).includes(normalize(previousQuestion)),
      );
      checks.push({
        check: "question_block_not_containing_previous_turn",
        pass: !containsPreviousQuestion,
        details: containsPreviousQuestion ? "contains_previous_turn_question" : "clean",
      });
    }

    if (turn.expectation.requireCodeBlock) {
      const codeBlocks = extractCodeBlocks(answerText);
      checks.push({
        check: "require_code_block",
        pass: codeBlocks.length > 0,
        details: `code_blocks=${codeBlocks.length}`,
      });
    }
    if (turn.expectation.requireArchitectureTextBlock) {
      const pass = hasArchitectureTextBlock(answerText);
      checks.push({
        check: "require_architecture_text_block",
        pass,
        details: pass ? "present" : "missing",
      });
    }

    const pass = checks.every((check) => check.pass);
    turnResults.push({
      id: turn.id,
      question: turn.interviewerQuestion,
      answerPreview: answerText.slice(0, 260),
      checks,
      pass,
    });
  }

  const report: SmokeReport = {
    apiBaseUrl: API_BASE_URL,
    startedAt: startedAt.toISOString(),
    endedAt: new Date().toISOString(),
    sessionId,
    userId: context.userId,
    resumeId: context.resumeId,
    projectIds: context.projectIds,
    totalTurns: turnResults.length,
    passedTurns: turnResults.filter((result) => result.pass).length,
    failedTurns: turnResults.filter((result) => !result.pass).length,
    turnResults,
  };

  writeFileSync(REPORT_OUT, JSON.stringify(report, null, 2), "utf-8");
  console.log(`Interview flow smoke report saved: ${REPORT_OUT}`);
  console.log(
    `Pass: ${report.passedTurns}/${report.totalTurns} | Fail: ${report.failedTurns}/${report.totalTurns}`,
  );
  for (const result of report.turnResults) {
    const status = result.pass ? "PASS" : "FAIL";
    console.log(`- [${status}] ${result.id}`);
    for (const check of result.checks) {
      console.log(`    • ${check.pass ? "ok" : "x"} ${check.check} (${check.details})`);
    }
  }
}

main()
  .catch((error: unknown) => {
    console.error("Interview flow smoke test failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
