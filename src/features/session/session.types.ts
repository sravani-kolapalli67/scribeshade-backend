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
  questionBankContributionOptIn: boolean;
  mode: string;
  free: boolean;
  /** IDs of AI-generated Project records to include as context */
  projectIds?: string[];
  /** Primary project ID when multiple projects are selected */
  primaryProjectId?: string;
}
