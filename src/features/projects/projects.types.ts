export interface GenerateProjectRequest {
  userId: string;
  resumeId?: string;
  resumeText?: string;
  position: string;
  jobDescription: string;
  industry?: string;
  experienceLevel?: string;
  /**
   * "new"             — Invent completely new projects; resume skills are used for
   *                     tech-stack plausibility only, NOT as a source of existing work.
   * "resume_enhanced" — Deeply analyse the resume and enhance/expand the candidate's
   *                     EXISTING experience into polished, interview-ready case studies.
   * Defaults to "new" when omitted.
   */
  generationMode?: "new" | "resume_enhanced";
  /**
   * When false, stream and charge for generated projects but do not create a new
   * Project row. Used by regeneration flows that replace an existing record.
   */
  persistGeneratedRecord?: boolean;
}

// ── Dynamic Section System ────────────────────────────────────────────────

/**
 * All supported section rendering types.
 * The AI picks the right type for each section based on role context.
 */
export type SectionType =
  | "bullets"          // string[] — achievement bullets
  | "narrative"        // string  — prose paragraph(s)
  | "how_to_explain"   // { elevatorPitch, detailedExplanation }
  | "star_story"       // { situation, task, action, result }
  | "thirty_second_summary" // { hook, mainPoints: string[], closingLine }
  | "architecture_tree"     // { layers: [{name, color, nodes: [{name, description, tech, children?}]}] }
  | "metadata"         // { fields: [{label, value}] }
  | "code_block"       // string  — ASCII diagram / monospace
  | "tech_tags"        // [{category, tags[]}]
  | "steps"            // [{step, description}]
  | "challenge_cards"  // [{challenge, solution}]
  | "metrics"          // [{metric, value, description, before?, after?}]
  | "quote_cards"      // string[] — first-person learning quotes
  | "key_value_pairs"  // [{key, value}]
  | "comparison_table" // [{decision, winner, loser, rationale}]
  | "cards"            // [{title, body, badge?}]
  | "table"            // {headers: string[], rows: string[][]}
  | "timeline"         // [{date, event, description}]
  | "code_snippets";   // [{title, language, purpose, code}]

export interface ProjectSection {
  key: string;
  title: string;
  subtitle: string;
  type: SectionType;
  content: unknown;
}

export interface ProjectResponse {
  projectHeader: {
    title: string;
    tagline: string;
    domain: string;
    duration: string;
    teamSize: string;
    role: string;
  };
  sections: ProjectSection[];
  /** Set to true when generated project scope was limited to user's known skill set */
  scope_limited?: boolean;
  /** Set to true when outcome metrics may exceed typical expectations for the experience level */
  credibility_warning?: boolean;
}

export interface AIProjectGenerationResponse {
  id?: string;
  userId: string;
  resumeId?: string | null;
  position: string;
  jobDescription: string;
  projects: ProjectResponse[];
  createdAt?: Date;
  updatedAt?: Date;
}

// ── Legacy types (kept for reference) ────────────────────────────────────

export interface ProjectHeader {
  title: string;
  tagline: string;
  domain: string;
  duration: string;
  teamSize: string;
}

export interface ProjectIntroduction {
  summary: string;
  context: string;
  goal: string;
}

export interface HowToExplain {
  elevatorPitch: string;
  detailedExplanation: string;
}

export interface BusinessPurpose {
  problemStatement: string;
  businessGoal: string;
  targetUsers: string;
  successCriteria: string;
}

export interface ArchitectureComponent {
  name: string;
  description: string;
  tech: string[];
}

export interface Architecture {
  overview: string;
  components: ArchitectureComponent[];
}

export interface DataFlowStep {
  step: string;
  description: string;
}

export interface CodeSnippet {
  title: string;
  purpose: string;
  code: string;
}

export interface ClusterNodeDetail {
  component: string;
  configuration: string;
}

export interface ClusterAndNodes {
  infrastructure: string;
  details: ClusterNodeDetail[];
}

export interface TechStack {
  frontend: string[];
  backend: string[];
  data: string[];
  devops: string[];
  monitoring: string[];
}

export interface DataCharacteristics {
  volume: string;
  velocity: string;
  variety: string;
  veracity: string;
}

export interface DatabaseTable {
  table: string;
  fields: string[];
  description: string;
}

export interface ToolIntegration {
  tool: string;
  role: string;
  interaction: string;
}

export interface WhyTool {
  tool: string;
  reason: string;
}

export interface Methodology {
  developmentApproach: string;
  workflow: string;
}

export interface CiCdStage {
  stage: string;
  tools: string[];
  description: string;
}

export interface EnvironmentSetup {
  development: string;
  staging: string;
  production: string;
}

export interface MonitoringAlert {
  tool: string;
  purpose: string;
  alertType: string;
}

export interface ChallengeResolution {
  challenge: string;
  solution: string;
}

export interface ProductionIssue {
  issue: string;
  impact: string;
  fix: string;
}

export interface PerformanceOptimization {
  area: string;
  technique: string;
  result: string;
}

export interface KeyAchievement {
  metric: string;
  value: string;
  description: string;
}
// Legacy ProjectResponse and AIProjectGenerationResponse removed — see new versions above
