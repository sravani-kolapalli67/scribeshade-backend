// ─────────────────────────────────────────────────────────────────────────────
// Resume Feature — Shared Types
// ─────────────────────────────────────────────────────────────────────────────

export interface AtsAnalysisResult {
  score: number;
  grade: string;
  summary: string;
  strengths: string[];
  weaknesses: string[];
  missingKeywords: string[];
  suggestions: string[];
  sectionScores: Record<string, number>;
}

export interface CoverLetterRequest {
  resumeId: string;
  userId?: string;
  jobRole?: string;
  company?: string;
  jobDescription?: string;
  tone?: string;
  userName?: string;
  userEmail?: string;
}

export interface CreateTemplateRequest {
  name: string;
  category: string;
  thumbnail: string;
  code: string;
}

// ─── Resume Builder Types ─────────────────────────────────────────────────────

export interface ResumeFields {
  name: string;
  role: string;
  email: string;
  phone: string;
  location: string;
  links: string;
  summary: string;
  experience: string;
  skillsLanguages: string;
  skillsFrameworks: string;
  skillsDatabases: string;
  skillsTools: string;
  projects: string;
  education: string;
  certifications: string;
  publications: string;
}

export interface SectionDef {
  id: string;
  label: string;
  required: boolean;
  enabled: boolean;
}

export interface SaveBuiltResumeInput {
  userId: string;
  resumeId?: string | null;
  title: string;
  templateId: string;
  fields: ResumeFields;
  sections: SectionDef[];
  jobDescription?: string;
  jobTitle?: string;
  company?: string;
}

export interface GenerateResumeHtmlInput {
  userId: string;
  templateCode: string;
  fields: ResumeFields;
  jobDescription?: string;
  jobTitle?: string;
  company?: string;
  idempotencyKey?: string | null;
}

export interface EnhanceSectionInput {
  userId: string;
  sectionId: string;
  currentText: string;
  jobDescription?: string;
  jobTitle?: string;
  resumeContext?: string;
  idempotencyKey?: string | null;
  resumeId?: string | null;
}

export interface ExtractFieldsInput {
  userId: string;
  resumeContext: string;
  jobDescription?: string;
  jobTitle?: string;
  company?: string;
  idempotencyKey?: string | null;
}

export interface MarkBuiltResumeCompleteInput {
  resumeId: string;
  userId: string;
}

export interface TailorResumeInput {
  userId: string;
  resumeId: string;
  jobDescription: string;
  jobTitle?: string;
  company?: string;
  idempotencyKey?: string | null;
}

export interface ExportPdfInput {
  userId?: string;
  resumeId?: string;
  populatedHtml?: string;
}

// ─── Section Validation Types ─────────────────────────────────────────────────

export interface ValidateSectionInput {
  sectionId: string;
  currentText: string;
  jobTitle?: string;
  company?: string;
  /** Short context snippet: candidate name + role */
  resumeContext?: string;
}

export interface SectionConstraints {
  minWords: number;
  maxWords: number;
  /** null when bullets aren't applicable (e.g. summary) */
  minBullets: number | null;
  maxBullets: number | null;
  /** One-sentence explanation from the AI */
  reason: string;
}

export interface SectionValidationResult {
  score: number; // 0–100
  status: "excellent" | "good" | "needs_improvement" | "poor";
  issues: string[];
  suggestions: string[];
  constraints: SectionConstraints;
  wordCount: number;
}
