import { OpenRouter } from "@openrouter/sdk";
import path from "path";
import { prisma } from "../../shared/lib/prisma";
import * as resumeService from "../resume/resume.service";
import {
  GenerateProjectRequest,
  AIProjectGenerationResponse,
} from "./projects.types";

const OPENROUTER_MODEL =
  process.env.OPENROUTER_MODEL || "google/gemini-2.0-flash-001";

if (!process.env.OPENROUTER_API_KEY) {
  throw new Error("OPENROUTER_API_KEY environment variable is not defined");
}

const ai = new OpenRouter({
  apiKey: process.env.OPENROUTER_API_KEY,
});

/**
 * Parses a JSON response string from AI.
 */
export function parseJsonResponse<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]) as T;
      } catch {
        return null;
      }
    }
    return null;
  }
}

/**
 * Generates AI projects and streams the response.
 */
export async function* streamAIProjects(params: GenerateProjectRequest) {
  const {
    resumeId,
    resumeText: providedResumeText,
    position,
    jobDescription,
  } = params;

  let resumeContext = providedResumeText || "";

  if (resumeId) {
    const resume = await prisma.resume.findUnique({ where: { id: resumeId } });
    if (resume) {
      const ext = path.extname(resume.path).toLowerCase();
      resumeContext = await resumeService.extractTextFromFile(resume.path, ext);
    }
  }

  const prompt = `
You are a senior software architect, data engineer, and technical documentation expert.

Your job is to generate **production-grade, portfolio-ready project documentation** that resembles a **modern engineering dashboard / case study page**.

This is NOT a resume task.
This is NOT a summary task.
This is a **deep technical storytelling + structured data generation task**.

---

## INPUTS

RESUME:
${resumeContext || "No resume provided."}

POSITION:
${position}

JOB DESCRIPTION:
${jobDescription}

---

## CORE OBJECTIVE

Generate **EXACTLY 3 projects**, each with:

* Deep technical detail
* Realistic architecture and scale
* Business + engineering alignment
* Clean structure for frontend rendering
* Rich sections (like a SaaS case study UI)

Each project should feel like:
👉 A real production system
👉 Built by an experienced engineer
👉 Tailored to the given JOB DESCRIPTION

---

## CRITICAL OUTPUT RULES

1. Output exactly 3 JSON objects.
2. No markdown wrappers (no \`\`\`json), no explanation, no extra text.
3. IMPORTANT: After each project's closing JSON brace, append the delimiter string exactly: |||PROJECT_END||| followed by a newline.
4. Each project must be COMPLETE before moving to the next.
5. Avoid generic phrases like "improved performance" → quantify everything.
6. Every section must have meaningful depth (no placeholders).
7. Use realistic tools, infra, and constraints.
8. Ensure all 3 projects are DIFFERENT in nature.

---

## JSON STRUCTURE (STRICT)

Repeat this structure for each of the 3 projects:

{
"projectHeader": {
"title": "",
"tagline": "",
"domain": "",
"duration": "",
"teamSize": ""
},

/** STRUCTURE START **/
  "introduction": {
    "summary": "",
    "context": "",
    "goal": ""
  },

  "resumeReadyPoints": [
    "", "", "", ""
  ],

  "howToExplain": {
    "elevatorPitch": "",
    "detailedExplanation": ""
  },

  "businessPurpose": {
    "problemStatement": "",
    "businessGoal": "",
    "targetUsers": "",
    "successCriteria": ""
  },

  "architecture": {
    "overview": "",
    "components": [
      {
        "name": "",
        "description": "",
        "tech": []
      }
    ]
  },

  "dataFlow": [
    {
      "step": "",
      "description": ""
    }
  ],

  "codeSnippets": [
    {
      "title": "",
      "purpose": "",
      "code": ""
    }
  ],

  "clusterAndNodes": {
    "infrastructure": "",
    "details": [
      {
        "component": "",
        "configuration": ""
      }
    ]
  },

  "techStack": {
    "frontend": [],
    "backend": [],
    "data": [],
    "devops": [],
    "monitoring": []
  },

  "dataCharacteristics": {
    "volume": "",
    "velocity": "",
    "variety": "",
    "veracity": ""
  },

  "databaseSchema": [
    {
      "table": "",
      "fields": ["", ""],
      "description": ""
    }
  ],

  "toolIntegrationMap": [
    {
      "tool": "",
      "role": "",
      "interaction": ""
    }
  ],

  "whyTheseTools": [
    {
      "tool": "",
      "reason": ""
    }
  ],

  "methodology": {
    "developmentApproach": "",
    "workflow": ""
  },

  "ciCdPipeline": [
    {
      "stage": "",
      "tools": [],
      "description": ""
    }
  ],

  "environmentSetup": {
    "development": "",
    "staging": "",
    "production": ""
  },

  "monitoringAndAlerting": [
    {
      "tool": "",
      "purpose": "",
      "alertType": ""
    }
  ],

  "challengesAndResolutions": [
    {
      "challenge": "",
      "solution": ""
    }
  ],

  "productionIssues": [
    {
      "issue": "",
      "impact": "",
      "fix": ""
    }
  ],

  "performanceOptimization": [
    {
      "area": "",
      "technique": "",
      "result": ""
    }
  ],

  "keyAchievements": [
    {
      "metric": "",
      "value": "",
      "description": ""
    }
  ],

  "technicalLearnings": [
    "", "", ""
  ]
}
|||PROJECT_END|||

---

## DEPTH REQUIREMENTS (VERY IMPORTANT)

* Architecture must feel like real system design (microservices, pipelines, APIs, etc.)
* Data flow must be step-by-step and logical
* Code snippets must look realistic (not pseudo fluff)
* Metrics must include numbers (%, ms, scale, throughput, etc.)
* Challenges must feel like real engineering problems
* CI/CD must include real tools (GitHub Actions, Jenkins, etc.)
* Monitoring must include real tools (Prometheus, Grafana, etc.)

---

## STYLE GUIDELINES

* Write like internal engineering docs + product case study
* Avoid fluff, focus on clarity and precision
* Keep content structured for UI rendering (cards, sections)
* Use concise but information-dense language

---

Now generate the response.
`.trim();

  const stream = await ai.chat.send({
    chatRequest: {
      model: OPENROUTER_MODEL,
      messages: [
        { role: "system", content: "You are an expert technical architect." },
        { role: "user", content: prompt },
      ],
      stream: true,
    },
  });

  for await (const chunk of stream) {
    const text = chunk.choices[0]?.delta?.content || "";
    if (text) yield text;
  }
}

/**
 * Saves a generated project batch to the database.
 */
export async function saveProjectBatch(
  userId: string,
  position: string,
  jobDescription: string,
  projects: any[],
  resumeId?: string,
) {
  return prisma.project.create({
    data: {
      userId,
      position,
      jobDescription,
      resumeId: resumeId || null,
      projects: projects,
    },
  });
}

/**
 * Returns all stored projects for a given user.
 */
export async function getProjectsByUser(userId: string) {
  return prisma.project.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
  });
}

/**
 * Returns a single project record by its database ID.
 */
export async function getProjectById(id: string) {
  return prisma.project.findUnique({
    where: { id },
  });
}
