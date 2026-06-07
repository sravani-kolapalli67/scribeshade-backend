import type { AIAnswerLiveContextMetadata } from "./ai-answer.dto";
import {
  sanitizeLiveRequestContextV4,
} from "./state/live-request-sanitizer-v4";
import type {
  InterviewerTone,
  LiveRequestKind,
  SanitizedLiveRequest,
  ScenarioEvidencePacket,
} from "./session-intelligence.types";

export type {
  InterviewerTone,
  LiveRequestKind,
  SanitizedLiveRequest,
  ScenarioEvidencePacket,
} from "./session-intelligence.types";

export type TranscriptEvidenceSpeaker = "interviewer" | "candidate";

export type TranscriptEvidenceLine = {
  speaker: TranscriptEvidenceSpeaker;
  text: string;
  chunkId?: string;
  timestamp?: number;
  source: "db" | "payload" | "window" | "raw";
};

export type TranscriptEvidenceV3 = {
  lines: TranscriptEvidenceLine[];
  text: string;
  compactQuery: string;
  currentQuestionHint?: string;
  recentTranscriptContext?: string;
  clickRawTranscript?: string;
  dominantQuestion?: string;
  scenarioSetup?: string;
  scenarioQuestion?: string;
  scenarioDetected?: boolean;
  scenarioPacket?: ScenarioEvidencePacket;
};

export type LiveAnswerMetadataSanitization = {
  metadata?: AIAnswerLiveContextMetadata;
  originalMode?: string;
  effectiveMode?: string;
  selectedTopic?: string;
  scenarioDetected: boolean;
  clearReason?: string;
  kind?: LiveRequestKind;
  allowPreviousAnswer?: boolean;
  allowSelectedAnswer?: boolean;
  allowCodeMemory?: boolean;
  interviewerTone?: InterviewerTone;
  scenarioPacket?: ScenarioEvidencePacket;
};

const SCENARIO_SETUP_RE =
  /\b(scenario|suppose|imagine|situation|case|what happens|there is|let'?s say|assume|during|production|incident|outage)\b/i;
const EXPLICIT_SCENARIO_SETUP_RE =
  /\b(scenario|suppose|imagine|situation|case|what happens|there is|let'?s say|assume)\b/i;
const SCENARIO_PROBLEM_RE =
  /\b(e-?commerce|sale|flash sale|inventory|stock|orders?|negative|oversell|oversold|multiple users?|concurrent|concurrency|race condition|high traffic|same product|payment|checkout|reservation|lock|transaction)\b/i;
const SCENARIO_ASK_RE =
  /\b(how (?:would|will|do) you (?:handle|tackle|solve|fix|prevent|approach|resolve)|what (?:would|will|do) you do|how should (?:we|you) fix|how can (?:we|you) prevent)\b/i;
const SCENARIO_FAILURE_RE =
  /\b(issue|problem|bug|failure|failed|fails|left|remaining|available|buying|purchase|orders?|negative|oversell|oversold|race condition|concurrent|high traffic|outage|incident|production issue)\b/i;
const FRESH_CODE_GENERATION_RE =
  /\b(write|implement|create|build|develop|show|give|provide)\b.{0,80}\b(code|snippet|component|hook|function|class|query|api|example)\b/i;
const FRAMEWORK_CODE_RE =
  /\b(?:code\s+in\s+(?:react|vue|angular|node(?:\.js)?|python|javascript|typescript|java|sql|pyspark)|(?:react|vue|angular|node(?:\.js)?|python|javascript|typescript|java|sql|pyspark)\s+(?:code|component|hook|function|snippet|query))\b/i;
const REACT_CODE_CONCEPT_RE =
  /(?=.*\b(write|implement|create|build|code|component|example|snippet)\b)(?=.*\b(useeffect|usecontext|context api|react context)\b)/i;
const FILLER_RE =
  /^(hi|hello|hey|okay|ok|yeah|yes|no|right|fine|hmm|um|uh|thanks|thank you|can you hear me|am i audible)$/i;
const URGENCY_RE = /\b(quickly|fast|immediately|right now|urgent|asap|within \d+\s*(?:minutes?|hours?|seconds?))\b/i;
const SKEPTICAL_RE = /\b(are you sure|is that correct|i think|not correct|how come|really|are you certain)\b/i;
const CHALLENGE_RE = /\b(why did you|why would you|why this|why that|justify|defend|how come|explain your reasoning)\b/i;
const CLARIFICATION_RE = /\b(can you explain|clarify|explain more|tell me more|what do you mean|elaborate)\b/i;
const STRESS_TEST_RE = /\b(what if|fails?|failure|production|outage|high traffic|scale|bottleneck|rollback|monitoring)\b/i;
const DEEP_DIVE_RE = /\b(go deeper|deep dive|walk me through|step by step|architecture|internals|how exactly)\b/i;
const QUESTION_CUE_RE =
  /\b(what|why|how|when|where|which|who|can|could|would|should|is|are|do|does|did|explain|describe|tell me|walk me|list|share)\b/i;
const WEAK_QUESTION_PREFIX_RE =
  /^(?:and|or|then|also|plus|because|so|where|for|to|of|in|on|with|about|ones?|things?|that|this|it)\b/i;
const CREDENTIAL_SECURITY_RE =
  /\b(credentials?|client ids?|client secrets?|secrets?|username|password|connection strings?|certificates?)\b/i;
const CREDENTIAL_MANAGEMENT_RE =
  /\b(security|secure|access|store|save|manage|handle|protect|local|hardcod|vault|secret manager|parameter store)\b/i;
const AZURE_RE = /\bazure\b/i;
const AWS_RE = /\baws\b|\bamazon web services\b/i;
const CLOUD_CREDENTIAL_QUESTION =
  "How do you manage and secure sensitive credentials such as client IDs and client secrets in Azure and AWS, and where do you store them instead of local files?";

function normalizeSpaces(text: string): string {
  return (text || "").replace(/\s+/g, " ").trim();
}

function clipText(text: string, maxChars: number): string {
  const normalized = normalizeSpaces(text);
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 3)).trim()}...`;
}

function isQuestionEvidence(text: string): boolean {
  const normalized = normalizeSpaces(text);
  return normalized.includes("?") || QUESTION_CUE_RE.test(normalized);
}

function isWeakQuestionHint(text: string): boolean {
  const normalized = normalizeSpaces(text);
  if (!normalized) return true;
  const wordCount = normalized.split(/\s+/).filter(Boolean).length;
  if (wordCount < 4) return true;
  const startsWithQuestionCue = new RegExp(`^${QUESTION_CUE_RE.source}`, "i").test(normalized);
  return !startsWithQuestionCue && WEAK_QUESTION_PREFIX_RE.test(normalized);
}

function reconstructCloudCredentialQuestion(lines: TranscriptEvidenceLine[]): string {
  const evidence = normalizeSpaces(lines.map((line) => line.text).join(" "));
  if (
    CREDENTIAL_SECURITY_RE.test(evidence) &&
    CREDENTIAL_MANAGEMENT_RE.test(evidence) &&
    AZURE_RE.test(evidence) &&
    AWS_RE.test(evidence)
  ) {
    return CLOUD_CREDENTIAL_QUESTION;
  }
  return "";
}

export function extractLatestAnswerableQuestionSpan(
  lines: TranscriptEvidenceLine[],
): string {
  const usableLines = lines
    .map((line) => normalizeSpaces(line.text))
    .filter((text) => text && !FILLER_RE.test(text));
  let latestQuestionIndex = -1;
  for (let index = usableLines.length - 1; index >= 0; index -= 1) {
    if (!isQuestionEvidence(usableLines[index])) continue;
    latestQuestionIndex = index;
    break;
  }
  if (latestQuestionIndex < 0) return "";

  const startIndex = Math.max(0, latestQuestionIndex - 16);
  const span = normalizeSpaces(
    usableLines
      .slice(startIndex, latestQuestionIndex + 9)
      .join(" "),
  );
  const wordCount = span.split(/\s+/).filter(Boolean).length;
  if (wordCount < 4 || !isQuestionEvidence(span)) return "";
  return clipText(span, 900);
}

export function selectBestLiveQuestionEvidence(input: {
  currentQuestionHint: string;
  lines: TranscriptEvidenceLine[];
}): string {
  const cloudCredentialQuestion = reconstructCloudCredentialQuestion(input.lines);
  if (cloudCredentialQuestion) return cloudCredentialQuestion;
  const hint = normalizeSpaces(input.currentQuestionHint);
  const span = extractLatestAnswerableQuestionSpan(input.lines);
  if (!span) return hint;
  if (!hint || isWeakQuestionHint(hint)) return span;
  return hint;
}

function isScenarioEvidenceText(text: string): boolean {
  const normalized = normalizeSpaces(text);
  if (!normalized) return false;
  const hasAsk = SCENARIO_ASK_RE.test(normalized);
  const hasExplicitSetup = EXPLICIT_SCENARIO_SETUP_RE.test(normalized);
  const hasProblemDomain = SCENARIO_PROBLEM_RE.test(normalized);
  const hasFailure = SCENARIO_FAILURE_RE.test(normalized);
  return (
    (hasAsk && (hasExplicitSetup || hasProblemDomain || hasFailure)) ||
    (hasExplicitSetup && (hasProblemDomain || hasFailure)) ||
    (hasProblemDomain && hasFailure)
  );
}

export function isFreshCodeGenerationRequest(text: string): boolean {
  const normalized = normalizeSpaces(text);
  if (!normalized) return false;
  if (/\b(this code|the code|previous code|code you wrote|that code|above code)\b/i.test(normalized)) {
    return false;
  }
  return (
    FRESH_CODE_GENERATION_RE.test(normalized) ||
    FRAMEWORK_CODE_RE.test(normalized) ||
    REACT_CODE_CONCEPT_RE.test(normalized)
  );
}

function hintSpecificTokens(text: string): string[] {
  const stop = new Set([
    "how",
    "would",
    "will",
    "do",
    "you",
    "we",
    "handle",
    "tackle",
    "solve",
    "fix",
    "prevent",
    "approach",
    "resolve",
    "what",
    "this",
    "that",
    "issue",
    "problem",
    "scenario",
    "particular",
  ]);
  return (normalizeSpaces(text).toLowerCase().match(/[a-z0-9_]+/g) || [])
    .filter((token) => token.length > 2 && !stop.has(token));
}

function isHintSupportedByScenario(input: {
  hint: string;
  lines: TranscriptEvidenceLine[];
}): boolean {
  const hint = normalizeSpaces(input.hint);
  if (!hint || !SCENARIO_ASK_RE.test(hint)) return false;
  const transcriptText = normalizeSpaces(input.lines.map((line) => line.text).join(" ")).toLowerCase();
  if (!transcriptText) return false;
  if (transcriptText.includes(hint.toLowerCase())) return true;
  const specificTokens = hintSpecificTokens(hint);
  if (specificTokens.length === 0) return true;
  const overlap = specificTokens.filter((token) => transcriptText.includes(token)).length;
  return overlap / specificTokens.length >= 0.5;
}

function isScenarioFinalAsk(text: string): boolean {
  const normalized = normalizeSpaces(text);
  return !!normalized && (SCENARIO_ASK_RE.test(normalized) || normalized.includes("?"));
}

function extractUniqueMatches(text: string, pattern: RegExp, maxItems: number): string[] {
  const matches = text.match(pattern) || [];
  const seen = new Set<string>();
  const output: string[] = [];
  for (const match of matches) {
    const value = normalizeSpaces(match);
    const key = value.toLowerCase();
    if (!value || seen.has(key)) continue;
    seen.add(key);
    output.push(value);
    if (output.length >= maxItems) break;
  }
  return output;
}

function inferScenarioDomain(text: string): string {
  const normalized = text.toLowerCase();
  if (/\be-?commerce|checkout|payment|inventory|stock|orders?\b/.test(normalized)) return "ecommerce";
  if (/\bspark|databricks|s3|1tb|cluster|nodes?|cores?\b/.test(normalized)) return "data processing";
  if (/\bapi|backend|database|redis|queue|system\b/.test(normalized)) return "backend system";
  if (/\bproduction|incident|outage\b/.test(normalized)) return "production incident";
  return "general scenario";
}

function buildScenarioPacket(input: {
  lines: TranscriptEvidenceLine[];
  setup: string;
  question: string;
}): ScenarioEvidencePacket {
  const allText = normalizeSpaces(`${input.setup} ${input.question}`);
  const numbers = extractUniqueMatches(
    allText,
    /\b\d+(?:\.\d+)?\s*(?:tb|gb|mb|kb|%|percent|hours?|hrs?|minutes?|mins?|seconds?|secs?|nodes?|cores?|records?|rows?|orders?|users?|items?|products?|left|remaining)?\b/gi,
    12,
  );
  const actors = extractUniqueMatches(
    allText,
    /\b(?:multiple users?|customers?|interviewers?|candidate|executors?|driver|nodes?|workers?|services?|apis?|consumers?|producers?)\b/gi,
    8,
  );
  const constraints = extractUniqueMatches(
    allText,
    /\b(?:inventory left[^.?!]*|within \d+[^.?!]*|process(?:ing)? [^.?!]*|high traffic|same product|concurrent(?:ly)?|race condition|2 hours?|1tb[^.?!]*|negative [^.?!]*)\b/gi,
    8,
  );
  const failure = normalizeSpaces(
    allText.match(/\b(?:negative [^.?!]*|oversell[^.?!]*|failure[^.?!]*|issue[^.?!]*|problem[^.?!]*|outage[^.?!]*|slow [^.?!]*|takes? longer[^.?!]*)/i)?.[0] || "",
  );
  return {
    detected: true,
    domain: inferScenarioDomain(allText),
    actors,
    constraints,
    numbers,
    ...(failure ? { failureSymptom: failure } : {}),
    finalAsk: input.question,
    transcriptLines: input.lines.map((line) => `${line.speaker}: ${line.text}`),
    compactQuery: normalizeSpaces(`Scenario setup: ${input.setup || allText} Question: ${input.question}`),
  };
}

export function buildScenarioEvidence(input: {
  lines: TranscriptEvidenceLine[];
  currentQuestionHint: string;
}): {
  lines: TranscriptEvidenceLine[];
  text: string;
  compactQuery: string;
  scenarioSetup: string;
  scenarioQuestion: string;
  scenarioPacket: ScenarioEvidencePacket;
} | null {
  const allText = normalizeSpaces(
    [
      ...input.lines.map((line) => line.text),
      input.currentQuestionHint,
    ].join(" "),
  );
  if (!isScenarioEvidenceText(allText)) return null;

  const finalAskIndex = [...input.lines]
    .reverse()
    .findIndex((line) => SCENARIO_ASK_RE.test(line.text) || line.text.includes("?"));
  const questionIndex =
    finalAskIndex >= 0 ? input.lines.length - 1 - finalAskIndex : input.lines.length - 1;
  if (questionIndex < 0) return null;

  const setupIndex = input.lines.findIndex((line) =>
    SCENARIO_SETUP_RE.test(line.text) || SCENARIO_PROBLEM_RE.test(line.text),
  );
  const startIndex = Math.max(0, setupIndex >= 0 ? setupIndex : questionIndex - 10);
  const scenarioLines = input.lines.slice(startIndex, questionIndex + 1).slice(-18);
  if (scenarioLines.length === 0) return null;

  const transcriptQuestion = normalizeSpaces(scenarioLines[scenarioLines.length - 1]?.text || "");
  const currentQuestionHint = normalizeSpaces(input.currentQuestionHint);
  const question =
    (
      isScenarioFinalAsk(transcriptQuestion)
        ? transcriptQuestion
        : isHintSupportedByScenario({ hint: currentQuestionHint, lines: scenarioLines })
          ? currentQuestionHint
          : transcriptQuestion || currentQuestionHint
    ) || "How would you handle this scenario?";
  const setupLines = scenarioLines
    .filter((line, index) => index < scenarioLines.length - 1 || normalizeSpaces(line.text) !== question)
    .map((line) => `- ${line.speaker}: ${clipText(line.text, 220)}`);
  const setup = normalizeSpaces(
    scenarioLines
      .filter((line, index) => index < scenarioLines.length - 1 || normalizeSpaces(line.text) !== question)
      .map((line) => line.text)
      .join(" "),
  );
  if (!setup && !SCENARIO_PROBLEM_RE.test(question)) return null;

  const scenarioPacket = buildScenarioPacket({
    lines: scenarioLines,
    setup: setup || allText,
    question,
  });
  const constraintLines = [
    `- domain: ${scenarioPacket.domain}`,
    scenarioPacket.actors.length ? `- actors: ${scenarioPacket.actors.join(", ")}` : "",
    scenarioPacket.constraints.length ? `- constraints: ${scenarioPacket.constraints.join("; ")}` : "",
    scenarioPacket.numbers.length ? `- numbers: ${scenarioPacket.numbers.join(", ")}` : "",
    scenarioPacket.failureSymptom ? `- failure: ${scenarioPacket.failureSymptom}` : "",
  ].filter(Boolean);

  const text = [
    "Scenario Setup:",
    ...constraintLines,
    ...(setupLines.length > 0 ? setupLines : [`- candidate: ${clipText(setup || allText, 220)}`]),
    "",
    "Question:",
    question,
  ].join("\n");

  return {
    lines: scenarioLines,
    text,
    compactQuery: scenarioPacket.compactQuery,
    scenarioSetup: setup || allText,
    scenarioQuestion: question,
    scenarioPacket,
  };
}

function inferTone(text: string): InterviewerTone {
  const normalized = normalizeSpaces(text);
  if (!normalized) return "neutral";
  if (URGENCY_RE.test(normalized)) return "urgency";
  if (SKEPTICAL_RE.test(normalized)) return "skeptical";
  if (STRESS_TEST_RE.test(normalized)) return "stress_test";
  if (CHALLENGE_RE.test(normalized)) return "challenge";
  if (CLARIFICATION_RE.test(normalized)) return "clarification";
  if (DEEP_DIVE_RE.test(normalized)) return "deep_dive";
  if (SCENARIO_ASK_RE.test(normalized)) return "deep_dive";
  return "neutral";
}

export function detectInterviewerTone(input: {
  text: string;
  scenarioDetected: boolean;
}): InterviewerTone {
  if (input.scenarioDetected && STRESS_TEST_RE.test(input.text)) return "stress_test";
  return inferTone(input.text);
}

export function sanitizeLiveRequestContext(input: {
  metadata?: AIAnswerLiveContextMetadata;
  transcriptEvidence?: TranscriptEvidenceV3;
  isRegenerate: boolean;
}): SanitizedLiveRequest {
  return sanitizeLiveRequestContextV4(input);
}

export function sanitizeLiveAnswerMetadataForLatestQuestion(input: {
  metadata?: AIAnswerLiveContextMetadata;
  transcriptEvidence?: TranscriptEvidenceV3;
  isRegenerate?: boolean;
}): LiveAnswerMetadataSanitization {
  const sanitized = sanitizeLiveRequestContext({
    metadata: input.metadata,
    transcriptEvidence: input.transcriptEvidence,
    isRegenerate: input.isRegenerate === true,
  });
  return {
    metadata: sanitized.metadata,
    originalMode: input.metadata?.answerClickMode,
    effectiveMode: sanitized.metadata?.answerClickMode,
    selectedTopic: normalizeSpaces(input.metadata?.selectedAnswerTopic || ""),
    scenarioDetected: sanitized.scenarioDetected,
    clearReason: sanitized.clearReason,
    kind: sanitized.kind,
    allowPreviousAnswer: sanitized.allowPreviousAnswer,
    allowSelectedAnswer: sanitized.allowSelectedAnswer,
    allowCodeMemory: sanitized.allowCodeMemory,
    interviewerTone: sanitized.interviewerTone,
    ...(sanitized.scenarioPacket ? { scenarioPacket: sanitized.scenarioPacket } : {}),
  };
}
