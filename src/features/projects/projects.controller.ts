import { Request, Response } from "express";
import path from "path";
import fs from "fs";
import * as projectsService from "./projects.service";
import * as resumeService from "../resume/resume.service";
import { getCurrentUserId } from "../auth/auth.middleware";
import { prisma } from "../../shared/lib/prisma";
import { AppError } from "../../shared/middleware/error.middleware";
import { GenerateProjectRequest } from "./projects.types";

/**
 * Safely deletes a file from the filesystem.
 */
function safeDeleteFile(filePath: string): void {
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {
    // Silent cleanup
  }
}

/**
 * POST /api/projects/generate
 */
export async function generateProjects(
  req: Request,
  res: Response,
): Promise<void> {
  let uploadedFilePath: string | undefined;

  try {
    const { resumeId, resumeText, position, jobDescription, industry, experienceLevel, generationMode } =
      req.body as Omit<GenerateProjectRequest, "userId">

    // ── Resolve caller's identity — Clerk token preferred, body.userId fallback ─
    let userId: string;
    try {
      const clerkId = getCurrentUserId(req);
      const user = await prisma.user.findUnique({ where: { clerkId } });
      if (!user) {
        if (req.file) safeDeleteFile(req.file.path);
        res.status(401).json({ error: "User not found — please sign in again" });
        return;
      }
      userId = user.id;
    } catch {
      // Fall back to body.userId (already resolved to DB UUID by resolveUserId middleware)
      const bodyUserId = req.body?.userId as string | undefined;
      if (bodyUserId) {
        userId = bodyUserId;
      } else {
        if (req.file) safeDeleteFile(req.file.path);
        res.status(401).json({ error: "Authentication required" });
        return;
      }
    }

    if (!position) {
      if (req.file) safeDeleteFile(req.file.path);
      res.status(400).json({ error: "position is required" });
      return;
    }

    // ── Credit gate (balance check only — no deduction yet) ─────────────────
    try {
      await projectsService.checkGenerationCreditBalance(userId);
    } catch (creditErr) {
      if (req.file) safeDeleteFile(req.file.path);
      const ae = creditErr as AppError;
      res.status(ae.statusCode ?? 402).json({ error: ae.message ?? "Insufficient credits" });
      return;
    }

    let finalResumeText = resumeText || "";

    // If a file was uploaded, extract its text
    if (req.file) {
      uploadedFilePath = req.file.path;
      const ext = path.extname(req.file.originalname).toLowerCase();
      try {
        const extracted = await resumeService.extractTextFromFile(
          uploadedFilePath,
          ext,
        );
        if (extracted) {
          finalResumeText = extracted;
        }
      } catch (err) {
        console.error("[projects.controller] Text extraction failed:", err);
        // We continue if resumeId or resumeText was also provided,
        // but if this was the only source, it might fail later.
      }
    }

    // Resume is optional — generation can proceed with just position + JD
    // Set headers for streaming
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Transfer-Encoding", "chunked");

    const params: GenerateProjectRequest = {
      userId,
      resumeId,
      resumeText: finalResumeText,
      position,
      jobDescription,
      industry,
      experienceLevel,
      generationMode: generationMode === "resume_enhanced" ? "resume_enhanced" : "new",
    };

    let buffer = "";
    const allProjects: any[] = [];
    const DELIMITER = "|||PROJECT_END|||";

    try {
      for await (const chunk of projectsService.streamAIProjects(params)) {
        buffer += chunk;

        // Check if buffer contains one or more full projects
        while (buffer.includes(DELIMITER)) {
          const parts = buffer.split(DELIMITER);
          const rawProject = parts.shift()?.trim();
          buffer = parts.join(DELIMITER);

          if (rawProject) {
            // Basic cleaning to remove potential markdown wrapping
            let cleanProject = rawProject
              .replace(/^```json\n?/, "")
              .replace(/\n?```$/, "")
              .trim();

            // Send the full project JSON to the client with the unique delimiter
            res.write(cleanProject + DELIMITER);

            // Parse for our background DB save
            const parsedProject =
              projectsService.parseJsonResponse<any>(cleanProject);
            if (parsedProject) {
              allProjects.push(parsedProject);
            }
          }
        }
      }
    } finally {
      res.end();
      if (uploadedFilePath) safeDeleteFile(uploadedFilePath);
    }

    // Background task: deduct credits + save to DB
    // Credits are only charged when at least one valid project was parsed.
    setTimeout(async () => {
      if (allProjects.length === 0) {
        console.warn(
          "[projects.controller] No valid projects were generated — skipping credit deduction and DB save",
        );
        return;
      }

      // Deduct credits now that we confirmed parseable output
      try {
        await projectsService.deductGenerationCredits(userId);
      } catch (creditErr) {
        console.error(
          "[projects.controller] Credit deduction failed after successful generation:",
          creditErr,
        );
        // Generation already streamed to the client; log and continue to save.
      }

      try {
        await projectsService.saveProjectBatch(
          userId,
          position,
          jobDescription,
          allProjects,
          resumeId,
          industry,
          experienceLevel,
        );
        console.log(
          `[projects.controller] Successfully saved batch of ${allProjects.length} projects for user ${userId}`,
        );
      } catch (saveErr) {
        console.error(
          "[projects.controller] Failed to save project batch:",
          saveErr,
        );
      }
    }, 0);
  } catch (error) {
    console.error("[projects.controller] generateProjects error:", error);
    if (uploadedFilePath) safeDeleteFile(uploadedFilePath);

    if (!res.headersSent) {
      res.status(500).json({ error: (error as Error).message });
    } else {
      res.end();
    }
  }
}

/**
 * GET /api/projects/user/:userId
 */
export async function listProjectsByUser(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const userId = req.params.userId as string;
    if (!userId) {
      res.status(400).json({ error: "userId is required" });
      return;
    }

    const projects = await projectsService.getProjectsByUser(userId);
    res.json(projects);
  } catch (error) {
    console.error("[projects.controller] listProjectsByUser error:", error);
    res.status(500).json({ error: (error as Error).message });
  }
}

/**
 * GET /api/projects/:id
 */
export async function getProject(req: Request, res: Response): Promise<void> {
  try {
    const id = req.params.id as string;
    if (!id) {
      res.status(400).json({ error: "Project ID is required" });
      return;
    }

    const project = await projectsService.getProjectById(id);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    res.json(project);
  } catch (error) {
    console.error("[projects.controller] getProject error:", error);
    res.status(500).json({ error: (error as Error).message });
  }
}

/**
 * DELETE /api/projects/:id
 */
export async function deleteProject(req: Request, res: Response): Promise<void> {
  try {
    const id = req.params.id as string;
    if (!id) { res.status(400).json({ error: "Project ID is required" }); return; }

    await projectsService.deleteProjectById(id);
    res.json({ success: true });
  } catch (error) {
    console.error("[projects.controller] deleteProject error:", error);
    res.status(500).json({ error: (error as Error).message });
  }
}

/**
 * PATCH /api/projects/:id
 * Body: { position: string }
 */
export async function updateProject(req: Request, res: Response): Promise<void> {
  try {
    const id = req.params.id as string;
    const { position } = req.body as { position?: string };

    if (!id) { res.status(400).json({ error: "Project ID is required" }); return; }
    if (!position?.trim()) { res.status(400).json({ error: "position is required" }); return; }

    const updated = await projectsService.updateProjectById(id, { position: position.trim() });
    res.json({ success: true, data: updated });
  } catch (error) {
    console.error("[projects.controller] updateProject error:", error);
    res.status(500).json({ error: (error as Error).message });
  }
}

/**
 * PUT /api/projects/:id/projects
 * Replaces the projects JSON on an existing record, saving the old content as a
 * versioned snapshot. Used by the regen flow.
 * Body: { projects: any[] }
 */
export async function replaceProjects(req: Request, res: Response): Promise<void> {
  try {
    const id = req.params.id as string;
    if (!id) { res.status(400).json({ error: "Project ID is required" }); return; }

    let userId: string;
    try {
      const clerkId = getCurrentUserId(req);
      const user = await prisma.user.findUnique({ where: { clerkId } });
      if (!user) { res.status(401).json({ error: "User not found" }); return; }
      userId = user.id;
    } catch {
      const bodyUserId = req.body?.userId as string | undefined;
      if (!bodyUserId) { res.status(401).json({ error: "Authentication required" }); return; }
      userId = bodyUserId;
    }

    const { projects } = req.body as { projects?: unknown[] };
    if (!Array.isArray(projects) || projects.length === 0) {
      res.status(400).json({ error: "projects must be a non-empty array" });
      return;
    }

    const updated = await projectsService.replaceProjectsWithVersion(id, userId, projects);
    res.json({ success: true, data: updated });
  } catch (error) {
    console.error("[projects.controller] replaceProjects error:", error);
    const ae = error as { statusCode?: number; message?: string };
    res.status(ae.statusCode ?? 500).json({ error: ae.message ?? (error as Error).message });
  }
}

/**
 * GET /api/projects/:id/versions
 * Lists all version snapshots for a project (newest first).
 */
export async function listProjectVersions(req: Request, res: Response): Promise<void> {
  try {
    const id = req.params.id as string;
    if (!id) { res.status(400).json({ error: "Project ID is required" }); return; }

    let userId: string;
    try {
      const clerkId = getCurrentUserId(req);
      const user = await prisma.user.findUnique({ where: { clerkId } });
      if (!user) { res.status(401).json({ error: "User not found" }); return; }
      userId = user.id;
    } catch {
      res.status(401).json({ error: "Authentication required" }); return;
    }

    const versions = await projectsService.getProjectVersions(id, userId);
    res.json({ success: true, data: versions });
  } catch (error) {
    console.error("[projects.controller] listProjectVersions error:", error);
    const ae = error as { statusCode?: number; message?: string };
    res.status(ae.statusCode ?? 500).json({ error: ae.message ?? (error as Error).message });
  }
}

/**
 * POST /api/projects/:id/versions/:versionId/rollback
 * Rolls the project back to the specified version snapshot.
 * The current content is snapshotted first so nothing is permanently lost.
 */
export async function rollbackProject(req: Request, res: Response): Promise<void> {
  try {
    const { id, versionId } = req.params as { id: string; versionId: string };
    if (!id || !versionId) { res.status(400).json({ error: "id and versionId are required" }); return; }

    let userId: string;
    try {
      const clerkId = getCurrentUserId(req);
      const user = await prisma.user.findUnique({ where: { clerkId } });
      if (!user) { res.status(401).json({ error: "User not found" }); return; }
      userId = user.id;
    } catch {
      res.status(401).json({ error: "Authentication required" }); return;
    }

    const updated = await projectsService.rollbackToVersion(id, versionId, userId);
    res.json({ success: true, data: updated });
  } catch (error) {
    console.error("[projects.controller] rollbackProject error:", error);
    const ae = error as { statusCode?: number; message?: string };
    res.status(ae.statusCode ?? 500).json({ error: ae.message ?? (error as Error).message });
  }
}

/**
 * POST /api/projects/:id/edit-component
 * Regenerates a single section of a project (1 credit).
 * Body: { userId, sectionKey, projectContext }
 */
export async function editProjectComponent(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const id = req.params.id as string;
    const { userId, sectionKey, projectContext } = req.body as {
      userId?: string;
      sectionKey?: string;
      projectContext?: string;
    };

    if (!userId)       { res.status(400).json({ error: "userId is required" }); return; }
    if (!sectionKey)   { res.status(400).json({ error: "sectionKey is required" }); return; }
    if (!projectContext) { res.status(400).json({ error: "projectContext is required" }); return; }

    const result = await projectsService.editProjectComponent(
      userId,
      id,
      sectionKey,
      projectContext,
    );

    res.json({ success: true, data: result });
  } catch (error) {
    const ae = error as AppError;
    const status = ae.statusCode ?? 500;
    console.error("[projects.controller] editProjectComponent error:", error);
    res.status(status).json({ error: (error as Error).message });
  }
}
