import test from "node:test";
import assert from "node:assert/strict";
import { decideAnswer } from "./answer-decision.service";
import { reconstructQuestion } from "./question-reconstructor.service";

test("treats introduction prompts as answerable interview questions", () => {
  const question = reconstructQuestion({
    normalizedBlocks: [
      {
        rawText: "introduce yourself?",
        cleanedText: "introduce yourself?",
        correctedText: "introduce yourself?",
        speakerType: "UNKNOWN",
        confidence: 0.72,
        corrections: [],
      },
    ],
    fallbackQuestion: "introduce yourself?",
    activeTopic: null,
  });

  assert.equal(question.shouldAnswer, true);
  assert.equal(question.intent, "behavioral");
});

test("does not silently suppress repeated clear questions in backend decision", () => {
  const question = reconstructQuestion({
    normalizedBlocks: [
      {
        rawText: "Introduce yourself.",
        cleanedText: "Introduce yourself.",
        correctedText: "Introduce yourself.",
        speakerType: "INTERVIEWER",
        confidence: 0.8,
        corrections: [],
      },
    ],
    fallbackQuestion: "Introduce yourself.",
    activeTopic: {
      id: "topic-1",
      topicTitle: "introduction",
      topicKeywords: ["introduction"],
      currentSummary: "The candidate introduced themselves.",
      lastQuestion: "Introduce yourself.",
    },
  });

  const decision = decideAnswer({
    reconstructedQuestion: question,
    activeTopic: {
      id: "topic-1",
      topicTitle: "introduction",
      topicKeywords: ["introduction"],
      currentSummary: "The candidate introduced themselves.",
      lastQuestion: "Introduce yourself.",
    },
    selectedAnswerPresent: false,
  });

  assert.equal(decision.shouldAnswer, true);
  assert.equal(decision.reason, "valid_new_question");
});

test("answers experience followups even when frontend marks them as selected-answer continuations", () => {
  const question = reconstructQuestion({
    normalizedBlocks: [
      {
        rawText: "overall experience?",
        cleanedText: "overall experience?",
        correctedText: "overall experience?",
        speakerType: "UNKNOWN",
        confidence: 1,
        corrections: [],
      },
    ],
    fallbackQuestion: "overall experience?",
    metadata: {
      selectedAnswerId: "answer-1",
      selectedAnswerQuestion: "Can you introduce yourself?",
      selectedAnswerText: "I am a React Developer based in Rajasthan.",
      selectedAnswerTopic: "react",
      activeQuestionDetection: {
        activeQuestion: "overall experience?",
        cleanedQuestion: "overall experience?",
        isFollowUp: true,
        topicChanged: false,
        confidenceScore: 1,
        ignoredNoise: false,
        referencedHistoryTurnId: "answer-1",
      },
    },
    activeTopic: null,
  });

  const decision = decideAnswer({
    reconstructedQuestion: question,
    activeTopic: null,
    selectedAnswerPresent: true,
  });

  assert.equal(question.shouldAnswer, true);
  assert.equal(question.intent, "behavioral");
  assert.equal(decision.shouldAnswer, true);
  assert.equal(decision.reason, "valid_followup");
});

test("uses transcript evidence when active detection is only a weak trailing fragment", () => {
  const question = reconstructQuestion({
    normalizedBlocks: [
      {
        rawText: "Okay. So what is your current and overall experience?",
        cleanedText: "Okay. So what is your current and overall experience?",
        correctedText: "Okay. So what is your current and overall experience?",
        speakerType: "CANDIDATE",
        confidence: 1,
        corrections: [],
      },
      {
        rawText: "And also what is the relevant experience on MERN stack.",
        cleanedText: "And also what is the relevant experience on MERN stack.",
        correctedText: "And also what is the relevant experience on MERN stack.",
        speakerType: "CANDIDATE",
        confidence: 1,
        corrections: [],
      },
    ],
    fallbackQuestion: "on Murnstadt.",
    metadata: {
      activeQuestionDetection: {
        activeQuestion: "on Murnstadt.",
        cleanedQuestion: "on Murnstadt.",
        isFollowUp: false,
        topicChanged: false,
        confidenceScore: 1,
        ignoredNoise: false,
      },
    },
    activeTopic: null,
  });

  assert.equal(question.shouldAnswer, true);
  assert.equal(question.intent, "behavioral");
  assert.match(question.displayQuestion, /overall experience/i);
  assert.match(question.displayQuestion, /relevant experience/i);
});

test("answers questions starting with conjunctions or fillers", () => {
  const question = reconstructQuestion({
    normalizedBlocks: [
      {
        rawText: "And what is difference between Redux? And context API?",
        cleanedText: "And what is difference between Redux? And context API?",
        correctedText: "And what is difference between Redux? And context API?",
        speakerType: "UNKNOWN",
        confidence: 0.9,
        corrections: [],
      },
    ],
    fallbackQuestion: "And what is difference between Redux? And context API?",
    activeTopic: null,
  });

  assert.equal(question.shouldAnswer, true);
  assert.equal(question.intent, "technical_concept");
  assert.equal(question.displayQuestion, "And what is difference between Redux? And context API?");
});

test("filler-only transcript is not answerable metadata", () => {
  const question = reconstructQuestion({
    normalizedBlocks: [
      {
        rawText: "Okay.",
        cleanedText: "Okay.",
        correctedText: "Okay.",
        speakerType: "UNKNOWN",
        confidence: 0.95,
        corrections: [],
      },
    ],
    fallbackQuestion: "Okay.",
    activeTopic: null,
  });

  const decision = decideAnswer({
    reconstructedQuestion: question,
    activeTopic: null,
    selectedAnswerPresent: false,
  });

  assert.equal(question.intent, "noise");
  assert.equal(question.shouldAnswer, false);
  assert.equal(question.reason, "low_confidence_noise");
  assert.equal(decision.shouldAnswer, false);
  assert.equal(decision.reason, "low_confidence_noise");
});

test("short unsupported followup without selected or history target is not answerable metadata", () => {
  const question = reconstructQuestion({
    normalizedBlocks: [
      {
        rawText: "that function?",
        cleanedText: "that function?",
        correctedText: "that function?",
        speakerType: "UNKNOWN",
        confidence: 0.9,
        corrections: [],
      },
    ],
    fallbackQuestion: "that function?",
    activeTopic: null,
  });

  const decision = decideAnswer({
    reconstructedQuestion: question,
    activeTopic: null,
    selectedAnswerPresent: false,
  });

  assert.equal(question.isFollowUp, true);
  assert.equal(question.shouldAnswer, false);
  assert.equal(question.reason, "missing_followup_target");
  assert.equal(decision.shouldAnswer, false);
  assert.equal(decision.reason, "missing_followup_target");
});
