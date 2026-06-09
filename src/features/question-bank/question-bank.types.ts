import {
  QuestionBankDifficulty,
  QuestionBankModerationStatus,
  QuestionBankPrivacyRisk,
  QuestionBankQuestionType,
  QuestionBankSourceType,
  QuestionBankVisibility,
  QuestionBankVisibilityClass,
} from "@prisma/client";

export type Pagination = {
  total: number;
  page: number;
  limit: number;
  pages: number;
};

export type DifficultyMix = {
  easy: number;
  medium: number;
  hard: number;
  expert: number;
};

export type PublicCompany = {
  id: string;
  name: string;
  slug: string;
  industry?: string;
};

export type PublicRole = {
  id: string;
  name: string;
  slug: string;
  seniority?: string;
  category?: string;
};

export type PublicQuestion = {
  id: string;
  title: string;
  normalizedQuestion: string;
  company?: {
    name: string;
    slug: string;
  };
  role?: {
    name: string;
    slug: string;
  };
  industry?: string;
  technologies: string[];
  topics: string[];
  questionType: string;
  difficulty: "easy" | "medium" | "hard" | "expert";
  complexityScore: number;
  frequencyCount: number;
  sourceCount: number;
  lastSeenAt: string;
  answerGuideAvailable: boolean;
};

export type QuestionBankAnalytics = {
  totalValidQuestions: number;
  uniqueTopics: number;
  topTechnologies: string[];
  topTopics: string[];
  difficultyMix: DifficultyMix;
  questionTypeDistribution: Record<string, number>;
  mostRepeatedQuestions: Array<{
    id: string;
    title: string;
    frequencyCount: number;
  }>;
};

export type CompanyExploreItem = PublicCompany & {
  availableRoles: number;
  validQuestions: number;
  topTechnologies: string[];
  difficultyMix: DifficultyMix;
  lastUpdatedAt: string;
};

export type RoleExploreItem = PublicRole & {
  companiesSeenIn: number;
  questionCount: number;
  topTechnologies: string[];
  mostAskedTopics: string[];
  difficultyMix: DifficultyMix;
};

export type TechnologyExploreItem = {
  id: string;
  name: string;
  slug: string;
  category: string;
  relatedRoles: number;
  relatedCompanies: number;
  questionCount: number;
  commonQuestionTypes: string[];
  difficultyMix: DifficultyMix;
};

export type QuestionBankListQuery = {
  q?: string;
  company?: string;
  role?: string;
  technology?: string;
  topic?: string;
  industry?: string;
  questionType?: QuestionBankQuestionType;
  difficulty?: QuestionBankDifficulty;
  page: number;
  limit: number;
  sort: "recent" | "frequency" | "difficulty";
};

export type ExploreQuery = {
  q?: string;
  industry?: string;
  technology?: string;
  role?: string;
  difficulty?: QuestionBankDifficulty;
  minQuestions?: number;
  page: number;
  limit: number;
  sort: "recent" | "questions" | "name";
};

export type ExtractedInterviewQuestion = {
  rawDetectedQuestion: string;
  normalizedQuestion: string;
  visibilityClass: QuestionBankVisibilityClass;
  privacyRisk: QuestionBankPrivacyRisk;
  questionType: QuestionBankQuestionType;
  difficulty: QuestionBankDifficulty;
  complexityScore: number;
  technologies: string[];
  topics: string[];
  industry?: string;
  roleGuess?: string;
  companyGuess?: string;
  confidence: number;
  rejectReason?: string;
};

export type SanitizedExtractedQuestion = ExtractedInterviewQuestion & {
  normalizedQuestion: string;
  displayTitle: string;
  visibility: QuestionBankVisibility;
  moderationStatus: QuestionBankModerationStatus;
  sourceType: QuestionBankSourceType;
  rejectReason?: string;
};
