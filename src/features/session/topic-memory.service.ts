import { prisma } from "../../shared/lib/prisma";

export type ActiveTopicMemory = {
  id: string;
  topicTitle: string;
  topicKeywords: string[];
  currentSummary: string;
  lastQuestion?: string;
  lastAnswer?: string;
};

type WriteTopicMemoryInput = {
  sessionId: string;
  question: string;
  answer: string;
  topicTitle: string;
  topicKeywords: string[];
  saveTranscription: boolean;
};

function normalizeSpaces(text: string): string {
  return (text || "").replace(/\s+/g, " ").trim();
}

function uniqueKeywords(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const keyword = normalizeSpaces(value).toLowerCase();
    if (keyword.length < 2 || seen.has(keyword)) continue;
    seen.add(keyword);
    out.push(keyword);
  }
  return out.slice(0, 16);
}

function summarizeTopic(input: {
  previousSummary: string;
  question: string;
  answer: string;
  topicTitle: string;
}): string {
  const answerSummary = normalizeSpaces(input.answer)
    .replace(/```[\s\S]*?```/g, "[code omitted]")
    .slice(0, 500);
  const next = [
    input.previousSummary,
    `${input.topicTitle}: ${normalizeSpaces(input.question).slice(0, 180)} -> ${answerSummary}`,
  ]
    .filter(Boolean)
    .join(" ");
  return normalizeSpaces(next).slice(-900);
}

export async function getActiveTopicMemory(
  sessionId: string,
): Promise<ActiveTopicMemory | null> {
  const memory = await prisma.sessionTopicMemory.findFirst({
    where: { sessionId, active: true },
    orderBy: { updatedAt: "desc" },
  });
  if (!memory) return null;
  return {
    id: memory.id,
    topicTitle: memory.topicTitle,
    topicKeywords: memory.topicKeywords,
    currentSummary: memory.currentSummary,
    lastQuestion: memory.lastQuestion || undefined,
    lastAnswer: memory.lastAnswer || undefined,
  };
}

export async function writeTopicMemory(
  input: WriteTopicMemoryInput,
): Promise<void> {
  if (!input.saveTranscription) return;

  const topicTitle = normalizeSpaces(input.topicTitle) || "general";
  const topicKeywords = uniqueKeywords(input.topicKeywords);
  const active = await prisma.sessionTopicMemory.findFirst({
    where: { sessionId: input.sessionId, active: true },
    orderBy: { updatedAt: "desc" },
  });
  const summary = summarizeTopic({
    previousSummary: active?.currentSummary || "",
    question: input.question,
    answer: input.answer,
    topicTitle,
  });

  if (active && active.topicTitle === topicTitle) {
    await prisma.sessionTopicMemory.update({
      where: { id: active.id },
      data: {
        topicKeywords: uniqueKeywords([...active.topicKeywords, ...topicKeywords]),
        currentSummary: summary,
        lastQuestion: normalizeSpaces(input.question),
        lastAnswer: normalizeSpaces(input.answer).slice(0, 1200),
      },
    });
    return;
  }

  if (active) {
    await prisma.sessionTopicMemory.update({
      where: { id: active.id },
      data: { active: false },
    });
  }

  await prisma.sessionTopicMemory.create({
    data: {
      sessionId: input.sessionId,
      topicTitle,
      topicKeywords,
      currentSummary: summary,
      lastQuestion: normalizeSpaces(input.question),
      lastAnswer: normalizeSpaces(input.answer).slice(0, 1200),
      active: true,
    },
  });
}
