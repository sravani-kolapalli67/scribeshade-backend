export type ExtractedAnswerPair = {
  question: string;
  answer: string;
};

function normalizeSpaces(text: string): string {
  return (text || "").replace(/\s+/g, " ").trim();
}

function normalizeEvidenceKeyText(text: string): string {
  return normalizeSpaces(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s?]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function evidenceTokens(text: string): string[] {
  const stopwords = new Set([
    "the",
    "and",
    "you",
    "your",
    "can",
    "could",
    "would",
    "please",
    "about",
    "more",
    "details",
    "specific",
    "with",
    "that",
    "this",
    "have",
    "done",
    "what",
    "how",
    "why",
    "when",
    "where",
  ]);
  return normalizeEvidenceKeyText(text)
    .replace(/\?/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 2 && !stopwords.has(token));
}

function isQuestionStronglySupportedByEvidence(question: string, evidenceText: string): boolean {
  const normalizedQuestion = normalizeEvidenceKeyText(question);
  const normalizedEvidence = normalizeEvidenceKeyText(evidenceText);
  if (!normalizedQuestion || !normalizedEvidence) return false;
  if (normalizedEvidence.includes(normalizedQuestion)) return true;

  const questionTokens = evidenceTokens(question);
  if (questionTokens.length < 3) return false;
  const evidenceTokenSet = new Set(evidenceTokens(evidenceText));
  const overlapCount = questionTokens.filter((token) => evidenceTokenSet.has(token)).length;
  return overlapCount / questionTokens.length >= 0.75;
}

export function shouldScheduleBackgroundComposer(envValue: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes((envValue || "").trim().toLowerCase());
}

export function filterPersistableAnswerPairs(input: {
  pairs: ExtractedAnswerPair[];
  evidenceText: string;
  sessionId?: string;
}): ExtractedAnswerPair[] {
  if (input.pairs.length <= 1) return input.pairs;
  const [firstPair, ...extraPairs] = input.pairs;
  const supportedPairs = extraPairs.filter((pair) => {
    const supported = isQuestionStronglySupportedByEvidence(pair.question, input.evidenceText);
    if (!supported) {
      console.warn("[AI Answer] dropped unsupported generated question", {
        sessionId: input.sessionId,
        question: pair.question,
      });
    }
    return supported;
  });
  return [firstPair, ...supportedPairs];
}
