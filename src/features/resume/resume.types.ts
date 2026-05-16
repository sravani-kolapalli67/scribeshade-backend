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
  /** Issues identified by the section quality scorer — AI must fix these. */
  qualityIssues?: string[];
  /** Suggestions from the section quality scorer — AI must address these. */
  qualitySuggestions?: string[];
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
  /** DB UUID of a saved BuiltResume. Optional when tailoring a manual (unsaved) resume. */
  resumeId?: string;
  jobDescription: string;
  jobTitle?: string;
  company?: string;
  idempotencyKey?: string | null;
  /** Current resume field values — used when resumeId is absent (manual/unsaved resume). */
  fields?: Record<string, string>;
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

// ─── New Feature Types ────────────────────────────────────────────────────────

export interface RewriteResumeInput {
  userId: string;
  /** DB UUID of a saved BuiltResume. Optional when rewriting a manual resume. */
  resumeId?: string;
  /** Target job title (required). */
  jobTitle: string;
  company?: string;
  /** Optional seniority level hint. */
  targetLevel?: string;
  /** Current resume field values — used when resumeId is absent. */
  fields?: Partial<ResumeFields>;
  idempotencyKey?: string | null;
}

export interface InjectSkillsInput {
  userId: string;
  resumeId?: string;
  jobDescription?: string;
  jobTitle?: string;
  /** Current resume fields (for deduplication against existing skills). */
  fields: Partial<ResumeFields>;
  idempotencyKey?: string | null;
}

export interface InjectKeywordsInput {
  userId: string;
  resumeId?: string;
  jobDescription: string;
  /** Current resume fields whose editable sections will receive keywords. */
  fields: Partial<ResumeFields>;
  /** Specific keywords selected by the user to be injected. */
  selectedKeywords?: string[];
  idempotencyKey?: string | null;
}

export interface KeywordInjectionSuggestion {
  keyword: string;
  targetSection: string;
  suggestedContext: string;
  inject: boolean;
}

export interface AnalyzeKeywordsInput {
  userId: string;
  jobDescription: string;
  fields: Partial<ResumeFields>;
  idempotencyKey?: string | null;
}

export interface KeywordMatchInput {
  jobDescription: string;
  /** Current resume fields to analyse for keyword coverage. */
  fields: Partial<ResumeFields>;
}

export interface KeywordMatchResult {
  present: string[];
  missing: string[];
  matchScore: number;
  /** Map of keyword to sections where it appears. */
  visualMap: Record<string, string[]>;
}
