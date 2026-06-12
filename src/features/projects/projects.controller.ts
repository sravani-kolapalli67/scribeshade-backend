import { Request, Response } from "express";
import path from "path";
import fs from "fs";
import * as projectsService from "./projects.service";
import * as resumeService from "../resume/resume.service";
import { getCurrentUserId } from "../auth/auth.middleware";
import { prisma } from "../../shared/lib/prisma";
import { AppError } from "../../shared/middleware/error.middleware";
import { GenerateProjectRequest } from "./projects.types";
import { exportProjectsToPdf } from "./projects.pdf.service";

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
  const reqStart = Date.now();
  let uploadedFilePath: string | undefined;

  try {
    const { resumeId, resumeText, position, jobDescription, industry, experienceLevel, generationMode } =
      req.body as Omit<GenerateProjectRequest, "userId">;
    const persistGeneratedRecord =
      (req.body as { persistGeneratedRecord?: unknown }).persistGeneratedRecord;
    const shouldPersistGeneratedRecord =
      persistGeneratedRecord !== false && persistGeneratedRecord !== "false";

    console.log(`\n[projects.controller] ══════════ NEW GENERATION REQUEST ══════════`);
    console.log(`[projects.controller]   position="${position}" mode=${generationMode || "new"} industry=${industry || "n/a"} exp=${experienceLevel || "n/a"} persist=${shouldPersistGeneratedRecord}`);
    console.log(`[projects.controller]   resumeId=${resumeId || "none"} hasResumeText=${!!resumeText} hasFile=${!!req.file}`);

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
    console.log(`[projects.controller]   Checking credit balance…`);
    try {
      await projectsService.checkGenerationCreditBalance(userId);
    } catch (creditErr) {
      if (req.file) safeDeleteFile(req.file.path);
      const ae = creditErr as AppError;
      console.warn(`[projects.controller]   Credit check FAILED: ${ae.message}`);
      res.status(ae.statusCode ?? 402).json({ error: ae.message ?? "Insufficient credits" });
      return;
    }

    console.log(`[projects.controller]   Credit check OK`);

    let finalResumeText = resumeText || "";

    // If a file was uploaded, extract its text
    if (req.file) {
      uploadedFilePath = req.file.path;
      const ext = path.extname(req.file.originalname).toLowerCase();
      console.log(`[projects.controller]   Extracting text from uploaded file (${ext})…`);
      try {
        const extracted = await resumeService.extractTextFromFile(
          uploadedFilePath,
          ext,
        );
        if (extracted) {
          finalResumeText = extracted;
          console.log(`[projects.controller]   File extraction OK — ${extracted.length} chars`);
        }
      } catch (err) {
        console.error("[projects.controller] Text extraction failed:", err);
        // We continue if resumeId or resumeText was also provided,
        // but if this was the only source, it might fail later.
      }
    }

    // Resume is optional — generation can proceed with just position + JD
    // Set headers for streaming
    console.log(`[projects.controller]   Streaming headers set — handing off to orchestrator…`);
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

            // Parse/repair first, then stream canonical JSON. The backend parser
            // is more tolerant than the frontend; streaming raw model text can
            // make the frontend report "No projects returned" even when DB save
            // succeeds after repair.
            const parsedProject =
              projectsService.parseJsonResponse<any>(cleanProject);
            if (parsedProject) {
              const title = parsedProject?.projectHeader?.title ?? "(unknown)";
              const expectedCount = projectsService.getProjectsPerRequest();
              res.write(JSON.stringify(parsedProject) + DELIMITER);
              console.log(`[projects.controller]   ✓ Streamed project ${allProjects.length + 1}/${expectedCount}: "${title}" (+${Date.now() - reqStart}ms)`);
              allProjects.push(parsedProject);
            } else {
              console.warn(`[projects.controller]   ⚠ JSON parse+repair failed (${cleanProject.length} chars) — preview: ${cleanProject.slice(0, 200)}`);
            }
          }
        }
      }

      // Deduct credits + save to DB before ending the response so the client's
      // immediate list refresh sees the new record. All project chunks have
      // already been written via res.write(); res.end() is the only thing left.
      if (allProjects.length === 0) {
        console.warn(
          `[projects.controller]   No valid projects parsed — skipping credit deduction and DB save (${Date.now() - reqStart}ms)`,
        );
      } else {
        console.log(`[projects.controller]   Deducting credits for userId=${userId.slice(0, 8)}…`);
        try {
          await projectsService.deductGenerationCredits(userId);
          console.log(`[projects.controller]   Credits deducted OK`);
        } catch (creditErr) {
          console.error(
            "[projects.controller]   Credit deduction failed after successful generation:",
            creditErr,
          );
          // Generation already streamed; log and continue to save.
        }

        if (shouldPersistGeneratedRecord) {
          console.log(`[projects.controller]   Saving batch of ${allProjects.length} projects to DB…`);
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
              `[projects.controller]   DB save OK — ${allProjects.length} projects persisted (+${Date.now() - reqStart}ms total)`,
            );
          } catch (saveErr) {
            console.error(
              "[projects.controller]   Failed to save project batch:",
              saveErr,
            );
          }
        } else {
          console.log(
            `[projects.controller]   DB save skipped by request — streamed ${allProjects.length} project(s) for replacement (+${Date.now() - reqStart}ms total)`,
          );
        }
      }
    } finally {
      res.end();
      console.log(`[projects.controller] Response ended (${Date.now() - reqStart}ms total)\n`);
      if (uploadedFilePath) safeDeleteFile(uploadedFilePath);
    }
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
 * GET /api/projects/mine
 * Lists projects for the authenticated user — resolves identity via Bearer token.
 */
export async function listMyProjects(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const clerkId = getCurrentUserId(req);
    const user = await prisma.user.findUnique({ where: { clerkId } });
    if (!user) {
      res.status(401).json({ error: "User not found — please sign in again" });
      return;
    }
    const projects = await projectsService.getProjectsByUser(user.id);
    res.json(projects);
  } catch (error) {
    console.error("[projects.controller] listMyProjects error:", error);
    res.status(500).json({ error: (error as Error).message });
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

/**
 * GET /api/projects/:id/export-pdf
 */
export async function exportProjectPdf(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const clerkId = getCurrentUserId(req);
    if (!clerkId) { res.status(401).json({ error: "Unauthorized" }); return; }

    const user = await prisma.user.findUnique({ where: { clerkId } });
    if (!user) { res.status(404).json({ error: "User not found" }); return; }

    const { id } = req.params;
    const { buffer, filename } = await exportProjectsToPdf(id as string, user.id);

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Content-Length", buffer.length);
    res.end(buffer);
  } catch (error) {
    const ae = error as AppError;
    const status = ae.statusCode ?? 500;
    console.error("[projects.controller] exportProjectPdf error:", error);
    res.status(status).json({ error: (error as Error).message });
  }
}
