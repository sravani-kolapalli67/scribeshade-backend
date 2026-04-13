// ─────────────────────────────────────────────────────────────────────────────
// Resume Feature — Shared Types
// ─────────────────────────────────────────────────────────────────────────────

export interface AtsAnalysisResult {
  score: number;
  summary: string;
  strengths: string[];
  weaknesses: string[];
  missingKeywords: string[];
  suggestions: string[];
}

export interface CoverLetterRequest {
  resumeId: string;
  jobRole?: string;
  company?: string;
  jobDescription?: string;
  tone?: string;
}

export interface CreateTemplateRequest {
  category: string;
  thumbnail: string;
  code: string;
}
