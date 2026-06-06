import test from "node:test";
import assert from "node:assert/strict";
import { buildRequestScopedPolicy, classifyAnswerIntent } from "./answer-policy";

test("classifies concept explanation and suppresses experience", () => {
  const intent = classifyAnswerIntent({
    question: "Explain this concept: CAP theorem",
    answerMode: "auto",
    previousCodeBlocks: [],
  });
  assert.equal(intent, "concept_explanation");

  const policy = buildRequestScopedPolicy({
    question: "Explain this concept: CAP theorem",
    metadata: { transcript: "Explain this concept: CAP theorem" } as any,
    cieComplexity: "simple_contextual",
  });
  assert.equal(policy.answerIntent, "concept_explanation");
  assert.equal(policy.experienceSuppressed, true);
  assert.equal(policy.policyBlock.includes("output_format: markdown_only_under_answer_marker"), false);
  assert.equal(policy.policyBlock.includes("candidate_voice_rule"), false);
  assert.ok(policy.policyBlock.includes("**Core idea:**"));
});

test("classifies code followup when previous code blocks exist", () => {
  const policy = buildRequestScopedPolicy({
    question: "Explain this code",
    metadata: {
      transcript: "Explain this code",
      previousCodeBlocks: ["function x(){return 1;}"],
      previousAiAnswer: "Earlier I wrote function x(){return 1;}",
    } as any,
    cieComplexity: "followup",
  });
  assert.equal(policy.answerIntent, "code_explanation_followup");
  assert.equal(policy.isCodeFollowup, true);
  assert.equal(policy.codeBlocksInjectedCount, 1);
  assert.ok(policy.codeContextBlock.includes("FOLLOW-UP CODE CONTEXT"));
  assert.ok(policy.policyBlock.includes("**Referenced code:**"));
});

test("fresh React code request overrides stale followup decision", () => {
  const policy = buildRequestScopedPolicy({
    question: "Write a code in React.",
    metadata: {
      transcript: "Write a code in React.",
      previousAiAnswer: "Earlier useEffect and Context API answer.",
      previousCodeBlocks: ["const UserContext = createContext(null);"],
    } as any,
    cieComplexity: "system_design",
    aiDecision: {
      intent: "FOLLOW_UP",
      isFollowUp: true,
      confidence: 0.9,
      contextToUse: "previous_answer",
      answerMode: "auto",
      targetAnswerId: null,
      requiresPreviousCode: false,
      reason: "stale frontend followup detection",
      topic: "react",
    },
  });

  assert.equal(policy.answerIntent, "code_generation");
  assert.equal(policy.effectiveAnswerMode, "minimal_code");
  assert.equal(policy.isCodeFollowup, false);
  assert.equal(policy.codeBlocksInjectedCount, 0);
  assert.ok(policy.policyBlock.includes("code_policy: minimal practical code"));
});

test("fresh React Context API component request allows code generation", () => {
  assert.equal(
    classifyAnswerIntent({
      question: "Create a React component using useEffect and Context API.",
      cieComplexity: "simple_atomic",
    }),
    "code_generation",
  );
});

test("function followup without selected code blocks injects no unrelated code", () => {
  const policy = buildRequestScopedPolicy({
    question:
      "Follow-up to selected answer: Can you explain the function of the useEffect hook? User asks: Can you explain that function?",
    metadata: {
      transcript: "Can you explain that function?",
      previousCodeBlocks: [],
      selectedAnswerTopic: "react",
    } as any,
    cieComplexity: "followup",
  });

  assert.equal(policy.answerIntent, "code_explanation_followup");
  assert.equal(policy.isCodeFollowup, true);
  assert.equal(policy.codeBlocksInjectedCount, 0);
  assert.equal(policy.codeContextBlock, "");
});

test("classifies optimize code followup from natural phrase", () => {
  const policy = buildRequestScopedPolicy({
    question: "Can you optimize this code?",
    metadata: {
      transcript: "Can you optimize this code?",
      previousCodeBlocks: ["for (const x of items) result.push(x);"],
      previousAiAnswer: "Earlier code used a loop.",
    } as any,
    cieComplexity: "followup",
  });
  assert.equal(policy.answerIntent, "code_optimization_followup");
  assert.equal(policy.isCodeFollowup, true);
  assert.ok(policy.policyBlock.includes("**Edge case/performance:**"));
});

test("classifies PySpark row_number and lag questions as code followups", () => {
  const rowNumberPolicy = buildRequestScopedPolicy({
    question: "Why year minus row_number?",
    metadata: {
      previousCodeBlocks: ["df.withColumn('rn', row_number().over(window_spec))"],
      previousAiAnswer: "Earlier I used row_number with year - rn to group consecutive wins.",
    } as any,
    cieComplexity: "followup",
  });
  const lagPolicy = buildRequestScopedPolicy({
    question: "Can we use lag instead of row_number?",
    metadata: {
      previousCodeBlocks: ["df.withColumn('rn', row_number().over(window_spec))"],
      previousAiAnswer: "Earlier I used row_number with year - rn to group consecutive wins.",
    } as any,
    cieComplexity: "simple_atomic",
  });

  assert.equal(rowNumberPolicy.answerIntent, "code_explanation_followup");
  assert.equal(rowNumberPolicy.effectiveAnswerMode, "explain_existing_code");
  assert.ok(rowNumberPolicy.codeContextBlock.includes("row_number"));
  assert.equal(lagPolicy.answerIntent, "code_explanation_followup");
  assert.equal(lagPolicy.effectiveAnswerMode, "explain_existing_code");
});

test("classifies years of experience as project experience", () => {
  const intent = classifyAnswerIntent({
    question: "How many years of experience do you have?",
    answerMode: "auto",
    previousCodeBlocks: [],
  });
  assert.equal(intent, "behavioral_project_experience");

  const policy = buildRequestScopedPolicy({
    question: "How many years of experience do you have?",
    metadata: { transcript: "How many years of experience do you have?" } as any,
  });
  assert.ok(policy.policyBlock.includes("**Experience/project:**"));
  assert.ok(policy.policyBlock.includes("**Impact:**"));
});

test("classifies Parakeet replay experience and Spark concept asks", () => {
  assert.equal(
    classifyAnswerIntent({
      question: "Can you walk me through your profile, experience, and skill set?",
      cieComplexity: "simple_contextual",
    }),
    "behavioral_project_experience",
  );
  assert.equal(
    classifyAnswerIntent({
      question: "How do you manage and secure sensitive credentials like client IDs and secrets in Azure and AWS?",
      cieComplexity: "simple_contextual",
    }),
    "behavioral_project_experience",
  );
  assert.equal(
    classifyAnswerIntent({
      question: "What could be the reason some Spark tasks take longer than others?",
      cieComplexity: "simple_atomic",
    }),
    "concept_explanation",
  );
  assert.equal(
    classifyAnswerIntent({
      question: "Python generator and decorator",
      cieComplexity: "simple_atomic",
    }),
    "concept_explanation",
  );
  assert.equal(
    classifyAnswerIntent({
      question: "What statistics do you use in Databricks/Spark SQL to optimize query performance?",
      cieComplexity: "simple_atomic",
    }),
    "concept_explanation",
  );
  assert.equal(
    classifyAnswerIntent({
      question: "How confident are you dealing with data using numpy and pandas?",
      cieComplexity: "simple_contextual",
    }),
    "behavioral_project_experience",
  );
  assert.equal(
    classifyAnswerIntent({
      question: "You have to process 1TB data daily from S3. What cluster size, nodes, and monitoring would you use?",
      cieComplexity: "scenario_based",
    }),
    "scenario_based",
  );
  assert.equal(
    classifyAnswerIntent({
      question: "For given table1 and table2, count records for inner join, left join, right join, and full join on number column.",
      cieComplexity: "simple_atomic",
    }),
    "concept_explanation",
  );
  assert.equal(
    classifyAnswerIntent({
      question: "Can we edit the broadcast join size limit in Spark and what are the challenges of increasing it to 250MB?",
      cieComplexity: "simple_atomic",
    }),
    "concept_explanation",
  );
});

test("combined experience skill set and projects question gets structured profile policy", () => {
  const policy = buildRequestScopedPolicy({
    question: "Can you please let me know your experience, your skill set, and your projects?",
    metadata: { transcript: "Can you please let me know your experience, your skill set, and your projects?" } as any,
    cieComplexity: "simple_contextual",
  });

  assert.equal(policy.answerIntent, "behavioral_project_experience");
  assert.ok(policy.policyBlock.includes("experience_skill_project_structure"));
  assert.ok(policy.policyBlock.includes("years_rule"));
  assert.ok(policy.policyBlock.includes("combined_profile_answer_shape"));
});

test("cloud credential security question stays scoped to secret management", () => {
  const policy = buildRequestScopedPolicy({
    question:
      "How do you manage and secure sensitive credentials such as client IDs and client secrets in Azure and AWS, and where do you store them instead of local files?",
    cieComplexity: "simple_contextual",
  });

  assert.equal(policy.answerIntent, "behavioral_project_experience");
  assert.ok(policy.policyBlock.includes("Azure Key Vault"));
  assert.ok(policy.policyBlock.includes("AWS Secrets Manager"));
  assert.ok(policy.policyBlock.includes("must not be stored in local files"));
  assert.ok(policy.policyBlock.includes("do not drift into generic cloud storage"));
});

test("classifies behavioral project experience", () => {
  const intent = classifyAnswerIntent({
    question: "Tell me about your project",
    answerMode: "auto",
    previousCodeBlocks: [],
  });
  assert.equal(intent, "behavioral_project_experience");
});

test("classifies project overview as experience, not concept explanation", () => {
  const policy = buildRequestScopedPolicy({
    question: "Explain my projects",
    metadata: { transcript: "Explain my projects", answerMode: "auto" } as any,
    cieComplexity: "simple_contextual",
  });

  assert.equal(policy.answerIntent, "behavioral_project_experience");
  assert.equal(policy.effectiveAnswerMode, "auto");
  assert.equal(policy.experienceSuppressed, false);
  assert.ok(policy.policyBlock.includes("project_coverage: include_all_selected_projects"));
  assert.ok(policy.policyBlock.includes("project_source_precedence: selected_projects_first"));
  assert.equal(policy.policyBlock.includes("candidate_voice_rule"), false);
  assert.equal(policy.policyBlock.includes("project names, exact numbers"), false);
  assert.ok(policy.policyBlock.includes("project_depth_per_item"));
  assert.ok(policy.policyBlock.includes("project_answer_structure"));
  assert.ok(policy.policyBlock.includes("do_not_include_architecture_diagram_unless_explicitly_asked: true"));
});

test("emits scenario markdown answer shape", () => {
  const policy = buildRequestScopedPolicy({
    question: "In production, how would you debug a slow API?",
    metadata: { transcript: "In production, how would you debug a slow API?" } as any,
    cieComplexity: "scenario_based",
  });

  assert.equal(policy.answerIntent, "scenario_based");
  assert.ok(policy.policyBlock.includes("**Diagnosis:**"));
  assert.ok(policy.policyBlock.includes("**Recommendation:**"));
});

test("classifies ecommerce inventory race condition as scenario", () => {
  const policy = buildRequestScopedPolicy({
    question:
      "Scenario setup: ecommerce sale with multiple users buying the same product, inventory left 5, orders are going negative. Question: How will you tackle this particular issue?",
  });

  assert.equal(policy.answerIntent, "scenario_based");
  assert.equal(policy.effectiveAnswerMode, "auto");
});

test("AI decision can force SQL performance followup into code optimization mode", () => {
  const policy = buildRequestScopedPolicy({
    question: "What if the same query takes 2 seconds while fetching records?",
    metadata: {
      transcript: "What if the same query takes 2 seconds while fetching records?",
      previousCodeBlocks: ["SELECT employee_id, salary FROM employees;"],
      previousAiAnswer: "```sql\nSELECT employee_id, salary FROM employees;\n```",
    } as any,
    aiDecision: {
      intent: "OPTIMIZE_CODE",
      isFollowUp: true,
      targetAnswerId: "salary-sql",
      requiresPreviousCode: true,
      answerMode: "explain_existing_code",
      topic: "sql",
      confidence: 0.92,
      reason: "same query performance followup",
      contextToUse: "previous_code",
    },
  });

  assert.equal(policy.answerIntent, "code_optimization_followup");
  assert.equal(policy.effectiveAnswerMode, "explain_existing_code");
  assert.equal(policy.isCodeFollowup, true);
  assert.ok(policy.codeContextBlock.includes("FOLLOW-UP CODE CONTEXT"));
});
