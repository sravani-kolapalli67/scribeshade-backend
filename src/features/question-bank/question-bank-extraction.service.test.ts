import assert from "node:assert/strict";
import test from "node:test";
import {
  QuestionBankDifficulty,
  QuestionBankPrivacyRisk,
  QuestionBankQuestionType,
  QuestionBankVisibilityClass,
} from "@prisma/client";
import { ZodError } from "zod";
import {
  extractedQuestionSchema,
  extractionResponseSchema,
} from "./question-bank-extraction.service";

const VALID_QUESTION = {
  rawDetectedQuestion: "How does garbage collection work in Go?",
  normalizedQuestion: "How does garbage collection work in Go?",
  visibilityClass: QuestionBankVisibilityClass.VALID_INTERVIEW_QUESTION,
  privacyRisk: QuestionBankPrivacyRisk.LOW,
  questionType: QuestionBankQuestionType.TECHNICAL_CONCEPT,
  difficulty: QuestionBankDifficulty.MEDIUM,
  complexityScore: 55,
  technologies: ["Go"],
  topics: ["Memory Management", "Garbage Collection"],
  confidence: 0.92,
};

test("valid extraction question passes schema", () => {
  const result = extractedQuestionSchema.parse(VALID_QUESTION);
  assert.equal(result.rawDetectedQuestion, VALID_QUESTION.rawDetectedQuestion);
  assert.equal(result.confidence, 0.92);
  assert.deepEqual(result.technologies, ["Go"]);
});

test("missing technologies and topics arrays default to []", () => {
  const { technologies: _t, topics: _top, ...withoutArrays } = VALID_QUESTION;
  const result = extractedQuestionSchema.parse(withoutArrays);
  assert.deepEqual(result.technologies, []);
  assert.deepEqual(result.topics, []);
});

test("empty technologies and topics arrays are accepted", () => {
  const result = extractedQuestionSchema.parse({
    ...VALID_QUESTION,
    technologies: [],
    topics: [],
  });
  assert.deepEqual(result.technologies, []);
  assert.deepEqual(result.topics, []);
});

test("malformed question missing required fields throws ZodError, not a runtime crash", () => {
  assert.throws(
    () =>
      extractedQuestionSchema.parse({
        questionText: "What is a goroutine?",
        level: "medium",
        tech: ["Go"],
      }),
    ZodError,
  );
});

test("malformed question missing rawDetectedQuestion throws ZodError", () => {
  const { rawDetectedQuestion: _r, ...without } = VALID_QUESTION;
  assert.throws(() => extractedQuestionSchema.parse(without), ZodError);
});

test("malformed question missing normalizedQuestion throws ZodError", () => {
  const { normalizedQuestion: _n, ...without } = VALID_QUESTION;
  assert.throws(() => extractedQuestionSchema.parse(without), ZodError);
});

test("malformed question missing confidence throws ZodError", () => {
  const { confidence: _c, ...without } = VALID_QUESTION;
  assert.throws(() => extractedQuestionSchema.parse(without), ZodError);
});

test("complexityScore outside 0–100 throws ZodError", () => {
  assert.throws(
    () => extractedQuestionSchema.parse({ ...VALID_QUESTION, complexityScore: 150 }),
    ZodError,
  );
  assert.throws(
    () => extractedQuestionSchema.parse({ ...VALID_QUESTION, complexityScore: -1 }),
    ZodError,
  );
});

test("confidence outside 0–1 throws ZodError", () => {
  assert.throws(
    () => extractedQuestionSchema.parse({ ...VALID_QUESTION, confidence: 1.5 }),
    ZodError,
  );
});

test("valid extraction response with multiple questions passes", () => {
  const response = extractionResponseSchema.parse({
    questions: [
      VALID_QUESTION,
      {
        ...VALID_QUESTION,
        rawDetectedQuestion: "Explain the CAP theorem.",
        normalizedQuestion: "Explain the CAP theorem.",
        questionType: QuestionBankQuestionType.SYSTEM_DESIGN,
        technologies: [],
        topics: ["Distributed Systems"],
        confidence: 0.88,
      },
    ],
  });
  assert.equal(response.questions.length, 2);
});

test("extraction response with empty questions array passes", () => {
  const response = extractionResponseSchema.parse({ questions: [] });
  assert.equal(response.questions.length, 0);
});

test("extraction response where individual question omits optional arrays normalises them to []", () => {
  const { technologies: _t, topics: _top, ...withoutArrays } = VALID_QUESTION;
  const response = extractionResponseSchema.parse({ questions: [withoutArrays] });
  assert.deepEqual(response.questions[0]?.technologies, []);
  assert.deepEqual(response.questions[0]?.topics, []);
});

test("extraction response missing questions key throws ZodError", () => {
  assert.throws(
    () => extractionResponseSchema.parse({ items: [VALID_QUESTION] }),
    ZodError,
  );
});

test("extraction response where questions is not an array throws ZodError", () => {
  assert.throws(
    () => extractionResponseSchema.parse({ questions: VALID_QUESTION }),
    ZodError,
  );
});

test("invalid visibilityClass enum value throws ZodError", () => {
  assert.throws(
    () => extractedQuestionSchema.parse({ ...VALID_QUESTION, visibilityClass: "PUBLISHABLE" }),
    ZodError,
  );
});

test("invalid difficulty enum value throws ZodError", () => {
  assert.throws(
    () => extractedQuestionSchema.parse({ ...VALID_QUESTION, difficulty: "beginner" }),
    ZodError,
  );
});
