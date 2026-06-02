import { SpeakerType } from "@prisma/client";
import type { AIAnswerLiveContextMetadata } from "./ai-answer.dto";

export type TranscriptCorrectionReason =
  | "stt_error"
  | "domain_term"
  | "resume_term"
  | "tech_term";

export type NormalizedTranscriptBlock = {
  rawText: string;
  cleanedText: string;
  correctedText: string;
  speakerType: "INTERVIEWER" | "CANDIDATE" | "UNKNOWN";
  confidence: number;
  corrections: Array<{
    from: string;
    to: string;
    reason: TranscriptCorrectionReason;
  }>;
};

type TranscriptNormalizationInput = {
  rawText: string;
  metadata?: AIAnswerLiveContextMetadata;
  dictionaryTerms: string[];
  activeTopicKeywords: string[];
  confidence: number;
};

const COMMON_STT_CORRECTIONS: Array<{
  pattern: RegExp;
  replacement: string;
  reason: TranscriptCorrectionReason;
}> = [
  { pattern: /\breactive\s+native\b/gi, replacement: "React Native", reason: "tech_term" },
  { pattern: /\bmongodibi\b|\bmongo\s+db\b/gi, replacement: "MongoDB", reason: "tech_term" },
  { pattern: /\bexpress\s+chairs\b|\bexpress\s+js\b/gi, replacement: "Express.js", reason: "tech_term" },
  { pattern: /\bpostgre\s+sequel\b|\bpostgress\b|\bpostgre\s*sql\b/gi, replacement: "PostgreSQL", reason: "tech_term" },
  { pattern: /\btype\s*script\b/gi, replacement: "TypeScript", reason: "tech_term" },
  { pattern: /\bjava\s*script\b/gi, replacement: "JavaScript", reason: "tech_term" },
  { pattern: /\bnode\s+js\b/gi, replacement: "Node.js", reason: "tech_term" },
  { pattern: /\brest\s+api\b/gi, replacement: "REST API", reason: "tech_term" },
  { pattern: /\bci\s+cd\b/gi, replacement: "CI/CD", reason: "tech_term" },
  { pattern: /\bkuber\s*net(?:es|is)\b/gi, replacement: "Kubernetes", reason: "tech_term" },
  { pattern: /\brack\s+pipeline\b/gi, replacement: "RAG pipeline", reason: "tech_term" },
];

const FILLER_RE =
  /\b(?:uh|um|erm|hmm|like|you know|i mean|okay so|yeah so)\b/gi;

function normalizeSpaces(text: string): string {
  return (text || "").replace(/\s+/g, " ").trim();
}

function normalizedKey(text: string): string {
  return normalizeSpaces(text).toLowerCase().replace(/[^a-z0-9+#.\s-]/g, "");
}

function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0.65;
  return Math.max(0, Math.min(1, value));
}

function mapSpeakerType(speakerType: string | undefined): NormalizedTranscriptBlock["speakerType"] {
  if (speakerType === "interviewer" || speakerType === SpeakerType.INTERVIEWER) return "INTERVIEWER";
  if (speakerType === "candidate" || speakerType === SpeakerType.CANDIDATE) return "CANDIDATE";
  return "UNKNOWN";
}

function uniqueTerms(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const term = normalizeSpaces(value);
    const key = normalizedKey(term);
    if (term.length < 2 || seen.has(key)) continue;
    seen.add(key);
    out.push(term);
  }
  return out;
}

function applyRegexCorrections(
  text: string,
): { correctedText: string; corrections: NormalizedTranscriptBlock["corrections"] } {
  let correctedText = text;
  const corrections: NormalizedTranscriptBlock["corrections"] = [];

  for (const correction of COMMON_STT_CORRECTIONS) {
    correctedText = correctedText.replace(correction.pattern, (match) => {
      if (match === correction.replacement) return match;
      corrections.push({
        from: match,
        to: correction.replacement,
        reason: correction.reason,
      });
      return correction.replacement;
    });
  }

  return { correctedText, corrections };
}

function applyDictionaryCorrections(
  text: string,
  terms: string[],
): { correctedText: string; corrections: NormalizedTranscriptBlock["corrections"] } {
  let correctedText = text;
  const corrections: NormalizedTranscriptBlock["corrections"] = [];
  const sortedTerms = uniqueTerms(terms).sort((a, b) => b.length - a.length);

  for (const term of sortedTerms) {
    const words = term.split(/\s+/).filter(Boolean);
    if (words.length === 0) continue;
    const loosePattern = words
      .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("\\s+");
    const pattern = new RegExp(`\\b${loosePattern}\\b`, "gi");
    correctedText = correctedText.replace(pattern, (match) => {
      if (match === term) return match;
      if (normalizedKey(match) !== normalizedKey(term)) return match;
      corrections.push({ from: match, to: term, reason: "domain_term" });
      return term;
    });
  }

  return { correctedText, corrections };
}

function cleanTranscriptText(text: string): string {
  return normalizeSpaces(
    text
      .replace(FILLER_RE, " ")
      .replace(/\b([a-z][a-z0-9+#.]*)\b(?:\s+\1\b)+/gi, "$1"),
  );
}

function blockFromText(input: {
  rawText: string;
  speakerType: NormalizedTranscriptBlock["speakerType"];
  dictionaryTerms: string[];
  confidence: number;
}): NormalizedTranscriptBlock {
  const rawText = normalizeSpaces(input.rawText);
  const cleanedText = cleanTranscriptText(rawText);
  const regexResult = applyRegexCorrections(cleanedText);
  const dictionaryResult = applyDictionaryCorrections(
    regexResult.correctedText,
    input.dictionaryTerms,
  );

  return {
    rawText,
    cleanedText,
    correctedText: normalizeSpaces(dictionaryResult.correctedText),
    speakerType: input.speakerType,
    confidence: clampConfidence(input.confidence),
    corrections: [...regexResult.corrections, ...dictionaryResult.corrections],
  };
}

export function normalizeTranscriptForAI(
  input: TranscriptNormalizationInput,
): NormalizedTranscriptBlock[] {
  const dictionaryTerms = uniqueTerms([
    ...input.dictionaryTerms,
    ...input.activeTopicKeywords,
  ]);
  const blocks: NormalizedTranscriptBlock[] = [];

  const speakerEntries = input.metadata?.speakerSeparatedTranscript || [];
  for (const entry of speakerEntries.slice(-12)) {
    const text = normalizeSpaces(entry.content || "");
    if (!text) continue;
    blocks.push(
      blockFromText({
        rawText: text,
        speakerType: mapSpeakerType(entry.speakerType),
        dictionaryTerms,
        confidence: input.confidence,
      }),
    );
  }

  if (blocks.length === 0) {
    blocks.push(
      blockFromText({
        rawText: input.rawText,
        speakerType: "UNKNOWN",
        dictionaryTerms,
        confidence: input.confidence,
      }),
    );
  }

  return blocks.filter((block) => block.correctedText.length > 0);
}

export function mergeNormalizedBlocks(blocks: NormalizedTranscriptBlock[]): string {
  return normalizeSpaces(blocks.map((block) => block.correctedText).join(" "));
}
