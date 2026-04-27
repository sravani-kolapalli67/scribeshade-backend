import { Request, Response } from "express";
import path from "path";
import fs from "fs";
import * as projectsService from "./projects.service";
import * as resumeService from "../resume/resume.service";
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
    const { userId, resumeId, resumeText, position, jobDescription } =
      req.body as GenerateProjectRequest;

    if (!userId) {
      if (req.file) safeDeleteFile(req.file.path);
      res.status(400).json({ error: "userId is required" });
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

    if (!resumeId && !finalResumeText) {
      if (uploadedFilePath) safeDeleteFile(uploadedFilePath);
      res.status(400).json({
        error:
          "Either resumeId, resumeText, or a valid resume file is required",
      });
      return;
    }

    // Set headers for streaming
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Transfer-Encoding", "chunked");

    const params: GenerateProjectRequest = {
      userId,
      resumeId,
      resumeText: finalResumeText,
      position,
      jobDescription,
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

    // Background task: Save to DB
    setTimeout(async () => {
      try {
        if (allProjects.length > 0) {
          await projectsService.saveProjectBatch(
            userId,
            position,
            jobDescription,
            allProjects,
            resumeId,
          );
          console.log(
            `[projects.controller] Successfully saved batch of ${allProjects.length} projects for user ${userId}`,
          );
        } else {
          console.warn(
            "[projects.controller] No valid projects were generated to save",
          );
        }
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
    const { userId } = req.params;
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
    const { id } = req.params;
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
