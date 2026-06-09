import assert from "node:assert/strict";
import test from "node:test";
import {
  QuestionBankDifficulty,
  QuestionBankModerationStatus,
  QuestionBankPrivacyRisk,
  QuestionBankQuestionType,
  QuestionBankSourceType,
  QuestionBankVisibility,
  QuestionBankVisibilityClass,
} from "@prisma/client";
import {
  buildSanitizedQuestion,
  normalizeQuestionText,
  parseDifficulty,
  parseQuestionType,
  slugify,
} from "./question-bank.service";

test("normalizes question bank search slugs and question text", () => {
  assert.equal(slugify("MERN Stack Developer"), "mern-stack-developer");
  assert.equal(normalizeQuestionText("Explain event loop in Node.js"), "Explain event loop in Node.js?");
});

test("parses public query enums strictly", () => {
  assert.equal(parseDifficulty("expert"), QuestionBankDifficulty.EXPERT);
  assert.equal(parseQuestionType("system-design"), QuestionBankQuestionType.SYSTEM_DESIGN);
});

test("hard rejected extraction remains private and needs review", () => {
  const sanitized = buildSanitizedQuestion({
    extracted: {
      rawDetectedQuestion: "What did you build at your current company?",
      normalizedQuestion: "What did you build at your current company?",
      visibilityClass: QuestionBankVisibilityClass.VALID_INTERVIEW_QUESTION,
      privacyRisk: QuestionBankPrivacyRisk.LOW,
      questionType: QuestionBankQuestionType.PROJECT_DEEP_DIVE,
      difficulty: QuestionBankDifficulty.MEDIUM,
      complexityScore: 45,
      technologies: ["Node.js"],
      topics: ["Architecture"],
      confidence: 0.9,
    },
    hardRejectReason: "Question contains candidate-specific resume or project context",
  });

  assert.equal(sanitized.visibility, QuestionBankVisibility.PRIVATE);
  assert.equal(sanitized.visibilityClass, QuestionBankVisibilityClass.UNSAFE_TO_PUBLISH);
  assert.equal(sanitized.privacyRisk, QuestionBankPrivacyRisk.HIGH);
  assert.equal(sanitized.moderationStatus, QuestionBankModerationStatus.NEEDS_REVIEW);
  assert.equal(sanitized.sourceType, QuestionBankSourceType.SESSION_EXTRACTED);
});

test("valid low-risk extraction is only auto-approved candidate material", () => {
  const sanitized = buildSanitizedQuestion({
    extracted: {
      rawDetectedQuestion: "Explain partitioning in Spark?",
      normalizedQuestion: "Explain partitioning in Spark?",
      visibilityClass: QuestionBankVisibilityClass.VALID_INTERVIEW_QUESTION,
      privacyRisk: QuestionBankPrivacyRisk.LOW,
      questionType: QuestionBankQuestionType.DATA_ENGINEERING,
      difficulty: QuestionBankDifficulty.MEDIUM,
      complexityScore: 50,
      technologies: ["Spark"],
      topics: ["Partitioning"],
      confidence: 0.92,
    },
  });

  assert.equal(sanitized.visibility, QuestionBankVisibility.PRIVATE);
  assert.equal(sanitized.moderationStatus, QuestionBankModerationStatus.AUTO_APPROVED);
});
