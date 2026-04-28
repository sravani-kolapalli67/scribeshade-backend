import { SessionStatus, DeductionReason } from "@prisma/client";

export interface Session {
  id: string;
  userId: string;
  companyId: string;
  jobDescription: string;
  resumeId: string;
  DocumentId: string;
  language: string;
  simpleLanguage: boolean;
  extraContext: string;
  autoGenerateResponse: boolean;
  saveTranscription: boolean;
  free: boolean;
  mode: string;
  status: SessionStatus;
  createdAt: Date;
  startedAt?: Date;
  endedAt?: Date;
  durationSeconds?: number;
  pausedDurationSeconds: number;
  creditsHeld: string;
  creditsDeducted?: string;
  deductionReason?: DeductionReason;
  maxAllowedMinutes?: number;
  creditExhaustedAt?: Date;
}

export interface CreateSessionData {
  userId: string;
  companyName: string;
  jobDescription: string;
  resumeId: string;
  DocumentId: string;
  language: string;
  simpleLanguage: boolean;
  extraContext: string;
  autoGenerateResponse: boolean;
  saveTranscription: boolean;
  mode: string;
  free: boolean;
}
