import fs from "node:fs";
import path from "node:path";

type Sender = "Interviewer" | "User";

type Event =
  | { t: number; sender: Sender; text: string }
  | {
      t: number;
      click: true;
      expectNoQuestion?: boolean;
      expectedQuestionContains?: string[];
      expectedFollowUp?: boolean;
      expectedReferenceId?: string;
      expectedTopicChanged?: boolean;
    }
  | {
      t: number;
      seedSelectedAnswer: { id: string; question: string; text: string };
    };

type SessionFixture = {
  name: string;
  events: Event[];
};

type Fixture = { sessions: SessionFixture[] };

type Message = { sender: Sender; text: string; timestamp: number };

type Detection = {
  activeQuestion: string;
  cleanedQuestion: string;
  isFollowUp: boolean;
  topicChanged: boolean;
  confidenceScore: number;
  ignoredNoise: boolean;
  referencedHistoryTurnId?: string;
  source: "live_interim" | "transcript_history" | "user_transcript" | "transcript_fallback" | "none";
};

const CONFIDENCE_THRESHOLD = 0.58;
const CONNECTOR_RE = /\b(and|then|also|plus|because|so)\s*$/i;
const FOLLOWUP_SIGNAL_RE =
  /\b(how exactly|explain more|you mentioned|same thing|continue|what about that|why did|why was|why was that|why that)\b/i;
const WEAK_DEICTIC_RE = /^(that|it|this|continue|same thing)\??$/i;
const NOISE_RE = /\b(uh|um|yeah|okay|one minute|wait a minute|can you hear me|are you audible|aadhaar|pan)\b/i;

function norm(s: string): string {
  return (s || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

function isQuestionLike(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (t.includes("?")) return true;
  return /^(what|why|how|when|where|which|who|can|could|would|should|is|are|do|does|did|explain|show|give|write)\b/i.test(t);
}

function isLikelyIncomplete(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  if (t.endsWith("?")) return false;
  if (CONNECTOR_RE.test(t)) return true;
  if (/\b(for|to|of|in|and|or)\s*$/i.test(t)) return true;
  if (/^(what is|what is the|how to|can you|could you|explain)\s*$/i.test(t)) return true;
  if (t.split(/\s+/).length < 4 && !isQuestionLike(t)) return true;
  return false;
}

function deriveTopic(text: string): string {
  const t = norm(text);
  if (/\b(databricks|pyspark|spark)\b/.test(t)) return "spark";
  if (/\b(adf|azure devops|azure)\b/.test(t)) return "azure";
  if (/\b(react|hooks)\b/.test(t)) return "react";
  if (/\b(sql|query)\b/.test(t)) return "sql";
  return "general";
}

function mergeChunks(chunks: string[]): string {
  return chunks.reduce((acc, cur) => {
    const c = cur.trim();
    if (!c) return acc;
    if (!acc.length) return c;
    if (CONNECTOR_RE.test(acc)) return `${acc} ${c}`.replace(/\s+/g, " ").trim();
    return `${acc} ${c}`.replace(/\s+/g, " ").trim();
  }, "");
}

function detectActiveQuestion(input: {
  liveInterimText: string;
  allMessages: Message[];
  cutoffTimestamp: number;
  selectedAnswerQuestion?: string;
  selectedAnswerId?: string;
}): Detection {
  const selected = input.selectedAnswerQuestion || "";

  const build = (candidate: string, source: Detection["source"], baseConfidence: number): Detection => {
    const cleaned = candidate.trim().replace(/\s+/g, " ");
    const incomplete = isLikelyIncomplete(cleaned);
    const isNoise = !cleaned || NOISE_RE.test(norm(cleaned));
    const semanticFollowup = FOLLOWUP_SIGNAL_RE.test(cleaned);
    const isFollowUp = semanticFollowup && !WEAK_DEICTIC_RE.test(cleaned);
    const currentTopic = deriveTopic(cleaned);
    const selectedTopic = deriveTopic(selected);
    const topicChanged =
      !!selected &&
      currentTopic !== "general" &&
      selectedTopic !== "general" &&
      currentTopic !== selectedTopic &&
      !isFollowUp;
    const confidenceScore = Math.max(
      0,
      Math.min(1, baseConfidence - (incomplete ? 0.28 : 0) - (isNoise ? 0.3 : 0)),
    );
    return {
      activeQuestion: cleaned,
      cleanedQuestion: cleaned,
      isFollowUp,
      topicChanged,
      confidenceScore,
      ignoredNoise: isNoise,
      referencedHistoryTurnId: isFollowUp && input.selectedAnswerId ? input.selectedAnswerId : undefined,
      source,
    };
  };

  const live = input.liveInterimText.trim();
  if (live && !NOISE_RE.test(norm(live))) {
    return build(live, "live_interim", isQuestionLike(live) ? 0.8 : 0.65);
  }

  const recent = input.allMessages.filter((m) => m.timestamp > input.cutoffTimestamp);
  const interviewer = mergeChunks(recent.filter((m) => m.sender === "Interviewer").map((m) => m.text));
  if (interviewer) {
    const segments = interviewer.split(/(?<=[?.!])\s+/).filter(Boolean);
    const scored = segments.map((s) => ({
      part: s,
      score:
        (isLikelyIncomplete(s) ? 0 : 2) +
        (isQuestionLike(s) ? 2 : 0) +
        ((s.match(/\b(databricks|pyspark|spark|adf|azure devops|experience|role)\b/gi) || []).length),
    }));
    const bestByScore = scored.sort((a, b) => b.score - a.score)[0]?.part || interviewer;
    let best =
      bestByScore.length >= Math.max(36, interviewer.length * 0.45)
        ? bestByScore
        : interviewer;
    const roleTail = segments.find((s) => /\bwhat is your role\b/i.test(s));
    if (roleTail && !best.toLowerCase().includes("what is your role")) {
      best = `${best.replace(/[?.!\s]*$/, "")} and ${roleTail.replace(/^\s*(and\s+)?/i, "")}`;
    }
    return build(best, "transcript_history", isQuestionLike(best) ? 0.78 : 0.64);
  }

  const user = mergeChunks(recent.filter((m) => m.sender === "User").map((m) => m.text));
  if (user) {
    return build(user, "user_transcript", isQuestionLike(user) ? 0.72 : 0.58);
  }

  const fallback = mergeChunks(input.allMessages.slice(-12).map((m) => m.text));
  if (fallback) {
    const seg = fallback.split(/(?<=[?.!])\s+/).reverse().find((s) => isQuestionLike(s)) || fallback;
    return build(seg, "transcript_fallback", isQuestionLike(seg) ? 0.68 : 0.5);
  }

  return {
    activeQuestion: "",
    cleanedQuestion: "",
    isFollowUp: false,
    topicChanged: false,
    confidenceScore: 0,
    ignoredNoise: true,
    source: "none",
  };
}

function formatAnswer(question: string): string {
  return [
    "**QUESTION:**",
    question,
    "",
    "**ANSWER:**",
    "- **Databricks** and **PySpark** are my primary stack.",
    "- I orchestrate with **ADF** and deploy via **Azure DevOps**.",
    "- We process **1TB+** daily and improved runtime by **40%**.",
    "- Typical cleanup includes **coalesce()**, **current_date()**, and **withColumnRenamed()**.",
  ].join("\n");
}

function checkReadability(answer: string) {
  return {
    hasQuestionMarker: answer.includes("**QUESTION:**"),
    hasAnswerMarker: answer.includes("**ANSWER:**"),
    hasBoldKeywords:
      /\*\*Databricks\*\*/.test(answer) &&
      /\*\*PySpark\*\*/.test(answer) &&
      /\*\*ADF\*\*/.test(answer) &&
      /\*\*Azure DevOps\*\*/.test(answer),
    hasBoldMetrics: /\*\*1TB\+\*\*/.test(answer) && /\*\*40%\*\*/.test(answer),
    hasBoldFunctions:
      /\*\*coalesce\(\)\*\*/.test(answer) &&
      /\*\*current_date\(\)\*\*/.test(answer) &&
      /\*\*withColumnRenamed\(\)\*\*/.test(answer),
    hasInlineBulletSpam: /•.+•/.test(answer),
  };
}

function assertExpected(detection: Detection, event: Extract<Event, { click: true }>) {
  const failures: string[] = [];
  if (event.expectNoQuestion) {
    if (!detection.ignoredNoise && detection.confidenceScore >= CONFIDENCE_THRESHOLD) {
      failures.push("expected no-question path but detector considered it valid");
    }
    return failures;
  }
  if (event.expectedQuestionContains) {
    for (const token of event.expectedQuestionContains) {
      if (!norm(detection.cleanedQuestion).includes(norm(token))) {
        failures.push(`expected question to contain '${token}'`);
      }
    }
  }
  if (typeof event.expectedFollowUp === "boolean" && detection.isFollowUp !== event.expectedFollowUp) {
    failures.push(`expected isFollowUp=${event.expectedFollowUp} but got ${detection.isFollowUp}`);
  }
  if (event.expectedReferenceId && detection.referencedHistoryTurnId !== event.expectedReferenceId) {
    failures.push(
      `expected referencedHistoryTurnId=${event.expectedReferenceId} but got ${detection.referencedHistoryTurnId || "none"}`,
    );
  }
  if (typeof event.expectedTopicChanged === "boolean" && detection.topicChanged !== event.expectedTopicChanged) {
    failures.push(`expected topicChanged=${event.expectedTopicChanged} but got ${detection.topicChanged}`);
  }
  return failures;
}

async function main() {
  const fixturesPath = path.resolve(
    process.cwd(),
    "src/shared/scripts/fixtures/active-question-replay-fixtures.json",
  );
  const raw = fs.readFileSync(fixturesPath, "utf-8");
  const fixture = JSON.parse(raw) as Fixture;

  let totalClicks = 0;
  let passedClicks = 0;
  let falseFollowup = 0;
  let noiseSuppressed = 0;
  const details: any[] = [];

  for (const session of fixture.sessions) {
    const messages: Message[] = [];
    let selectedAnswerQuestion = "";
    let selectedAnswerId = "";
    let lastAnswerAt: number | null = null;

    for (const ev of session.events) {
      if ("sender" in ev) {
        messages.push({ sender: ev.sender, text: ev.text, timestamp: ev.t });
        continue;
      }
      if ("seedSelectedAnswer" in ev) {
        selectedAnswerQuestion = ev.seedSelectedAnswer.question;
        selectedAnswerId = ev.seedSelectedAnswer.id;
        continue;
      }
      if ("click" in ev && ev.click) {
        totalClicks += 1;
        const cutoff =
          lastAnswerAt !== null
            ? Math.min(lastAnswerAt, ev.t - 5000)
            : ev.t - 120_000;
        const detection = detectActiveQuestion({
          liveInterimText: "",
          allMessages: messages,
          cutoffTimestamp: cutoff,
          selectedAnswerQuestion,
          selectedAnswerId,
        });
        const failures = assertExpected(detection, ev);
        if (detection.isFollowUp && !ev.expectedFollowUp) falseFollowup += 1;
        if (detection.ignoredNoise || detection.confidenceScore < CONFIDENCE_THRESHOLD) noiseSuppressed += 1;

        const rendered = formatAnswer(detection.cleanedQuestion || "NO_NEW_QUESTION");
        const readability = checkReadability(rendered);
        if (!readability.hasQuestionMarker || !readability.hasAnswerMarker || readability.hasInlineBulletSpam) {
          failures.push("format quality check failed");
        }
        if (!readability.hasBoldKeywords || !readability.hasBoldMetrics || !readability.hasBoldFunctions) {
          failures.push("deterministic highlight check failed");
        }

        const pass = failures.length === 0;
        if (pass) passedClicks += 1;
        details.push({
          session: session.name,
          t: ev.t,
          detection,
          pass,
          failures,
          readability,
          rendered,
        });
        if (pass && !ev.expectNoQuestion) {
          lastAnswerAt = ev.t;
          selectedAnswerQuestion = detection.cleanedQuestion;
        }
      }
    }
  }

  const scorecard = {
    totalClicks,
    passedClicks,
    failedClicks: totalClicks - passedClicks,
    questionDetectionCorrectness: totalClicks ? Number(((passedClicks / totalClicks) * 100).toFixed(2)) : 0,
    falseFollowupRate: totalClicks ? Number(((falseFollowup / totalClicks) * 100).toFixed(2)) : 0,
    noiseTriggerRate: totalClicks ? Number(((noiseSuppressed / totalClicks) * 100).toFixed(2)) : 0,
  };

  console.log("=== Active Question Replay Scorecard ===");
  console.log(JSON.stringify(scorecard, null, 2));
  console.log("\n=== Click Details ===");
  for (const item of details) {
    console.log(
      `- [${item.session}] t=${item.t} pass=${item.pass} question="${item.detection.cleanedQuestion || "NO_NEW_QUESTION"}"`,
    );
    if (!item.pass) {
      console.log(`  failures: ${item.failures.join("; ")}`);
    }
  }

  const reportPath = path.resolve(
    process.cwd(),
    "docs/active-question-replay-report.json",
  );
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify({ scorecard, details }, null, 2));
  console.log(`\nSaved report: ${reportPath}`);

  if (scorecard.failedClicks > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
