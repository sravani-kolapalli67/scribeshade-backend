import test from "node:test";
import assert from "node:assert/strict";
import {
  filterPersistableAnswerPairs,
  selectPersistableAnswerPairs,
  shouldScheduleBackgroundComposer,
  validateAnswerForMemory,
} from "./ai-answer-safeguards";
import {
  buildScenarioEvidence,
  detectInterviewerTone,
  selectBestLiveQuestionEvidence,
  sanitizeLiveAnswerMetadataForLatestQuestion,
  sanitizeLiveRequestContext,
  type TranscriptEvidenceLine,
} from "./ai-answer-context-guards";

test("reconstructs fragmented cloud-service question instead of weak trailing hint", () => {
  const texts = [
    "Okay. Fine.",
    "Yeah. I mean, you have mentioned both of them.",
    "You have mentioned both the cloud side.",
    "So how much experience do you have into each cloud?",
    "I am not expecting each and every service of the cloud.",
    "What are the ones you have used in your experience?",
    "What other services did you use and how much depth do you have?",
    "It is not like a one word answer.",
    "I have to learn a little more or something like that.",
  ];
  const lines: TranscriptEvidenceLine[] = texts.map((text, index) => ({
    speaker: "candidate",
    text,
    timestamp: index,
    source: "payload",
  }));

  const question = selectBestLiveQuestionEvidence({
    currentQuestionHint:
      "ones. What other services did you use and how much depth do you have? It is not like a one word answer.",
    lines,
  });

  assert.match(question, /experience do you have into each cloud/i);
  assert.match(question, /what other services did you use/i);
});

test("reconstructs cross-cloud credential security question from fragmented STT", () => {
  const texts = [
    "In both the clouds, you must be having your own credential kind of thing.",
    "With that one, you can access data paths or pipelines.",
    "Basically access part, I am asking the security part.",
    "For example, you have your client ID and client secret.",
    "How did you manage in Azure?",
    "How did you manage in AWS?",
    "Did you save it in your local files?",
  ];
  const lines: TranscriptEvidenceLine[] = texts.map((text, index) => ({
    speaker: "candidate",
    text,
    timestamp: index,
    source: "payload",
  }));

  const question = selectBestLiveQuestionEvidence({
    currentQuestionHint:
      "How did you manage in AWS, and what services did you use? Did you save it locally?",
    lines,
  });

  assert.equal(
    question,
    "How do you manage and secure sensitive credentials such as client IDs and client secrets in Azure and AWS, and where do you store them instead of local files?",
  );
});

test("short Azure continuation preserves previous credential answer context", () => {
  const sanitized = sanitizeLiveRequestContext({
    isRegenerate: false,
    transcriptEvidence: {
      lines: [
        {
          speaker: "candidate",
          text: "And, yeah. What about Azure then?",
          source: "payload",
        },
      ],
      text: "- candidate: And, yeah. What about Azure then?",
      compactQuery: "And, yeah. What about Azure then?",
      currentQuestionHint: "And, yeah. What about Azure then?",
    },
    metadata: {
      answerClickMode: "answer_latest_unanswered",
      previousAiAnswer:
        "Use AWS Secrets Manager with IAM least privilege and runtime secret retrieval.",
      activeQuestionDetection: {
        activeQuestion: "And, yeah. What about Azure then?",
        cleanedQuestion: "And, yeah. What about Azure then?",
        isFollowUp: false,
        topicChanged: false,
        confidenceScore: 1,
        ignoredNoise: false,
      },
    },
  });

  assert.equal(sanitized.kind, "true_followup");
  assert.equal(sanitized.allowPreviousAnswer, true);
  assert.match(sanitized.metadata?.previousAiAnswer || "", /AWS Secrets Manager/);
});

test("background composer is disabled unless explicitly enabled", () => {
  assert.equal(shouldScheduleBackgroundComposer(undefined), false);
  assert.equal(shouldScheduleBackgroundComposer("false"), false);
  assert.equal(shouldScheduleBackgroundComposer("0"), false);
  assert.equal(shouldScheduleBackgroundComposer("true"), true);
  assert.equal(shouldScheduleBackgroundComposer("1"), true);
});

test("one ai-answer click has no background composer call when disabled", () => {
  const answerModelCalls = 1;
  const backgroundComposerCalls = shouldScheduleBackgroundComposer(undefined) ? 1 : 0;

  assert.equal(answerModelCalls + backgroundComposerCalls, 1);
});

test("parser keeps first unsupported extra question but preserves supported extras", () => {
  const evidenceText = [
    "Can you please introduce yourself?",
    "Explain the projects you have done.",
    "What is Redis?",
  ].join(" ");
  const filtered = filterPersistableAnswerPairs({
    evidenceText,
    pairs: [
      {
        question: "Introduce yourself and explain the projects you have done.",
        answer: "Answer one.",
      },
      {
        question: "Can you provide more details about the specific technologies you used in your projects?",
        answer: "Unsupported invented follow-up.",
      },
      {
        question: "What is Redis?",
        answer: "Supported explicit question.",
      },
    ],
    sessionId: "test-session",
  });

  assert.deepEqual(
    filtered.map((pair) => pair.question),
    [
      "Introduce yourself and explain the projects you have done.",
      "What is Redis?",
    ],
  );
});

test("screen multi-question output with explicit separator preserves every Q&A pair", () => {
  const selected = selectPersistableAnswerPairs({
    finalResponse: [
      "**QUESTION:** What is visible in the first panel?",
      "**ANSWER:** First screen answer.",
      "===NEXT_QUESTION===",
      "**QUESTION:** What is visible in the second panel?",
      "**ANSWER:** Second screen answer.",
    ].join("\n"),
    evidenceText: "(question from screenshot)",
    pairs: [
      {
        question: "What is visible in the first panel?",
        answer: "First screen answer.",
      },
      {
        question: "What is visible in the second panel?",
        answer: "Second screen answer.",
      },
    ],
    sessionId: "screen-session",
  });

  assert.deepEqual(
    selected.map((pair) => pair.question),
    [
      "What is visible in the first panel?",
      "What is visible in the second panel?",
    ],
  );
});

test("stale selected followup metadata is cleared for fresh scenario transcript", () => {
  const transcriptEvidence = {
    lines: [],
    text: "Scenario Setup:\n- candidate: Ecommerce sale has multiple users buying the same product.\n\nQuestion:\nHow will you tackle this issue?",
    compactQuery:
      "Scenario setup: Ecommerce sale has multiple users buying the same product and inventory can go negative. Question: How will you tackle this issue?",
    scenarioSetup:
      "Ecommerce sale has multiple users buying the same product and inventory can go negative.",
    scenarioQuestion: "How will you tackle this issue?",
    scenarioDetected: true,
  };

  const result = sanitizeLiveAnswerMetadataForLatestQuestion({
    transcriptEvidence,
    metadata: {
      answerClickMode: "answer_followup",
      selectedAnswerId: "react-answer",
      selectedAnswerQuestion: "Can you explain how to implement useRef?",
      selectedAnswerText: "useRef stores mutable values in React.",
      selectedAnswerTopic: "react",
      previousAiAnswer: "React answer",
      previousCodeBlocks: ["const ref = useRef(null);"],
      activeQuestionDetection: {
        activeQuestion: "How will you tackle this particular issue?",
        cleanedQuestion: "How will you tackle this particular issue?",
        isFollowUp: false,
        topicChanged: true,
        confidenceScore: 0.92,
        ignoredNoise: false,
      },
    },
  });

  assert.equal(result.clearReason, "scenario_topic_conflict");
  assert.equal(result.metadata?.answerClickMode, "answer_latest_unanswered");
  assert.equal(result.metadata?.selectedAnswerId, undefined);
  assert.equal(result.metadata?.selectedAnswerText, undefined);
  assert.equal(result.metadata?.previousAiAnswer, undefined);
  assert.equal(result.metadata?.previousCodeBlocks, undefined);
});

test("latest unanswered request clears stale previous answer and code context", () => {
  const result = sanitizeLiveRequestContext({
    isRegenerate: false,
    transcriptEvidence: {
      lines: [
        {
          speaker: "candidate",
          text: "Can you explain Python generators?",
          timestamp: 1,
          source: "payload",
        },
      ],
      text: "- candidate: Can you explain Python generators?",
      compactQuery: "Can you explain Python generators?",
    },
    metadata: {
      answerClickMode: "answer_latest_unanswered",
      previousAiAnswer: "Earlier React useRef answer",
      previousAiAnswers: [
        {
          question: "Explain useRef",
          answer: "useRef stores mutable values.",
          codeBlocks: ["const ref = useRef(null);"],
        },
      ],
      previousCodeBlocks: ["const ref = useRef(null);"],
      selectedAnswerId: "react-card",
      selectedAnswerText: "React answer",
      activeQuestionDetection: {
        activeQuestion: "Can you explain Python generators?",
        cleanedQuestion: "Can you explain Python generators?",
        isFollowUp: false,
        topicChanged: true,
        confidenceScore: 0.9,
        ignoredNoise: false,
      },
    },
  });

  assert.equal(result.kind, "latest_question");
  assert.equal(result.allowPreviousAnswer, false);
  assert.equal(result.allowSelectedAnswer, false);
  assert.equal(result.allowCodeMemory, false);
  assert.equal(result.metadata?.previousAiAnswer, undefined);
  assert.equal(result.metadata?.previousAiAnswers, undefined);
  assert.equal(result.metadata?.previousCodeBlocks, undefined);
  assert.equal(result.metadata?.selectedAnswerId, undefined);
});

test("normal latest followup clears selected card context but preserves previous answer memory", () => {
  const result = sanitizeLiveRequestContext({
    isRegenerate: false,
    transcriptEvidence: {
      lines: [
        {
          speaker: "candidate",
          text: "Can you tell me more about that decision?",
          timestamp: 1,
          source: "payload",
        },
      ],
      text: "- candidate: Can you tell me more about that decision?",
      compactQuery: "Can you tell me more about that decision?",
    },
    metadata: {
      answerClickMode: "answer_latest_unanswered",
      selectedAnswerId: "visible-react-card",
      selectedAnswerQuestion: "Explain React useRef",
      selectedAnswerText: "useRef stores mutable values.",
      selectedAnswerTopic: "react",
      previousAiAnswer: "Prior backend design answer.",
      previousAiAnswers: [
        {
          question: "Explain useRef",
          answer: "React answer with code.",
          codeBlocks: ["const ref = useRef(null);"],
        },
      ],
      previousCodeBlocks: ["const ref = useRef(null);"],
      activeQuestionDetection: {
        activeQuestion: "Can you tell me more about that decision?",
        cleanedQuestion: "Can you tell me more about that decision?",
        isFollowUp: true,
        topicChanged: false,
        confidenceScore: 0.88,
        ignoredNoise: false,
      },
    },
  });

  assert.equal(result.kind, "true_followup");
  assert.equal(result.allowPreviousAnswer, true);
  assert.equal(result.allowSelectedAnswer, false);
  assert.equal(result.metadata?.answerClickMode, "answer_latest_unanswered");
  assert.equal(result.metadata?.selectedAnswerId, undefined);
  assert.equal(result.metadata?.selectedAnswerText, undefined);
  assert.equal(result.metadata?.selectedAnswerTopic, undefined);
  assert.equal(result.metadata?.previousAiAnswer, "Prior backend design answer.");
  assert.equal(result.metadata?.previousCodeBlocks, undefined);
  assert.deepEqual(result.metadata?.previousAiAnswers, [
    {
      question: "Explain useRef",
      answer: "React answer with code.",
    },
  ]);
});

test("fresh latest coding request overrides stale followup metadata and clears old answers", () => {
  const result = sanitizeLiveRequestContext({
    isRegenerate: false,
    transcriptEvidence: {
      lines: [
        {
          speaker: "candidate",
          text: "In that project?",
          timestamp: 1,
          source: "payload",
        },
        {
          speaker: "candidate",
          text: "Write a code in React.",
          timestamp: 2,
          source: "payload",
        },
      ],
      text: "- candidate: In that project?\n- candidate: Write a code in React.",
      compactQuery: "In that project? Write a code in React.",
      dominantQuestion: "Write a code in React.",
      clickRawTranscript: "- candidate: Write a code in React.",
    },
    metadata: {
      answerClickMode: "answer_latest_unanswered",
      selectedAnswerId: "visible-react-card",
      selectedAnswerQuestion: "Can you explain how to use useEffect and Context API in React?",
      selectedAnswerText: "Earlier answer about useEffect and Context API.",
      selectedAnswerTopic: "react",
      previousAiAnswer: "Earlier answer about useEffect and Context API.",
      previousAiAnswers: [
        {
          question: "Can you explain how to use useEffect and Context API in React?",
          answer: "Use useEffect for side effects and Context API for shared state.",
          codeBlocks: ["const UserContext = createContext(null);"],
        },
      ],
      previousCodeBlocks: ["const UserContext = createContext(null);"],
      activeQuestionDetection: {
        activeQuestion: "Write a code in React.",
        cleanedQuestion: "Write a code in React.",
        isFollowUp: true,
        topicChanged: false,
        confidenceScore: 0.78,
        ignoredNoise: false,
      },
    },
  });

  assert.equal(result.kind, "coding");
  assert.equal(result.allowPreviousAnswer, false);
  assert.equal(result.allowSelectedAnswer, false);
  assert.equal(result.allowCodeMemory, false);
  assert.equal(result.metadata?.answerClickMode, "answer_latest_unanswered");
  assert.equal(result.metadata?.selectedAnswerId, undefined);
  assert.equal(result.metadata?.previousAiAnswer, undefined);
  assert.equal(result.metadata?.previousAiAnswers, undefined);
  assert.equal(result.metadata?.previousCodeBlocks, undefined);
  assert.equal(result.clearReason, "latest_coding_context_cleared");
});

test("scenario evidence preserves ecommerce setup and final ask", () => {
  const lines: TranscriptEvidenceLine[] = [
    {
      speaker: "candidate",
      text: "Suppose there is an ecommerce sale with high traffic.",
      timestamp: 1,
      source: "payload",
    },
    {
      speaker: "candidate",
      text: "Multiple users are buying the same product at the same time.",
      timestamp: 2,
      source: "payload",
    },
    {
      speaker: "candidate",
      text: "Inventory left is 5, but orders and inventory are going negative.",
      timestamp: 3,
      source: "payload",
    },
    {
      speaker: "candidate",
      text: "How will you tackle this particular issue?",
      timestamp: 4,
      source: "payload",
    },
  ];

  const evidence = buildScenarioEvidence({
    lines,
    currentQuestionHint: "How will you tackle this particular issue?",
  });

  assert.ok(evidence);
  assert.ok(evidence.text.includes("Scenario Setup:"));
  assert.ok(evidence.text.includes("Inventory left is 5"));
  assert.ok(evidence.text.includes("Question:\nHow will you tackle this particular issue?"));
  assert.ok(evidence.compactQuery.includes("Scenario setup:"));
  assert.ok(evidence.compactQuery.includes("Question: How will you tackle this particular issue?"));
  assert.deepEqual(evidence.scenarioPacket.numbers, ["5"]);
  assert.equal(evidence.scenarioPacket.domain, "ecommerce");
});

test("scenario evidence uses transcript final ask over stale frontend hint", () => {
  const lines: TranscriptEvidenceLine[] = [
    {
      speaker: "candidate",
      text: "Suppose ecommerce inventory has only 5 items left.",
      timestamp: 1,
      source: "payload",
    },
    {
      speaker: "candidate",
      text: "Multiple users buy the same product and stock goes negative.",
      timestamp: 2,
      source: "payload",
    },
    {
      speaker: "candidate",
      text: "How will you tackle this issue?",
      timestamp: 3,
      source: "payload",
    },
  ];

  const evidence = buildScenarioEvidence({
    lines,
    currentQuestionHint: "How would you handle React useRef state?",
  });

  assert.ok(evidence);
  assert.equal(evidence.scenarioQuestion, "How will you tackle this issue?");
  assert.ok(evidence.compactQuery.includes("Question: How will you tackle this issue?"));
  assert.equal(evidence.compactQuery.includes("React useRef"), false);
});

test("production project architecture question is not treated as scenario setup", () => {
  const evidence = buildScenarioEvidence({
    lines: [
      {
        speaker: "candidate",
        text: "In my project we deployed to production and used Redis for caching.",
        timestamp: 1,
        source: "payload",
      },
      {
        speaker: "candidate",
        text: "Can you explain the architecture of that project?",
        timestamp: 2,
        source: "payload",
      },
    ],
    currentQuestionHint: "Can you explain the architecture of that project?",
  });

  assert.equal(evidence, null);
});

test("interviewer tone detects skeptical and challenge phrasing", () => {
  assert.equal(
    detectInterviewerTone({
      text: "Are you sure this left join count is correct?",
      scenarioDetected: false,
    }),
    "skeptical",
  );
  assert.equal(
    detectInterviewerTone({
      text: "Why did you choose Redis there?",
      scenarioDetected: false,
    }),
    "challenge",
  );
});

test("answer validation blocks stale context after sanitizer clear", () => {
  const validation = validateAnswerForMemory({
    finalResponse: "**QUESTION:** Explain generators\n**ANSWER:** As I said in the previous answer about React useRef...",
    pair: {
      question: "Explain generators",
      answer: "As I said in the previous answer about React useRef...",
    },
    evidenceText: "Can you explain Python generators?",
    questionAllowsCode: false,
    staleContextCleared: true,
  });

  assert.equal(validation.persistCard, false);
  assert.equal(validation.updateMemory, false);
  assert.ok(validation.reasons.includes("stale_context_reference_after_clear"));
});

test("answer validation allows code-request React hook content after stale context clear", () => {
  const validation = validateAnswerForMemory({
    finalResponse: [
      "**QUESTION:** Write a code in React.",
      "**ANSWER:**",
      "```tsx",
      "useEffect(() => { loadUser(); }, []);",
      "```",
      "- The `useEffect` hook loads data after render.",
    ].join("\n"),
    pair: {
      question: "Write a code in React.",
      answer: [
        "```tsx",
        "useEffect(() => { loadUser(); }, []);",
        "```",
        "- The `useEffect` hook loads data after render.",
      ].join("\n"),
    },
    evidenceText: "Write a code in React.",
    questionAllowsCode: true,
    staleContextCleared: true,
  });

  assert.equal(validation.persistCard, true);
  assert.equal(validation.reasons.includes("stale_context_reference_after_clear"), false);
});

test("answer validation allows text diagrams but still blocks real code when not requested", () => {
  const textDiagram = validateAnswerForMemory({
    finalResponse: "**QUESTION:** Explain the flow\n**ANSWER:** ```text\nBrowser -> API -> DB\n```",
    pair: {
      question: "Explain the flow",
      answer: "```text\nBrowser -> API -> DB\n```",
    },
    evidenceText: "Explain the flow",
    questionAllowsCode: false,
    staleContextCleared: false,
  });
  const codeBlock = validateAnswerForMemory({
    finalResponse: "**QUESTION:** Explain Redis\n**ANSWER:** ```ts\nconst value = await redis.get(key);\n```",
    pair: {
      question: "Explain Redis",
      answer: "```ts\nconst value = await redis.get(key);\n```",
    },
    evidenceText: "Explain Redis",
    questionAllowsCode: false,
    staleContextCleared: false,
  });
  const screenCodeBlock = validateAnswerForMemory({
    finalResponse: "**QUESTION:** Analyze screen\n**ANSWER:** ```ts\nconst value = await redis.get(key);\n```",
    pair: {
      question: "Analyze screen",
      answer: "```ts\nconst value = await redis.get(key);\n```",
    },
    evidenceText: "(question from screenshot)",
    questionAllowsCode: false,
    allowFencedBlocks: true,
    staleContextCleared: false,
  });

  assert.equal(textDiagram.persistCard, true);
  assert.equal(codeBlock.persistCard, false);
  assert.ok(codeBlock.reasons.includes("code_block_without_code_request"));
  assert.equal(screenCodeBlock.persistCard, true);
});

test("screen multi-question validation trusts explicit separator with image evidence", () => {
  const finalResponse = [
    "**QUESTION:** What issue is shown in the inventory panel?",
    "**ANSWER:** The panel shows stock going negative.",
    "===NEXT_QUESTION===",
    "**QUESTION:** What fix should be applied to checkout?",
    "**ANSWER:** Add transactional reservation or an atomic stock decrement.",
  ].join("\n");
  const first = validateAnswerForMemory({
    finalResponse,
    pair: {
      question: "What issue is shown in the inventory panel?",
      answer: "The panel shows stock going negative.",
    },
    evidenceText: "(question from screenshot)",
    questionAllowsCode: true,
    allowFencedBlocks: true,
    skipUnsupportedQuestionEvidenceCheck: true,
    staleContextCleared: false,
  });
  const second = validateAnswerForMemory({
    finalResponse,
    pair: {
      question: "What fix should be applied to checkout?",
      answer: "Add transactional reservation or an atomic stock decrement.",
    },
    evidenceText: "(question from screenshot)",
    questionAllowsCode: true,
    allowFencedBlocks: true,
    skipUnsupportedQuestionEvidenceCheck: true,
    staleContextCleared: false,
  });

  assert.equal(first.persistCard, true);
  assert.equal(second.persistCard, true);
  assert.equal(first.reasons.includes("question_not_supported_by_evidence"), false);
  assert.equal(second.reasons.includes("question_not_supported_by_evidence"), false);
});
