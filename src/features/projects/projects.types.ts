export interface GenerateProjectRequest {
  userId: string;
  resumeId?: string;
  resumeText?: string;
  position: string;
  jobDescription: string;
}

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

export interface ProjectResponse {
  projectHeader: ProjectHeader;
  introduction: ProjectIntroduction;
  resumeReadyPoints: string[];
  howToExplain: HowToExplain;
  businessPurpose: BusinessPurpose;
  architecture: Architecture;
  dataFlow: DataFlowStep[];
  codeSnippets: CodeSnippet[];
  clusterAndNodes: ClusterAndNodes;
  techStack: TechStack;
  dataCharacteristics: DataCharacteristics;
  databaseSchema: DatabaseTable[];
  toolIntegrationMap: ToolIntegration[];
  whyTheseTools: WhyTool[];
  methodology: Methodology;
  ciCdPipeline: CiCdStage[];
  environmentSetup: EnvironmentSetup;
  monitoringAndAlerting: MonitoringAlert[];
  challengesAndResolutions: ChallengeResolution[];
  productionIssues: ProductionIssue[];
  performanceOptimization: PerformanceOptimization[];
  keyAchievements: KeyAchievement[];
  technicalLearnings: string[];
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
