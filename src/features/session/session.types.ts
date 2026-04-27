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
  isActive: boolean;
  createdAt: Date;
  startedAt?: Date;
  endedAt?: Date;
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
