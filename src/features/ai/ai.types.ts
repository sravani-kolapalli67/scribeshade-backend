import { z } from "zod";

export const projectGenerationRequestSchema = z.object({
  resume_id: z.string().uuid().optional(),
  primary_resume_project: z.string().min(2).optional(),
  role_type: z.string().min(2, "role_type is required"),
  jd_text: z.string().optional().default(""),
  experience_level: z
    .enum(["fresher", "junior", "mid", "senior", "lead"])
    .optional()
    .default("mid"),
  resume_skills: z.array(z.string().min(1)).optional().default([]),
  session_key: z.string().optional(),
});

export type ProjectGenerationRequest = z.infer<
  typeof projectGenerationRequestSchema
>;

export const detectResumeProjectsRequestSchema = z.object({
  resume_id: z.string().uuid(),
});

export type DetectResumeProjectsRequest = z.infer<
  typeof detectResumeProjectsRequestSchema
>;

export const projectGenerationResponseSchema = z.object({
  project_title: z.string(),
  narrative: z.string(),
  star_story: z.object({
    situation: z.string(),
    task: z.string(),
    action: z.string(),
    result: z.string(),
  }),
  architecture: z.object({
    frontend: z.string(),
    backend: z.string(),
    database: z.string(),
    infrastructure: z.string(),
  }),
  ascii_diagram: z.string(),
  thirty_sec_summary: z.string(),
  memory_hooks: z.array(z.string()),
  credibility_score: z.number().min(0).max(100),
  credibility_warning: z.boolean(),
  warning_message: z.string().optional(),
  scope_limited: z.boolean(),
  credits_consumed: z.number(),
});

export type ProjectGenerationResponse = z.infer<
  typeof projectGenerationResponseSchema
>;

export interface SkillMismatchResult {
  mismatchRatio: number;
  scopeLimited: boolean;
  allowedSkills: string[];
}
