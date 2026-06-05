import test from "node:test";
import assert from "node:assert/strict";
import {
  reconstructFallbackQuestion,
  resolveAuthoritativeQuestion,
  scoreQuestionCandidate,
} from "./question-quality.service";

const noisyIntroTranscript = [
  "[User]: Hello?",
  "[User]: Yeah.",
  "[User]: Let's start here.",
  "[User]: Interview.",
  "[User]: Can you introduce",
  "[User]: yourself and please introduce yourself by another",
  "[User]: That's the",
  "[User]: your progress that you have done",
].join("\n");

test("does not replace corrupted intro fragments with static runtime questions", () => {
  const result = reconstructFallbackQuestion({
    rawTranscript: noisyIntroTranscript,
    currentQuestionHint:
      "yourself and please introduce yourself by another That's the your progress that you have done",
    activeQuestionHint:
      "yourself and please introduce yourself by another That's the your progress that you have done",
    recentTranscriptWindow: noisyIntroTranscript.split("\n"),
  });

  assert.notEqual(
    result.question,
    "Introduce yourself and explain the progress/work you have done.",
  );
  assert.ok(result.question.includes("introduce"));
  assert.equal(result.source, "backend_reconstruction");
});

test("downgrades high frontend confidence for broken STT text", () => {
  const result = resolveAuthoritativeQuestion({
    currentQuestion:
      "yourself and please introduce yourself by another That's the your progress that you have done",
    transcript: noisyIntroTranscript,
    metadata: {
      activeQuestionDetection: {
        activeQuestion:
          "yourself and please introduce yourself by another That's the your progress that you have done",
        cleanedQuestion:
          "yourself and please introduce yourself by another That's the your progress that you have done",
        isFollowUp: false,
        topicChanged: false,
        confidenceScore: 1,
        ignoredNoise: false,
      },
      recentTranscriptWindow: noisyIntroTranscript.split("\n"),
    },
    isCustomQuery: false,
  });

  assert.notEqual(
    result.question,
    "Introduce yourself and explain the progress/work you have done.",
  );
  assert.equal(result.source, "backend_reconstruction");
  assert.equal(result.frontendConfidenceDowngraded, true);
});

test("keeps clean current question ahead of noisy transcript", () => {
  const result = resolveAuthoritativeQuestion({
    currentQuestion: "Can you introduce yourself?",
    transcript: noisyIntroTranscript,
    metadata: {
      activeQuestionDetection: {
        activeQuestion: "Can you introduce yourself?",
        cleanedQuestion: "Can you introduce yourself?",
        isFollowUp: false,
        topicChanged: false,
        confidenceScore: 0.86,
        ignoredNoise: false,
      },
    },
    isCustomQuery: false,
  });

  assert.equal(result.question, "Can you introduce yourself?");
  assert.equal(result.source, "currentQuestion");
});

test("scores raw transcript with repeated speaker labels as low quality", () => {
  const quality = scoreQuestionCandidate(noisyIntroTranscript);

  assert.ok(quality.score < 0.58);
  assert.ok(quality.reasons.includes("filler_present"));
});
