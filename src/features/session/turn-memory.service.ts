import { prisma } from "../../shared/lib/prisma";

export type TurnMemoryEntry = {
  id: string;
  transcriptChunkId?: string;
  topicId?: string;
  questionClean: string;
  answerSummary: string;
  answerType: string;
  codeBlocks: string[];
  keyClaims: string[];
  followupKeys: string[];
  createdAt: Date;
};

type WriteTurnMemoryInput = {
  sessionId: string;
  transcriptChunkId?: string;
  topicId?: string;
  questionRaw: string;
  questionClean: string;
  answerRaw: string;
  saveTranscription: boolean;
};

function normalizeSpaces(text: string): string {
  return (text || "").replace(/\s+/g, " ").trim();
}

function normalizeKey(text: string): string {
  return normalizeSpaces(text).toLowerCase().replace(/[^a-z0-9+#.\s-]/g, "");
}

function tokenize(text: string): string[] {
  return normalizeKey(text).split(/\s+/).filter((token) => token.length > 2);
}

function unique(values: string[], limit: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const normalized = normalizeSpaces(value);
    const key = normalizeKey(normalized);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
    if (out.length >= limit) break;
  }
  return out;
}

export function extractCodeBlocksFromAnswer(answer: string): string[] {
  const matches = Array.from((answer || "").matchAll(/```[a-zA-Z0-9_-]*\n([\s\S]*?)```/g));
  return matches.map((match) => (match[1] || "").trim()).filter(Boolean).slice(0, 3);
}

function inferAnswerType(question: string, answer: string): string {
  const q = normalizeKey(question);
  if (extractCodeBlocksFromAnswer(answer).length > 0) return "code";
  if (/\b(system design|architecture|scalability|distributed)\b/.test(q)) return "system_design";
  if (/\b(project|experience|role|responsibility|impact)\b/.test(q)) return "project_explanation";
  if (/\b(scenario|suppose|imagine|production|incident)\b/.test(q)) return "scenario";
  if (/\b(behavioral|tell me about a time|conflict|challenge)\b/.test(q)) return "behavioral";
  return "prose";
}

function summarizeAnswer(answer: string): string {
  const withoutCode = normalizeSpaces(answer.replace(/```[\s\S]*?```/g, "[code omitted]"));
  if (withoutCode.length <= 700) return withoutCode;
  return `${withoutCode.slice(0, 680)}...`;
}

function extractClaims(answer: string): string[] {
  const sentences = normalizeSpaces(answer.replace(/```[\s\S]*?```/g, ""))
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 20);
  return unique(sentences, 5).map((sentence) => sentence.slice(0, 220));
}

function scoreTurn(queryTokens: Set<string>, entry: TurnMemoryEntry): number {
  const haystackTokens = tokenize(
    `${entry.questionClean} ${entry.answerSummary} ${entry.followupKeys.join(" ")}`,
  );
  let score = 0;
  for (const token of haystackTokens) {
    if (queryTokens.has(token)) score += 1;
  }
  if (entry.codeBlocks.length > 0 && queryTokens.has("code")) score += 4;
  return score;
}

export async function getRelevantTurnMemory(input: {
  sessionId: string;
  question: string;
  followupTargetId?: string;
  limit: number;
}): Promise<TurnMemoryEntry[]> {
  const rows = await prisma.sessionTurnMemory.findMany({
    where: { sessionId: input.sessionId },
    orderBy: { createdAt: "desc" },
    take: 12,
  });

  const entries = rows.map((row) => ({
    id: row.id,
    transcriptChunkId: row.transcriptChunkId || undefined,
    topicId: row.topicId || undefined,
    questionClean: row.questionClean,
    answerSummary: row.answerSummary,
    answerType: row.answerType,
    codeBlocks: Array.isArray(row.codeBlocks) ? (row.codeBlocks as string[]) : [],
    keyClaims: row.keyClaims,
    followupKeys: row.followupKeys,
    createdAt: row.createdAt,
  }));

  if (input.followupTargetId) {
    const exact = entries.find(
      (entry) =>
        entry.id === input.followupTargetId ||
        entry.transcriptChunkId === input.followupTargetId,
    );
    if (exact) return [exact, ...entries.filter((entry) => entry.id !== exact.id).slice(0, input.limit - 1)];
  }

  const queryTokens = new Set(tokenize(input.question));
  return entries
    .map((entry) => ({ entry, score: scoreTurn(queryTokens, entry) }))
    .sort((a, b) => b.score - a.score || b.entry.createdAt.getTime() - a.entry.createdAt.getTime())
    .slice(0, input.limit)
    .map((item) => item.entry);
}

export async function writeTurnMemory(input: WriteTurnMemoryInput): Promise<void> {
  if (!input.saveTranscription) return;

  const codeBlocks = extractCodeBlocksFromAnswer(input.answerRaw);
  const answerSummary = summarizeAnswer(input.answerRaw);
  const keyClaims = extractClaims(input.answerRaw);
  const followupKeys = unique(
    [
      ...tokenize(input.questionClean),
      ...tokenize(answerSummary).slice(0, 12),
      ...codeBlocks.flatMap((block) => tokenize(block).slice(0, 8)),
    ],
    24,
  );

  await prisma.sessionTurnMemory.create({
    data: {
      sessionId: input.sessionId,
      transcriptChunkId: input.transcriptChunkId,
      topicId: input.topicId,
      questionRaw: normalizeSpaces(input.questionRaw),
      questionClean: normalizeSpaces(input.questionClean),
      answerRaw: input.answerRaw,
      answerSummary,
      answerType: inferAnswerType(input.questionClean, input.answerRaw),
      codeBlocks,
      keyClaims,
      followupKeys,
    },
  });
}
