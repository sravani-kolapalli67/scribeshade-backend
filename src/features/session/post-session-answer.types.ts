import { SessionAnswerRevisionSource } from "@prisma/client";

export const POST_SESSION_AI_MODES = [
  "improve",
  "shorten",
  "expand",
  "simplify",
  "regenerate",
  "custom",
] as const;

export type PostSessionAiMode = (typeof POST_SESSION_AI_MODES)[number];

export type ApplyAnswerInput = {
  answer: string;
  baseVersion: number;
  source: SessionAnswerRevisionSource;
  aiMode?: PostSessionAiMode;
  instruction?: string;
  model?: string;
};

export type EditableAnswer = {
  sessionId: string;
  messageId: string;
  userId: string;
  question: string;
  answer: string;
  currentVersion: number;
  qaId?: string;
  timestamp?: string;
};

export type AnswerRevisionDto = {
  id: string;
  version: number;
  question: string;
  answer: string;
  source: string;
  aiMode?: string;
  instruction?: string;
  model?: string;
  createdAt: string;
};

