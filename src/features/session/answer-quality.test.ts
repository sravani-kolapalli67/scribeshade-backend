import test from "node:test";
import assert from "node:assert/strict";
import {
  guardCurrentQuestion,
  resolveFollowupTarget,
  selectTargetCodeContext,
  toAnswerHistory,
  shouldSuppressExperienceForQuestion,
  classifyConversationIntent,
  isFollowupConversationIntent,
  normalizeTranscriptForQuestionDetection,
} from "./answer-quality";

test("guards polluted joined question without over-truncating multipart", () => {
  const out = guardCurrentQuestion({
    resolvedQuestion: "What is Postgres C plus What is a Postgres SQL?",
    recentTranscriptWindow: ["[Interviewer]: What is a Postgres SQL?"],
  });
  assert.equal(out.questionPollutionDetected, true);
  assert.match(out.resolvedCurrentQuestion, /what is a postgresql sql\?/i);

  const multi = guardCurrentQuestion({
    resolvedQuestion: "Explain ACID properties and isolation levels in PostgreSQL",
  });
  assert.equal(multi.questionPollutionDetected, false);
  assert.match(multi.resolvedCurrentQuestion, /ACID/i);
});

test("reconstructs weak backend deictic followup from transcript window", () => {
  const out = guardCurrentQuestion({
    resolvedQuestion: "that approach?",
    recentTranscriptWindow: [
      "[Interviewer]: In your previous project",
      "[Interviewer]: you mentioned you used MongoDB",
      "[Interviewer]: to track user events.",
      "[Interviewer]: Can you explain that approach?",
    ],
  });
  assert.equal(out.weakQuestionReconstructedBackend, true);
  assert.match(out.reconstructedResolvedQuestion, /mongodb/i);
  assert.match(out.reconstructedResolvedQuestion, /user events?/i);
});

test("prefers relevant historical SQL code target over latest unrelated answer", () => {
  const history = toAnswerHistory([
    {
      messageId: "a1",
      role: "AI_ASSISTANT",
      question: "Write SQL query",
      answer: "Use:\n```sql\nSELECT * FROM table_name;\n```",
      timestamp: new Date("2026-05-21T10:00:00Z").toISOString(),
    },
    {
      messageId: "a2",
      role: "AI_ASSISTANT",
      question: "What is React",
      answer: "React is a UI library",
      timestamp: new Date("2026-05-21T10:01:00Z").toISOString(),
    },
  ]);

  const target = resolveFollowupTarget({
    question: "Explain first line of your code",
    history,
  });

  assert.equal(target.target?.id, "a1");
  assert.equal(target.source, "topic_match");
  assert.equal(target.isExplicitFollowupReference, true);

  const codeCtx = selectTargetCodeContext(target.target || null);
  assert.equal(codeCtx.language, "sql");
  assert.match(codeCtx.preview || "", /SELECT \*/i);
});

test("sql followup beats unrelated resume-like pyspark context", () => {
  const history = toAnswerHistory([
    {
      messageId: "sql-1",
      role: "AI_ASSISTANT",
      question: "Implement SQL query that fetches data from a table",
      answer: "```sql\nSELECT * FROM table_name;\n```",
      timestamp: new Date("2026-05-21T10:00:00Z").toISOString(),
    },
    {
      messageId: "resume-ctx",
      role: "AI_ASSISTANT",
      question: "Tell me about your background",
      answer: "I used PySpark in data lake pipelines at scale.",
      timestamp: new Date("2026-05-21T10:02:00Z").toISOString(),
    },
  ]);

  const followup = resolveFollowupTarget({
    question: "Explain the first line of your code",
    history,
  });
  const codeCtx = selectTargetCodeContext(followup.target);

  assert.equal(followup.target?.id, "sql-1");
  assert.equal(codeCtx.language, "sql");
  assert.doesNotMatch(codeCtx.preview || "", /pyspark|datalake/i);
});

test("selected answer id is ignored when topic mismatches reconstructed question", () => {
  const history = toAnswerHistory([
    {
      messageId: "react-1",
      role: "AI_ASSISTANT",
      question: "What is React",
      answer: "React is a UI library",
      timestamp: new Date("2026-05-21T10:00:00Z").toISOString(),
    },
    {
      messageId: "sql-2",
      role: "AI_ASSISTANT",
      question: "Write SQL query",
      answer: "```sql\nSELECT id FROM users;\n```",
      timestamp: new Date("2026-05-21T10:01:00Z").toISOString(),
    },
  ]);

  const target = resolveFollowupTarget({
    question: "In your previous project, explain MongoDB user events approach",
    history,
    selectedAnswerId: "react-1",
    selectedAnswerTopic: "react",
  });

  assert.notEqual(target.target?.id, "react-1");
  assert.equal(target.selectedAnswerIgnoredReason, "topic_mismatch");
  assert.equal(target.source, "topic_match");
  assert.equal(target.isExplicitFollowupReference, true);
});

test("selected answer id is used when explicitly referenced", () => {
  const history = toAnswerHistory([
    {
      messageId: "react-1",
      role: "AI_ASSISTANT",
      question: "What is React",
      answer: "React is a UI library",
      timestamp: new Date("2026-05-21T10:00:00Z").toISOString(),
    },
    {
      messageId: "mongo-2",
      role: "AI_ASSISTANT",
      question: "MongoDB tracking",
      answer: "Use MongoDB event collections",
      timestamp: new Date("2026-05-21T10:01:00Z").toISOString(),
    },
  ]);

  const target = resolveFollowupTarget({
    question: "Explain this selected answer card in detail",
    history,
    selectedAnswerId: "react-1",
    selectedAnswerTopic: "react",
  });
  assert.equal(target.target?.id, "react-1");
  assert.equal(target.source, "selected_answer");
});

test("code followup with no code target returns none", () => {
  const history = toAnswerHistory([
    {
      messageId: "react-only",
      role: "AI_ASSISTANT",
      question: "What is React",
      answer: "React is declarative UI library.",
      timestamp: new Date("2026-05-21T10:00:00Z").toISOString(),
    },
  ]);

  const target = resolveFollowupTarget({
    question: "Explain the query you wrote before",
    history,
  });
  assert.equal(target.target, null);
  assert.equal(target.source, "none");
  assert.equal(target.reasonForNoTarget, "explicit_code_followup_but_no_code_target");
  assert.equal(target.isExplicitFollowupReference, true);
});

test("fresh concept question does not bind memory", () => {
  const history = toAnswerHistory([
    {
      messageId: "old-react",
      role: "AI_ASSISTANT",
      question: "What is React",
      answer: "React is a UI library",
      timestamp: new Date("2026-05-21T10:00:00Z").toISOString(),
    },
  ]);

  const target = resolveFollowupTarget({
    question: "What is PostgreSQL?",
    history,
    selectedAnswerId: "old-react",
  });

  assert.equal(target.source, "none");
  assert.equal(target.target, null);
  assert.equal(target.isExplicitFollowupReference, false);
  assert.equal(
    target.selectedAnswerIgnoredReason,
    "fresh_question_no_followup_reference",
  );
  assert.equal(target.reasonForNoTarget, "fresh_question_no_followup_reference");
});

test("immediate_previous only for vague deictic followups", () => {
  const history = toAnswerHistory([
    {
      messageId: "react-1",
      role: "AI_ASSISTANT",
      question: "What is React",
      answer: "React is declarative UI",
      timestamp: new Date("2026-05-21T10:00:00Z").toISOString(),
    },
  ]);

  const target = resolveFollowupTarget({
    question: "continue",
    history,
  });

  assert.equal(target.source, "immediate_previous");
  assert.equal(target.target?.id, "react-1");
  assert.equal(target.isExplicitFollowupReference, true);
});

test("required followup signals are treated as followups", () => {
  const history = toAnswerHistory([
    {
      messageId: "spark-1",
      role: "AI_ASSISTANT",
      question: "How did you optimize PySpark jobs?",
      answer: "I used partition tuning and coalesce().",
      timestamp: new Date("2026-05-21T10:00:00Z").toISOString(),
    },
  ]);

  const target = resolveFollowupTarget({
    question: "how exactly did you do that?",
    history,
  });

  assert.equal(target.isExplicitFollowupReference, true);
  assert.notEqual(target.source, "none");
});

test("technical code followup phrases bind to latest prior code", () => {
  const history = toAnswerHistory([
    {
      messageId: "sql-gap",
      role: "AI_ASSISTANT",
      question: "Write a SQL query to find inactive customer gaps",
      answer: "```sql\nWITH gaps AS (SELECT customer_id, txn_date, LAG(txn_date) OVER (PARTITION BY customer_id ORDER BY txn_date) AS prev_txn_date FROM txns) SELECT * FROM gaps;\n```",
      timestamp: new Date("2026-05-21T10:00:00Z").toISOString(),
    },
  ]);

  const target = resolveFollowupTarget({
    question: "Can you explain the code again?",
    history,
  });

  assert.equal(target.isExplicitFollowupReference, true);
  assert.equal(target.target?.id, "sql-gap");
  assert.equal(target.source, "topic_match");
  assert.equal(classifyConversationIntent("Can you explain the code again?"), "EXPLAIN_CODE");
});

test("scenario continuation phrases are treated as followups", () => {
  const history = toAnswerHistory([
    {
      messageId: "mern-scenario",
      role: "AI_ASSISTANT",
      question: "How would you design a MERN app for high traffic?",
      answer: "I would split API, cache, and database responsibilities.",
      timestamp: new Date("2026-05-21T10:00:00Z").toISOString(),
    },
  ]);

  const target = resolveFollowupTarget({
    question: "continue from database part",
    history,
  });

  assert.equal(target.isExplicitFollowupReference, true);
  assert.equal(target.target?.id, "mern-scenario");
  assert.equal(target.source, "immediate_previous");
  assert.equal(isFollowupConversationIntent(classifyConversationIntent("continue from database part")), true);
});

test("transcript normalization is conservative around protected code and paths", () => {
  const normalized = normalizeTranscriptForQuestionDetection(
    "Explain postgre sequel but keep `postgre sequel` and /api/postgre-sequel/v1 unchanged",
  );

  assert.match(normalized, /PostgreSQL/);
  assert.match(normalized, /`postgre sequel`/);
  assert.match(normalized, /\/api\/postgre-sequel\/v1/);
});

test("concept vs experience detection helper", () => {
  assert.equal(shouldSuppressExperienceForQuestion("What is PostgreSQL?"), true);
  assert.equal(
    shouldSuppressExperienceForQuestion("How have you used PostgreSQL in your project?"),
    false,
  );
  assert.equal(
    shouldSuppressExperienceForQuestion("How many years of experience do you have?"),
    false,
  );
});
