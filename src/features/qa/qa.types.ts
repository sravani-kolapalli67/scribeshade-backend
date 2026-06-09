import { Difficulty, Industry, Language } from "@prisma/client";

export interface CreateQAData {
  messageId?: string;
  userId?: string;
  sessionId?: string;
  companyId: string;
  ques: string;
  answer?: string;
  difficulty?: Difficulty;
  industry?: Industry;
  language?: Language;
  isShared?: boolean;
}

export interface UpdateQAData {
  answer?: string;
  difficulty?: Difficulty;
  industry?: Industry;
  language?: Language;
  isShared?: boolean;
}
