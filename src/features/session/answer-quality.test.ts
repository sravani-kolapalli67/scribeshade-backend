import test from "node:test";
import assert from "node:assert/strict";
import {
  guardCurrentQuestion,
  resolveFollowupTarget,
  selectTargetCodeContext,
  toAnswerHistory,
  shouldSuppressExperienceForQuestion,
  classifyConversationIntent,
  deriveTopicFromAnyText,
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

test("React hook names derive react topic", () => {
  for (const hook of ["useEffect", "useRef", "useState", "useMemo", "useCallback"]) {
    assert.equal(deriveTopicFromAnyText(`What is ${hook}?`), "react");
  }
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

test("does not over-merge standalone questions with previous interviewer turns", () => {
  const out = guardCurrentQuestion({
    resolvedQuestion:
      "Write TypeScript code for a debounce utility function and show practical usage in a React search input.",
    recentTranscriptWindow: [
      "[Interviewer]: Before we start coding, introduce yourself and explain your selected project architecture in detail.",
      "[Interviewer]: Write TypeScript code for a debounce utility function and show practical usage in a React search input.",
    ],
  });

  assert.equal(out.weakQuestionReconstructedBackend, false);
  assert.equal(
    out.resolvedCurrentQuestion,
    "Write TypeScript code for a debounce utility function and show practical usage in a React search input.",
  );
});

test("does not over-merge long explicit continue question", () => {
  const current =
    "Continue from the database part of that notification design and justify indexing choices.";
  const out = guardCurrentQuestion({
    resolvedQuestion: current,
    recentTranscriptWindow: [
      "[Interviewer]: Write TypeScript code for a debounce utility function and show practical usage in a React search input.",
      "[Interviewer]: How would you test that debounce logic and which edge cases would you cover?",
      "[Interviewer]: Switching topic now. Tell me about a conflict with a stakeholder and how you resolved it.",
      "[Interviewer]: New topic: design a notification system for 1 million events per day and explain scaling and reliability.",
    ],
  });
  assert.equal(out.resolvedCurrentQuestion, current);
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

test("selected answer id is ignored without binding unrelated fallback history", () => {
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
  assert.equal(target.target, null);
  assert.equal(target.source, "none");
  assert.equal(target.isExplicitFollowupReference, true);
});

test("strict selected followup binds selected react answer despite polluted mongodb history", () => {
  const history = toAnswerHistory([
    {
      messageId: "mongo-1",
      role: "AI_ASSISTANT",
      question: "How to implement MongoDB with Mongoose?",
      answer: "Use this schema:\n```text\nNestJS Backend -> Mongoose Schema -> MongoDB\n```",
      timestamp: new Date("2026-05-21T10:00:00Z").toISOString(),
    },
    {
      messageId: "react-1",
      role: "AI_ASSISTANT",
      question: "Can you explain the function of the useEffect hook?",
      answer: "useEffect runs side effects after render and depends on its dependency array.",
      timestamp: new Date("2026-05-21T10:01:00Z").toISOString(),
    },
  ]);

  const target = resolveFollowupTarget({
    question: "Can you explain the use that function that you have written? (in context of: Can you explain the function)",
    history,
    selectedAnswerId: "react-1",
    selectedAnswerQuestion: "Can you explain the function of the useEffect hook?",
    selectedAnswerText: "useEffect runs side effects after render and depends on its dependency array.",
    selectedAnswerTopic: "react",
    strictSelectedAnswer: true,
  });

  assert.equal(target.target?.id, "react-1");
  assert.equal(target.source, "selected_answer");
  assert.equal(target.selectedAnswerIgnoredReason, undefined);
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

test("function reference phrases are treated as code followups", () => {
  assert.equal(classifyConversationIntent("Can you explain that function?"), "EXPLAIN_CODE");
  assert.equal(classifyConversationIntent("Can you explain how this works?"), "EXPLAIN_CODE");
});

test("Parakeet replay intent keeps Spark/code concepts on the right branch", () => {
  assert.equal(classifyConversationIntent("Can you explain Spark architecture?"), "NEW_QUESTION");
  assert.equal(classifyConversationIntent("Can you create SparkSession in Spark version 1.1?"), "NEW_QUESTION");
  assert.equal(classifyConversationIntent("Python generator and decorator"), "NEW_QUESTION");
  assert.equal(classifyConversationIntent("What statistics do you use in Databricks/Spark SQL to optimize query performance?"), "NEW_QUESTION");
  assert.equal(
    classifyConversationIntent("For given table1 and table2, count records for inner join, left join, right join, and full join on number column."),
    "NEW_QUESTION",
  );
  assert.equal(classifyConversationIntent("Can we use lag instead of row_number?"), "EXPLAIN_CODE");
  assert.equal(classifyConversationIntent("Why year minus row_number?"), "EXPLAIN_CODE");
});

test("Parakeet replay data-processing setup is a scenario intent", () => {
  assert.equal(
    classifyConversationIntent("You have to process 1TB data daily from S3. What cluster size, nodes, and monitoring would you use?"),
    "SCENARIO_QUESTION",
  );
  assert.equal(
    classifyConversationIntent("How do you decide the number of nodes and cores required to process 1TB in 2 hours?"),
    "SCENARIO_QUESTION",
  );
});

test("Parakeet replay intent treats cloud and critical-situation asks as experience", () => {
  assert.equal(
    classifyConversationIntent("Can you walk me through your profile, experience, and skill set?"),
    "EXPERIENCE_QUESTION",
  );
  assert.equal(
    classifyConversationIntent("Azure and AWS services you worked on and how deep you used Data Factory?"),
    "EXPERIENCE_QUESTION",
  );
  assert.equal(
    classifyConversationIntent("Any critical situation you faced and how did you handle it?"),
    "EXPERIENCE_QUESTION",
  );
  assert.equal(
    classifyConversationIntent("How do you manage and secure sensitive credentials like client IDs and secrets in Azure and AWS?"),
    "EXPERIENCE_QUESTION",
  );
  assert.equal(
    classifyConversationIntent("How confident are you dealing with data using numpy and pandas?"),
    "EXPERIENCE_QUESTION",
  );
});

test("short cross-cloud topic continuation is a followup", () => {
  assert.equal(
    classifyConversationIntent("And, yeah. What about Azure then?"),
    "FOLLOW_UP",
  );
});

test("Parakeet replay Databricks statistics question does not bind previous code", () => {
  const history = toAnswerHistory([
    {
      messageId: "ipl-pyspark",
      role: "AI_ASSISTANT",
      question: "Write PySpark code for consecutive IPL winners.",
      answer: [
        "**ANSWER:**",
        "```python",
        "df_ranked = df.withColumn(\"rn\", F.row_number().over(window_spec))",
        "```",
      ].join("\n"),
      timestamp: new Date("2026-05-21T10:00:00Z").toISOString(),
    },
  ]);

  const target = resolveFollowupTarget({
    question: "What statistics do you use in Databricks/Spark SQL to optimize query performance?",
    history,
  });

  assert.equal(target.target, null);
  assert.equal(target.source, "none");
  assert.equal(target.isExplicitFollowupReference, false);
});

test("fresh React code generation does not bind stale previous React history", () => {
  const history = toAnswerHistory([
    {
      messageId: "old-react",
      role: "AI_ASSISTANT",
      question: "Can you explain how to use useEffect and Context API in React?",
      answer: "useEffect runs side effects and Context API shares state.",
      timestamp: new Date("2026-05-21T10:00:00Z").toISOString(),
    },
  ]);

  const target = resolveFollowupTarget({
    question: "Write a code in React.",
    history,
    selectedAnswerId: "old-react",
  });

  assert.equal(classifyConversationIntent("Write a code in React."), "EXPLAIN_CODE");
  assert.equal(target.target, null);
  assert.equal(target.source, "none");
  assert.equal(target.isExplicitFollowupReference, false);
  assert.equal(target.selectedAnswerIgnoredReason, "fresh_code_generation_no_followup_reference");
});

test("Parakeet replay code followups bind to PySpark window code, not unrelated code", () => {
  const history = toAnswerHistory([
    {
      messageId: "sql-join",
      role: "AI_ASSISTANT",
      question: "Write SQL join count query",
      answer: [
        "**ANSWER:**",
        "```sql",
        "SELECT * FROM table1 JOIN table2 ON table1.number = table2.number;",
        "```",
      ].join("\n"),
      timestamp: new Date("2026-05-21T10:00:00Z").toISOString(),
    },
    {
      messageId: "ipl-pyspark",
      role: "AI_ASSISTANT",
      question: "Write PySpark code for consecutive IPL winners.",
      answer: [
        "**ANSWER:**",
        "```python",
        "df_ranked = df.withColumn(\"rn\", F.row_number().over(window_spec))",
        "df_grouped = df_ranked.withColumn(\"grp\", F.col(\"year\") - F.col(\"rn\"))",
        "```",
      ].join("\n"),
      timestamp: new Date("2026-05-21T10:01:00Z").toISOString(),
    },
    {
      messageId: "react-latest",
      role: "AI_ASSISTANT",
      question: "Explain React useEffect.",
      answer: "useEffect runs side effects after render.",
      timestamp: new Date("2026-05-21T10:02:00Z").toISOString(),
    },
  ]);

  const lagTarget = resolveFollowupTarget({
    question: "Can we use lag instead of row_number?",
    history,
  });
  const rowNumberTarget = resolveFollowupTarget({
    question: "Why year minus row_number?",
    history,
  });

  assert.equal(lagTarget.target?.id, "ipl-pyspark");
  assert.equal(lagTarget.source, "topic_match");
  assert.equal(rowNumberTarget.target?.id, "ipl-pyspark");
  assert.equal(rowNumberTarget.source, "topic_match");
});

test("Parakeet replay correction challenges bind to immediate join-count answer", () => {
  const history = toAnswerHistory([
    {
      messageId: "ipl-pyspark",
      role: "AI_ASSISTANT",
      question: "Write PySpark code for consecutive IPL winners.",
      answer: [
        "**ANSWER:**",
        "```python",
        "df_ranked = df.withColumn(\"rn\", F.row_number().over(window_spec))",
        "```",
      ].join("\n"),
      timestamp: new Date("2026-05-21T10:00:00Z").toISOString(),
    },
    {
      messageId: "join-count",
      role: "AI_ASSISTANT",
      question: "How many records for inner, left, right, and full joins?",
      answer: "Inner join is seven rows, left join is eight rows, right join is eight rows, and full join is nine rows.",
      timestamp: new Date("2026-05-21T10:01:00Z").toISOString(),
    },
  ]);

  const target = resolveFollowupTarget({
    question: "I think eight is not correct. How come only eight?",
    history,
  });

  assert.equal(target.target?.id, "join-count");
  assert.equal(target.source, "immediate_previous");
  assert.equal(target.isExplicitFollowupReference, true);
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

test("ecommerce inventory scenario setup is a scenario question", () => {
  assert.equal(
    classifyConversationIntent(
      "Scenario setup: ecommerce sale, multiple users buying the same product, inventory left 5, orders are going negative. Question: How will you tackle this particular issue?",
    ),
    "SCENARIO_QUESTION",
  );
});

test("example-only short followup binds to immediate previous answer", () => {
  const history = toAnswerHistory([
    {
      messageId: "redis-methods",
      role: "AI_ASSISTANT",
      question: "What is get, set, and push method in Redis?",
      answer:
        "GET retrieves value, SET stores key-value, and LPUSH/RPUSH add list items.",
      timestamp: new Date("2026-05-21T10:00:00Z").toISOString(),
    },
    {
      messageId: "redis-followup-context",
      role: "AI_ASSISTANT",
      question: "Where are these methods used?",
      answer: "They are used in caching and queue scenarios.",
      timestamp: new Date("2026-05-21T10:01:00Z").toISOString(),
    },
  ]);

  const target = resolveFollowupTarget({
    question: "Can you write some examples?",
    history,
  });

  assert.equal(classifyConversationIntent("Can you write some examples?"), "FOLLOW_UP");
  assert.equal(target.source, "immediate_previous");
  assert.equal(target.target?.id, "redis-followup-context");
  assert.equal(target.isExplicitFollowupReference, true);
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
