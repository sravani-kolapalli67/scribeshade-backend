import { readFileSync, writeFileSync } from "fs";
import { randomUUID } from "crypto";
import path from "path";

type ReplayCase = {
  id: string;
  transcript: string;
  currentQuestion: string;
  expectedTargetHint: string;
  mustContain: string[];
  mustNotContain: string[];
};

type ReplayResult = {
  id: string;
  requestId: string;
  status: number;
  expectedTargetHint: string;
  firstChunkMs: number | null;
  totalMs: number;
  answerPreview: string;
  checks: Array<{ name: string; pass: boolean; details: string }>;
  pass: boolean;
};

type ReplayReport = {
  apiBaseUrl: string;
  sessionId: string;
  startedAt: string;
  endedAt: string;
  totalCases: number;
  passedCases: number;
  failedCases: number;
  results: ReplayResult[];
};

const API_BASE_URL = process.env.API_BASE_URL || "http://127.0.0.1:3200/api";
const SESSION_ID = process.env.LIVE_REPLAY_SESSION_ID || "";
const AUTH_BEARER = process.env.LIVE_REPLAY_AUTH_BEARER || "";
const TEST_BYPASS_KEY = process.env.TEST_BYPASS_KEY || "";
const TEST_USER_CLERK_ID = process.env.TEST_USER_CLERK_ID || "";
const REPORT_OUT =
  process.env.LIVE_REPLAY_REPORT_OUT ||
  path.resolve(process.cwd(), "docs/live-ai-answer-replay-report.json");

function createRequestId(): string {
  return randomUUID();
}

function loadParakeetExcerpt(): string {
  const filePath = path.resolve(process.cwd(), "docs/parakeet.txt");
  return readFileSync(filePath, "utf8").slice(0, 5000);
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function buildCases(): ReplayCase[] {
  const parakeetExcerpt = loadParakeetExcerpt();
  return [
    {
      id: "parakeet-profile-walkthrough",
      transcript: parakeetExcerpt,
      currentQuestion:
        "Can you walk me through your profile, experience, skill set, and projects?",
      expectedTargetHint: "profile experience skill set projects",
      mustContain: ["experience", "skill", "project"],
      mustNotContain: ["as an ai", "[candidate name]"],
    },
    {
      id: "partial-evolving-question",
      transcript:
        "Interviewer: in your current migration from legacy pipelines, data lake migration approach",
      currentQuestion: "data lake migration approach",
      expectedTargetHint: "migration approach",
      mustContain: ["migration", "approach"],
      mustNotContain: ["no new question", "as an ai"],
    },
    {
      id: "system-design",
      transcript:
        "Interviewer: Design a notification system for one million events per day and explain scaling and reliability.",
      currentQuestion:
        "Design a notification system for one million events per day and explain scaling and reliability.",
      expectedTargetHint: "notification system scaling reliability",
      mustContain: ["```text", "scal", "reliab"],
      mustNotContain: ["as an ai"],
    },
    {
      id: "code-generation",
      transcript:
        "Interviewer: Write TypeScript code for a debounce utility function and show React usage.",
      currentQuestion:
        "Write TypeScript code for a debounce utility function and show React usage.",
      expectedTargetHint: "debounce typescript react",
      mustContain: ["```", "debounce"],
      mustNotContain: ["as an ai"],
    },
  ];
}

function buildHeaders(requestId: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "x-request-id": requestId,
    "x-session-id": SESSION_ID,
    ...(AUTH_BEARER ? { Authorization: `Bearer ${AUTH_BEARER}` } : {}),
    ...(TEST_BYPASS_KEY ? { "x-test-bypass-key": TEST_BYPASS_KEY } : {}),
    ...(TEST_USER_CLERK_ID ? { "x-test-user-id": TEST_USER_CLERK_ID } : {}),
  };
}

function checksForCase(testCase: ReplayCase, answer: string): ReplayResult["checks"] {
  const normalized = normalize(answer);
  const mustContainChecks = testCase.mustContain.map((phrase) => {
    const pass = normalized.includes(normalize(phrase));
    return {
      name: `must_contain:${phrase}`,
      pass,
      details: pass ? "present" : "missing",
    };
  });
  const mustNotContainChecks = testCase.mustNotContain.map((phrase) => {
    const pass = !normalized.includes(normalize(phrase));
    return {
      name: `must_not_contain:${phrase}`,
      pass,
      details: pass ? "absent" : "found",
    };
  });
  return [...mustContainChecks, ...mustNotContainChecks];
}

async function readStream(response: Response, startedAt: number): Promise<{
  text: string;
  firstChunkMs: number | null;
}> {
  const reader = response.body?.getReader();
  if (!reader) {
    return {
      text: await response.text(),
      firstChunkMs: null,
    };
  }
  const decoder = new TextDecoder();
  let text = "";
  let firstChunkMs: number | null = null;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    if (firstChunkMs === null) firstChunkMs = Date.now() - startedAt;
    text += decoder.decode(next.value, { stream: true });
  }
  text += decoder.decode();
  return { text, firstChunkMs };
}

async function runCase(testCase: ReplayCase): Promise<ReplayResult> {
  const requestId = createRequestId();
  const startedAt = Date.now();
  const response = await fetch(`${API_BASE_URL}/session/${SESSION_ID}/ai-answer`, {
    method: "POST",
    headers: buildHeaders(requestId),
    body: JSON.stringify({
      requestId,
      sessionId: SESSION_ID,
      transcript: testCase.transcript,
      currentQuestion: testCase.currentQuestion,
      recentTranscriptWindow: testCase.transcript.split(/\n+/).slice(-20),
      answerClickMode: "answer_latest_unanswered",
      triggerSource: "manual_click",
      sourcePlatform: "web",
      aiModel: process.env.LIVE_REPLAY_AI_MODEL,
    }),
  });
  const stream = await readStream(response, startedAt);
  const checks = checksForCase(testCase, stream.text);
  const pass = response.ok && checks.every((check) => check.pass);
  return {
    id: testCase.id,
    requestId,
    status: response.status,
    expectedTargetHint: testCase.expectedTargetHint,
    firstChunkMs: stream.firstChunkMs,
    totalMs: Date.now() - startedAt,
    answerPreview: stream.text.replace(/\s+/g, " ").trim().slice(0, 900),
    checks,
    pass,
  };
}

async function main(): Promise<void> {
  if (!SESSION_ID) {
    throw new Error("LIVE_REPLAY_SESSION_ID is required");
  }
  const startedAt = new Date().toISOString();
  const results: ReplayResult[] = [];
  for (const testCase of buildCases()) {
    results.push(await runCase(testCase));
  }
  const report: ReplayReport = {
    apiBaseUrl: API_BASE_URL,
    sessionId: SESSION_ID,
    startedAt,
    endedAt: new Date().toISOString(),
    totalCases: results.length,
    passedCases: results.filter((result) => result.pass).length,
    failedCases: results.filter((result) => !result.pass).length,
    results,
  };
  writeFileSync(REPORT_OUT, `${JSON.stringify(report, null, 2)}\n`);
  if (report.failedCases > 0) {
    throw new Error(`Live replay failed ${report.failedCases}/${report.totalCases} cases. Report: ${REPORT_OUT}`);
  }
  console.log(`Live replay passed ${report.passedCases}/${report.totalCases}. Report: ${REPORT_OUT}`);
}

main()
  .catch((error) => {
    console.error("[live-ai-answer-replay] failed", error);
    process.exitCode = 1;
  });
