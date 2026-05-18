import { prisma } from "../../shared/lib/prisma";
import { OpenRouter } from "@openrouter/sdk";
import { CreateSessionData } from "./session.types";
import * as qaService from "../qa/qa.service";
import sharp from "sharp";
import { Language, Industry, SessionStatus, DeductionReason, Prisma } from "@prisma/client";
import * as documentService from "../document/document.service";
import path from "path";
import { AppError } from "../../shared/middleware/error.middleware";
import * as creditsService from "../credits/credits.service";
import { creditDeductionQueue } from "../jobs/queue";
import { buildSystemMessage, buildUserMessage, buildScreenAnalysisMessage } from "../../shared/lib/prompt";
import {
  ANALYTICS_SYSTEM_PROMPT,
  buildAnalyticsUserPrompt,
} from "../../shared/prompts/analytics";

const ai = new OpenRouter({
  apiKey: process.env.OPENROUTER_API_KEY || "",
  httpReferer: "https://scribeshade.com",
  appTitle: "ScribeShade",
});

const model = process.env.OPENROUTER_MODEL;

/** Normalize human-readable model names sent by frontend to valid OpenRouter slugs */
const MODEL_ID_MAP: Record<string, string> = {
  "gemini 2.0 flash": "google/gemini-2.0-flash-001",
  "gemini 2.0 flash exp": "google/gemini-2.0-flash-exp:free",
  "gemini 1.5 flash": "google/gemini-flash-1.5",
  "gemini 1.5 pro": "google/gemini-pro-1.5",
  "gemini 3.1 flash lite": "google/gemini-3.1-flash-lite-preview",
  "gemini 3.1 pro": "google/gemini-3.1-pro-preview",
  "gpt-4o": "openai/gpt-4o",
  "gpt-4o mini": "openai/gpt-4o-mini",
  "gpt-5": "openai/gpt-5",
  "claude 3.5 sonnet": "anthropic/claude-3.5-sonnet",
  "claude 3 haiku": "anthropic/claude-3-haiku",
  "claude 4.6 sonnet": "anthropic/claude-sonnet-4.6",
  "claude haiku 4.5": "anthropic/claude-haiku-4-5",
};

function resolveModelId(id: string | undefined): string | undefined {
  if (!id) return id;
  const normalized = id.toLowerCase().trim();
  return MODEL_ID_MAP[normalized] ?? id;
}

/**
 * Maps a session language string to a Prisma Language enum value.
 */
function mapLanguage(lang: string): Language {
  const l = (lang || "").toLowerCase().trim();
  if (l.includes("javascript") || l === "js") return Language.JavaScript;
  if (l.includes("typescript") || l === "ts") return Language.TypeScript;
  if (l.includes("python") || l === "py") return Language.Python;
  if (l === "java") return Language.Java;
  if (l.includes("c++") || l === "cpp" || l.includes("plus plus"))
    return Language.C_Plus_Plus;
  if (l === "c") return Language.C;
  if (l.includes("c#") || l === "csharp" || l.includes("c sharp"))
    return Language.C_Sharp;
  if (l === "go" || l === "golang") return Language.Go;
  return Language.General;
}

/**
 * Maps a job description to a Prisma Industry enum value based on keywords.
 */
function mapIndustry(jobDesc: string): Industry {
  const j = (jobDesc || "").toLowerCase().trim();
  if (
    j.includes("frontend") ||
    j.includes("backend") ||
    j.includes("full stack") ||
    j.includes("fullstack") ||
    j.includes("react") ||
    j.includes("node") ||
    j.includes("web")
  )
    return Industry.Full_Stack;
  if (
    j.includes("data") ||
    j.includes("ml") ||
    j.includes("machine learning") ||
    j.includes("ai")
  )
    return Industry.Data_Science;
  if (
    j.includes("devops") ||
    j.includes("sre") ||
    j.includes("docker") ||
    j.includes("kubernetes") ||
    j.includes("infra")
  )
    return Industry.DevOps;
  if (
    j.includes("mobile") ||
    j.includes("ios") ||
    j.includes("android") ||
    j.includes("flutter")
  )
    return Industry.Mobile;
  if (
    j.includes("aws") ||
    j.includes("azure") ||
    j.includes("gcp") ||
    j.includes("cloud")
  )
    return Industry.Cloud;
  if (j.includes("architect") || j.includes("system design"))
    return Industry.System_Design;
  return Industry.DSA;
}

/**
 * Creates a new interview session.
 */
export async function createSession(data: CreateSessionData) {
  // ── Single-session enforcement ──────────────────────────────────────────────
  const openSession = await prisma.session.findFirst({
    where: {
      userId: data.userId,
      status: { in: [SessionStatus.ACTIVE, SessionStatus.PAUSED, SessionStatus.DISCONNECTED] },
    },
    select: { id: true, status: true },
  });
  if (openSession) {
    throw new AppError(409, `ACTIVE_SESSION_EXISTS:${openSession.id}`);
  }

  let finalCompanyId = "";

  if (data.companyName) {
    // Generate a basic slug
    let baseSlug = data.companyName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)+/g, "");
    if (!baseSlug) baseSlug = `company-${Date.now()}`;

    // Find or create the company
    let company = await prisma.company.findFirst({
      where: { name: { equals: data.companyName, mode: "insensitive" } },
    });

    if (!company) {
      // Ensure slug uniqueness simple fallback
      const existingSlug = await prisma.company.findUnique({
        where: { slug: baseSlug },
      });
      if (existingSlug) {
        baseSlug = `${baseSlug}-${Math.floor(Math.random() * 10000)}`;
      }

      company = await prisma.company.create({
        data: {
          name: data.companyName,
          slug: baseSlug,
        },
      });
    }

    finalCompanyId = company.id;
  }

  return prisma.session.create({
    data: {
      userId: data.userId,
      companyName: data.companyName || "",
      companyId: finalCompanyId,
      jobDescription: data.jobDescription || "",
      resumeId: data.resumeId || "",
      documentId: data.DocumentId || "",
      language: data.language || "",
      simpleLanguage: data.simpleLanguage,
      extraContext: data.extraContext || "",
      autoGenerateResponse: data.autoGenerateResponse,
      saveTranscription: data.saveTranscription,
      mode: data.mode,
      free: data.free,
      status: SessionStatus.PRE_CHECK,
      projectIds: data.projectIds && data.projectIds.length > 0 ? data.projectIds : [],
    },
  });
}

/**
 * Returns all sessions for a specific user with optional filters.
 */
export async function getSessionsByUser(
  userId: string,
  filters?: { search?: string; from_date?: string; to_date?: string },
) {
  const where: any = { userId };

  if (filters?.search) {
    where.companyName = { contains: filters.search, mode: "insensitive" };
  }

  if (filters?.from_date || filters?.to_date) {
    where.createdAt = {};
    if (filters.from_date) {
      where.createdAt.gte = new Date(filters.from_date);
    }
    if (filters.to_date) {
      const to = new Date(filters.to_date);
      to.setHours(23, 59, 59, 999);
      where.createdAt.lte = to;
    }
  }

  return prisma.session.findMany({
    where,
    include: { feedback: true },
    orderBy: { createdAt: "desc" },
  });
}

/**
 * Returns a specific session by ID.
 */
export async function getSessionById(id: string) {
  return prisma.session.findUnique({
    where: { id },
    include: { feedback: true },
  });
}

/**
 * Deletes a session by ID.
 * Only PRE_CHECK sessions can be deleted (never activated, no credits at risk).
 */
const DELETABLE_STATUSES: SessionStatus[] = [
  SessionStatus.PRE_CHECK,
  SessionStatus.COMPLETED,
  SessionStatus.ABANDONED,
  SessionStatus.FORCE_ENDED,
  SessionStatus.AUTO_ENDED,
  SessionStatus.CREDIT_EXHAUSTED,
  SessionStatus.DISCONNECTED,
];

export async function deleteSession(id: string) {
  const session = await prisma.session.findUnique({ where: { id } });
  if (!session) throw new AppError(404, "Session not found");
  if (!DELETABLE_STATUSES.includes(session.status)) {
    throw new AppError(409, "Cannot delete an active or in-progress session. End the session first.");
  }
  return prisma.session.delete({
    where: { id },
  });
}

/**
 * Activates a session (sets status to ACTIVE, computes credit cap, records start time).
 * Enforces single-active-session per user — throws 409 ACTIVE_SESSION_EXISTS if blocked.
 * Runs inside a $transaction for race-condition safety.
 */
export async function activateSession(
  id: string,
  settings?: { language?: string; simpleLanguage?: boolean },
) {
  // ── Pre-flight reads (outside transaction to avoid timeout) ─────────────────
  const session = await prisma.session.findUnique({ where: { id } });
  if (!session) throw new AppError(404, "Session not found");

  const hasLanguageOverride =
    typeof settings?.language === "string" &&
    settings.language.trim().length > 0 &&
    settings.language.trim() !== session.language;
  const hasSimpleLanguageOverride =
    typeof settings?.simpleLanguage === "boolean" &&
    settings.simpleLanguage !== session.simpleLanguage;

  const settingsUpdate: Prisma.SessionUpdateInput = {
    ...(hasLanguageOverride ? { language: settings!.language!.trim() } : {}),
    ...(hasSimpleLanguageOverride
      ? { simpleLanguage: settings!.simpleLanguage! }
      : {}),
  };

  // Idempotent — already ACTIVE (reconnect case)
  if (session.status === SessionStatus.ACTIVE) {
    if (Object.keys(settingsUpdate).length === 0) return session;
    return prisma.session.update({
      where: { id },
      data: settingsUpdate,
    });
  }

  // Allow DISCONNECTED → ACTIVE (reconnection within grace window)
  if (
    session.status !== SessionStatus.PRE_CHECK &&
    session.status !== SessionStatus.DISCONNECTED
  ) {
    throw new AppError(
      409,
      `Cannot activate session in status ${session.status}`,
    );
  }

  // Compute credit cap outside the transaction — this is a slow async call
  // that must not run inside an interactive tx due to the 5 s default timeout.
  let maxAllowedMinutes: number | null = null;
  let bracketConfigSnapshot: unknown = null;

  if (!session.free) {
    const balance = await prisma.userCreditBalance.findUnique({
      where: { userId: session.userId },
    });
    if (!balance) throw new AppError(402, "INSUFFICIENT_CREDITS");

    const available = new Prisma.Decimal(balance.totalAvailable.toString());
    const { maxMinutes, snapshot } =
      await creditsService.computeMaxAllowedMinutes(available);
    maxAllowedMinutes = maxMinutes;
    bracketConfigSnapshot = snapshot;
  }

  // ── Atomic state transition ─────────────────────────────────────────────────
  return prisma.$transaction(async (tx) => {
    // Re-read inside tx to guard against concurrent activations
    const current = await tx.session.findUnique({ where: { id } });
    if (!current) throw new AppError(404, "Session not found");

    // Re-check status — another request may have raced
    if (current.status === SessionStatus.ACTIVE) return current;
    if (
      current.status !== SessionStatus.PRE_CHECK &&
      current.status !== SessionStatus.DISCONNECTED
    ) {
      throw new AppError(
        409,
        `Cannot activate session in status ${current.status}`,
      );
    }

    // Single-session enforcement — atomic check inside tx
    const conflict = await tx.session.findFirst({
      where: {
        userId: current.userId,
        id: { not: id },
        status: {
          in: [
            SessionStatus.ACTIVE,
            SessionStatus.PAUSED,
            SessionStatus.DISCONNECTED,
          ],
        },
      },
      select: { id: true, status: true },
    });
    if (conflict) {
      throw new AppError(409, `ACTIVE_SESSION_EXISTS:${conflict.id}`);
    }

    const now = new Date();
    return tx.session.update({
      where: { id },
      data: {
        ...settingsUpdate,
        status: SessionStatus.ACTIVE,
        ...(current.status === SessionStatus.PRE_CHECK
          ? { startedAt: now }
          : {}),
        disconnectedAt: null,
        lastHeartbeatAt: now,
        creditsHeld: new Prisma.Decimal(0),
        maxAllowedMinutes,
        bracketConfigSnapshot: bracketConfigSnapshot as any,
      },
    });
  });
}

/**
 * Deactivates a session (sets status to COMPLETING, records end time, enqueues deduction job).
 */
export async function deactivateSession(
  id: string,
  aiUsage?: number | null,
  transcript?: string,
) {
  const usageCount =
    typeof aiUsage === "number" ? aiUsage : parseInt(aiUsage as any, 10);

  const { session, didTransition } = await prisma.$transaction(async (tx) => {
    const s = await tx.session.findUnique({ where: { id } });
    if (!s) throw new Error("Session not found");

    // Idempotency guard — already closed or in-flight
    if (
      s.status === SessionStatus.COMPLETED ||
      s.status === SessionStatus.COMPLETING ||
      s.status === SessionStatus.CREDIT_EXHAUSTED ||
      s.status === SessionStatus.FORCE_ENDED
    ) {
      return { session: s, didTransition: false };
    }

    if (
      s.status !== SessionStatus.ACTIVE &&
      s.status !== SessionStatus.PAUSED &&
      s.status !== SessionStatus.DISCONNECTED
    ) {
      throw new AppError(
        409,
        `Cannot deactivate session in status ${s.status}`,
      );
    }

    const updated = await tx.session.update({
      where: { id },
      data: {
        status: SessionStatus.COMPLETING,
        endedAt: new Date(),
        ...(!isNaN(usageCount) && usageCount > 0
          ? { aiUsage: { increment: usageCount } }
          : {}),
      },
    });
    return { session: updated, didTransition: true };
  });

  // Enqueue deduction job only when we actually transitioned to COMPLETING
  if (didTransition && session.status === SessionStatus.COMPLETING) {
    if (session.bracketConfigSnapshot) {
      await creditDeductionQueue.add("credit-deduction", {
        sessionId: id,
        userId: session.userId,
      });
    } else {
      // Free session — mark COMPLETED synchronously.
      // Clear both transcript and messages when the user opted out of saving.
      await prisma.session.update({
        where: { id },
        data: {
          status: SessionStatus.COMPLETED,
          ...(session.saveTranscription === false
            ? { transcript: [], messages: [] }
            : {}),
        },
      });
    }
  }

  return session;
}

/**
 * Abandons a stale ACTIVE or PAUSED session — called by session-watchdog when
 * no heartbeat was received. No credits are charged (watchdog uses DISCONNECTED →
 * AUTO_ENDED path instead for billing; ABANDONED is reserved for sessions that
 * never left PRE_CHECK or were force-abandoned).
 */
export async function abandonStaleSession(
  sessionId: string,
  _userId: string,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const session = await tx.session.findUnique({ where: { id: sessionId } });
    if (!session) return;

    // Only handle sessions that are still open
    if (
      session.status !== SessionStatus.ACTIVE &&
      session.status !== SessionStatus.PAUSED
    ) {
      return;
    }

    await tx.session.update({
      where: { id: sessionId },
      data: {
        status: SessionStatus.ABANDONED,
        endedAt: new Date(),
        creditsDeducted: new Prisma.Decimal(0),
        deductionReason: DeductionReason.ABANDONED,
        // Honour the user's transcript preference even on abandoned sessions.
        // Clear both transcript and messages to fully respect ephemeral mode.
        ...(session.saveTranscription === false
          ? { transcript: [], messages: [] }
          : {}),
      },
    });
  });

  console.log(`[watchdog] Session ${sessionId} abandoned — hold released, 0 credits charged.`);
}

/**
 * Force-closes a session as CREDIT_EXHAUSTED and enqueues a deduction job with the exhausted flag.
 * Called by the heartbeat endpoint or session watchdog.
 * @param sessionId Session UUID
 * @param dbUserId  Internal (DB) user UUID — not Clerk ID
 */
export async function creditExhaustionClose(
  sessionId: string,
  dbUserId: string,
) {
  await prisma.$transaction(async (tx) => {
    const s = await tx.session.findUnique({ where: { id: sessionId } });
    if (!s || s.status !== SessionStatus.ACTIVE) return;

    await tx.session.update({
      where: { id: sessionId },
      data: {
        status: SessionStatus.CREDIT_EXHAUSTED,
        endedAt: new Date(),
        creditExhaustedAt: new Date(),
      },
    });
  });

  // Notify frontend via SSE
  const { sseManager } = await import("../../shared/lib/sse");
  sseManager.notify(sessionId, "SESSION_CLOSED", {
    reason: "CREDIT_EXHAUSTED",
    sessionId,
  });

  await creditDeductionQueue.add("credit-deduction", {
    sessionId,
    userId: dbUserId,
    isExhausted: true,
  });
}

/**
 * Aggregates all available context for a session (JD, Resume, Documents, Instructions).
 */
export async function getSessionFullContext(sessionId: string, query?: string) {
  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    include: { company: true },
  });

  if (!session) return null;

  // 1. Fetch resumes: try the session's resumeId if valid, and also fetch all resumes for the user
  const resumes = await prisma.resume.findMany({
    where: { userId: session.userId },
    orderBy: { uploadedAt: "desc" },
    include: { atsAnalysis: true }
  }).catch((e) => { console.warn("Failed to fetch user resumes:", e); return []; });

  let resumeContextText = "";
  if (resumes.length > 0) {
    resumeContextText = resumes.map((r, idx) => {
      let rText = `━━━ RESUME ${idx + 1}: ${r.filename} (Uploaded: ${r.uploadedAt.toISOString().split("T")[0]}) ━━━\n${r.resumeContext || "No text parsed from this resume."}`;
      if (r.atsAnalysis) {
        const ats = r.atsAnalysis;
        rText += `\n\n[Resume ATS Analysis]:\nScore: ${ats.score}/100\nSummary: ${ats.summary}\nStrengths:\n${ats.strengths.map(s => `  • ${s}`).join("\n")}\nWeaknesses:\n${ats.weaknesses.map(w => `  • ${w}`).join("\n")}\nSuggestions:\n${ats.suggestions.map(sg => `  • ${sg}`).join("\n")}`;
      }
      if (r.parsedData) {
        try {
          rText += `\n\n[Parsed Skills & Metadata]:\n${JSON.stringify(r.parsedData, null, 2)}`;
        } catch { /* ignore */ }
      }
      return rText;
    }).join("\n\n════════════════════════════════════════\n\n");
  } else {
    resumeContextText = "No resume provided.";
  }

  // 2. Fetch documents: try both session.documentId (if any) and all documents of this user
  const documents = await prisma.document.findMany({
    where: { userId: session.userId },
    orderBy: { uploadedAt: "desc" }
  }).catch((e) => { console.warn("Failed to fetch user documents:", e); return []; });

  let documentText = "";
  if (documents.length > 0) {
    const docsTexts = [];
    for (const doc of documents) {
      try {
        const ext = path.extname(doc.path).toLowerCase();
        const text = await documentService.extractTextFromFile(doc.path, ext);
        if (text) {
          docsTexts.push(`━━━ DOCUMENT: ${doc.filename} (Uploaded: ${doc.uploadedAt.toISOString().split("T")[0]}) ━━━\n${text}`);
        }
      } catch (e) {
        console.warn(`Failed to extract text from document ${doc.filename}:`, e);
      }
    }
    documentText = docsTexts.join("\n\n════════════════════════════════════════\n\n");
  }
  if (!documentText) documentText = "None provided.";

  // 3. Fetch projects: try session.projectIds or all projects of this user
  const projectIds = Array.isArray(session.projectIds) ? (session.projectIds as string[]) : [];
  let projectRecords: any[] = [];
  if (projectIds.length > 0) {
    projectRecords = await prisma.project.findMany({
      where: { id: { in: projectIds } }
    }).catch((e) => { console.warn("Failed to fetch specific projects:", e); return []; });
  }
  
  if (projectRecords.length === 0) {
    projectRecords = await prisma.project.findMany({
      where: { userId: session.userId }
    }).catch((e) => { console.warn("Failed to fetch all user projects:", e); return []; });
  }

  // Serialize selected AI projects into a rich, readable context string.
  let projectsText = "";
  if (projectRecords.length > 0) {
    projectsText = projectRecords
      .map((pr) => {
        const items = Array.isArray(pr.projects) ? (pr.projects as any[]) : [];
        return items
          .map((p: any, idx: number) => {
            const header = p.projectHeader || {};
            const lines: string[] = [
              `━━━ PROJECT ${idx + 1}: ${header.title || "Untitled"} ━━━`,
              header.tagline ? `Tagline: ${header.tagline}` : "",
              header.domain ? `Domain: ${header.domain}` : "",
              header.role ? `Your Role: ${header.role}` : "",
              header.duration ? `Duration: ${header.duration}` : "",
              header.teamSize ? `Team: ${header.teamSize}` : "",
            ].filter(Boolean);

            const sections: any[] = Array.isArray(p.sections) ? p.sections : [];
            for (const sec of sections) {
              if (!sec?.type || !sec?.content) continue;
              const sectionTitle = `\n[${sec.title || sec.key}]`;

              switch (sec.type) {
                case "bullets":
                  if (Array.isArray(sec.content) && sec.content.length) {
                    lines.push(sectionTitle);
                    lines.push(...(sec.content as string[]).map((b) => `  • ${b}`));
                  }
                  break;

                case "narrative":
                  if (typeof sec.content === "string" && sec.content.trim()) {
                    lines.push(sectionTitle);
                    lines.push(`  ${sec.content.trim()}`);
                  }
                  break;

                case "how_to_explain": {
                  const h = sec.content as any;
                  lines.push(sectionTitle);
                  if (h?.elevatorPitch) lines.push(`  Elevator Pitch: ${h.elevatorPitch}`);
                  if (h?.detailedExplanation) lines.push(`  Detailed: ${h.detailedExplanation}`);
                  break;
                }

                case "thirty_second_summary": {
                  const t = sec.content as any;
                  lines.push(sectionTitle);
                  if (t?.hook) lines.push(`  Hook: ${t.hook}`);
                  if (Array.isArray(t?.mainPoints)) lines.push(...(t.mainPoints as string[]).map((pt: string) => `  • ${pt}`));
                  if (t?.closingLine) lines.push(`  Closing: ${t.closingLine}`);
                  break;
                }

                case "star_story": {
                  const s = sec.content as any;
                  lines.push(sectionTitle);
                  if (s?.situation) lines.push(`  Situation: ${s.situation}`);
                  if (s?.task) lines.push(`  Task: ${s.task}`);
                  if (s?.action) lines.push(`  Action: ${s.action}`);
                  if (s?.result) lines.push(`  Result: ${s.result}`);
                  break;
                }

                case "metrics":
                  if (Array.isArray(sec.content) && sec.content.length) {
                    lines.push(sectionTitle);
                    lines.push(...(sec.content as any[]).map((m) =>
                      `  • ${m.metric}: ${m.value}${m.description ? ` — ${m.description}` : ""}${m.before ? ` (before: ${m.before}, after: ${m.after || m.value})` : ""}`,
                    ));
                  }
                  break;

                case "tech_tags":
                  if (Array.isArray(sec.content) && sec.content.length) {
                    lines.push(sectionTitle);
                    lines.push(...(sec.content as any[]).map((cat) =>
                      `  ${cat.category}: ${(cat.tags || []).join(", ")}`,
                    ));
                  }
                  break;

                case "challenge_cards":
                  if (Array.isArray(sec.content) && sec.content.length) {
                    lines.push(sectionTitle);
                    lines.push(...(sec.content as any[]).map((c) =>
                      `  • Challenge: ${c.challenge} → Solution: ${c.solution}`,
                    ));
                  }
                  break;

                case "key_value_pairs":
                  if (Array.isArray(sec.content) && sec.content.length) {
                    lines.push(sectionTitle);
                    lines.push(...(sec.content as any[]).map((kv) => `  ${kv.key}: ${kv.value}`));
                  }
                  break;

                case "steps":
                  if (Array.isArray(sec.content) && sec.content.length) {
                    lines.push(sectionTitle);
                    lines.push(...(sec.content as any[]).map((s, i) => `  ${i + 1}. ${s.step}: ${s.description}`));
                  }
                  break;

                default:
                  break;
              }
            }
            return lines.join("\n");
          })
          .join("\n\n");
      })
      .join("\n\n════════════════════════════════════════\n\n");
  }

  // 4. Fetch recent Q&A history for conversation context.
  const messages = Array.isArray(session.messages)
    ? (session.messages as any[])
    : [];
  const qaMessages = messages
    .filter((m) => m.role === "AI_ASSISTANT" && m.question && m.answer)
    .slice(-8); // Keep last 8 answered Q&A pairs for follow-up context
  const recentHistory =
    qaMessages.length > 0
      ? qaMessages
          .map(
            (m, i) =>
              `Turn ${i + 1} (Interviewer asked):\n  Q: ${m.question.trim()}\n  A: ${m.answer.trim()}`,
          )
          .join("\n\n")
      : "";

  // 5. Fetch past sessions and user Q&As for historical context
  const pastSessions = await prisma.session.findMany({
    where: {
      userId: session.userId,
      id: { not: sessionId }
    },
    orderBy: { createdAt: "desc" },
    take: 3,
    select: {
      companyName: true,
      jobDescription: true,
      messages: true,
      createdAt: true
    }
  }).catch((e) => { console.warn("Failed to fetch past sessions:", e); return []; });

  let pastSessionsContext = "";
  if (pastSessions.length > 0) {
    pastSessionsContext = pastSessions.map((ps, idx) => {
      const msgs = Array.isArray(ps.messages) ? (ps.messages as any[]) : [];
      const qaPairs = msgs
        .filter(m => m.role === "AI_ASSISTANT" && m.question && m.answer)
        .slice(-2) // last 2 Q&As
        .map(m => `  Q: ${m.question.trim()}\n  A: ${m.answer.trim()}`)
        .join("\n\n");
      return `[Past Session ${idx + 1} at ${ps.companyName || "Unknown Company"} - ${ps.jobDescription || "General"} on ${ps.createdAt.toISOString().split("T")[0]}]:\n${qaPairs || "  No Q&As recorded."}`;
    }).join("\n\n---\n\n");
  }

  const userQAs = await prisma.qA.findMany({
    where: { userId: session.userId },
    orderBy: { createdAt: "desc" },
    take: 10,
    select: {
      ques: true,
      answer: true,
      difficulty: true,
      industry: true
    }
  }).catch((e) => { console.warn("Failed to fetch user QAs:", e); return []; });

  let pastQAsContext = "";
  if (userQAs.length > 0) {
    pastQAsContext = userQAs
      .map(qa => `  Q [${qa.difficulty}/${qa.industry}]: ${qa.ques}\n  A: ${qa.answer || "No answer recorded."}`)
      .join("\n\n");
  }

  let combinedPreviousContext = "";
  if (pastSessionsContext) {
    combinedPreviousContext += `━━━ PAST INTERVIEW SESSIONS ━━━\n${pastSessionsContext}\n\n`;
  }
  if (pastQAsContext) {
    combinedPreviousContext += `━━━ HISTORICAL Q&A ARCHIVE ━━━\n${pastQAsContext}`;
  }

  let historyAndPastContext = recentHistory || "No previous interactions in this session.";
  if (combinedPreviousContext) {
    historyAndPastContext += `\n\n════════════════════════════════════════\n${combinedPreviousContext}`;
  }

  // 6. Semantic RAG Search over all user transcript chunks
  let vectorContext = "";
  if (query) {
    try {
      const { RagService } = require("../ask-ai/rag.service");
      const ragService = new RagService();
      let chunks = await ragService.retrieveContext(sessionId, session.userId, query);
      
      // Fallback: If no relevant chunks found in the current session, retrieve from any of this user's sessions
      if ((!chunks || chunks.length === 0) && ragService.embeddingService) {
        const { embedding } = await ragService.embeddingService.generateEmbedding(query);
        const embeddingStr = `[${embedding.join(",")}]`;
        const { AI_CONFIG } = require("../../config/ai.config");
        
        const allUserChunks = await prisma.$queryRawUnsafe<any[]>(
          `SELECT 
            id, question, "aiAnswer", content, technologies,
            (embedding <=> $1::vector) as distance
          FROM "TranscriptChunk"
          WHERE "userId" = $2
          ORDER BY distance ASC
          LIMIT $3`,
          embeddingStr,
          session.userId,
          AI_CONFIG?.rag?.topK || 4
        ).catch(() => []);
        
        chunks = allUserChunks.filter((r: any) => r.distance < 0.6);
      }

      if (chunks && chunks.length > 0) {
        vectorContext = chunks
          .map((c: any, idx: number) => `[Semantic Chunk Ref ${idx + 1}]:\nQuestion: ${c.question}\nAnswer: ${c.aiAnswer}\nTranscript excerpt: ${c.content}`)
          .join("\n\n---\n\n");
      }
    } catch (e) {
      console.warn("Failed to fetch vector context:", e);
    }
  }

  return {
    company: session.company?.name || session.companyName || "Unknown",
    role: session.jobDescription || "Interviewee",
    language: session.language || "General",
    simpleLanguage: session.simpleLanguage,
    instructions: session.extraContext || "None",
    resume: resumeContextText,
    document: documentText,
    projects: projectsText || null,
    history: historyAndPastContext,
    vectorContext: vectorContext || null,
  };
}

/**
 * Shared helper to handle AI stream generation and post-processing (saving to DB).
 */
function processAIStream(
  result: any,
  session: any,
  sessionId: string,
  fallbackQuestion: string,
) {
  async function* streamGenerator() {
    let fullResponse = "";
    let lastYieldedLength = 0;

    for await (const item of result.getItemsStream()) {
      if (item.type === "message") {
        const textContent = item.content?.find(
          (c: any) => c.type === "output_text",
        );
        if (textContent && "text" in textContent) {
          const currentText = textContent.text;
          const delta = currentText.slice(
            Math.max(lastYieldedLength, fullResponse.length),
          );
          if (delta) {
            yield { text: delta };
            lastYieldedLength = currentText.length;
          }
          fullResponse = currentText;
        }
      }
    }

    // Post-processing: extract Q&A and persist (fire-and-forget)
    (async () => {
      try {
        const finalResponse = await result.getText();

        // Sentinel: model decided the input had no genuine new question.
        // Skip ALL persistence — no QA row, no message append, no card.
        if (/={3,}\s*NO_NEW_QUESTION\s*={3,}/i.test(finalResponse)) {
          return;
        }

        const questionMatch = finalResponse.match(
          /QUESTION:\*?\*?\s*([\s\S]*?)\s*\*?\*?ANSWER:/i,
        );
        const answerMatch = finalResponse.match(/ANSWER:\*?\*?\s*([\s\S]*)/i);
        const extractedQuestion =
          questionMatch?.[1]
            ?.trim()
            ?.replace(
              /^(\d+[\s.)-]+\s*|Question\s*\d+[:\s-]*|Q\d+[:\s-]*)/i,
              "",
            ) || fallbackQuestion;
        const extractedAnswer = answerMatch?.[1]?.trim() || finalResponse;

        if (extractedAnswer && session) {
          // Ephemeral sessions — skip all persistence (QA table + messages).
          // The user opted out of transcript saving; no data should outlive the session.
          if (session.saveTranscription !== false) {
            await qaService
              .createQA({
                userId: session.userId,
                sessionId,
                companyId: session.companyId,
                ques: extractedQuestion,
                answer: extractedAnswer,
                language: mapLanguage(session.language),
                industry: mapIndustry(session.jobDescription),
              })
              .catch((e) => console.error("Auto-save QA Error:", e));

            await appendMessage(
              sessionId,
              "AI_ASSISTANT",
              extractedQuestion,
              extractedAnswer,
            ).catch((e) => console.error("appendMessage Error:", e));
          }
        }
      } catch (e) {
        console.error("Post-processing Error:", e);
      }
    })();
  }
  return streamGenerator();
}

/**
 * Analyzes a provided screenshot within a session context.
 * Uses a single AI call — the model returns QUESTION + ANSWER in one response.
 */
export async function analyzeScreen(
  id: string,
  file: Express.Multer.File,
  aiModel?: string,
) {
  // Skip recompression if the frontend already sent a pre-compressed JPEG (<= 600 KB).
  // Otherwise apply sharp to enforce a safe size cap for the LLM vision API.
  const isPreCompressed = file.mimetype === "image/jpeg" && file.size <= 600 * 1024;
  const compressPromise = isPreCompressed
    ? Promise.resolve(file.buffer)
    : sharp(file.buffer)
      .resize({ width: 1024 })
      .jpeg({ quality: 65 })
      .toBuffer()
      .catch((err) => { console.error("Sharp compression error:", err); throw err; });

  // Run image compression, session fetch, and full context build in parallel.
  // Previously context was fetched sequentially after compression, adding 200-400 ms.
  const [compressed, session, context] = await Promise.all([
    compressPromise,
    prisma.session.findUnique({ where: { id }, include: { company: true } }),
    getSessionFullContext(id),
  ]);

  if (!session) {
    throw new Error("Session not found");
  }

  try {
    const targetModel = resolveModelId(aiModel) || model;
    const result = ai.callModel({
      model: targetModel,
      // Raised so multi-question screenshots (e.g. 10 numbered questions) are
      // never truncated mid-answer. Default OpenRouter cap is too low for the
      // QUESTION/ANSWER + ===NEXT_QUESTION=== block expansion.
      maxOutputTokens: 8000,
      input: [
        {
          role: "system",
          type: "message",
          content: buildSystemMessage(context),
        } as any,
        {
          role: "user",
          type: "message",
          content: [
            {
              type: "input_text",
              text: buildScreenAnalysisMessage(context),
            },
            {
              type: "input_image",
              detail: "auto",
              imageUrl: `data:image/jpeg;base64,${compressed.toString("base64")}`,
            },
          ] as any,
        },
      ],
    });

    return processAIStream(result, session, id, "(question from screenshot)");
  } catch (err: any) {
    console.error("OpenRouter Error (analyzeScreen):", err);
    if (err.status === 429 || err.statusCode === 429) {
      return (async function* () {
        yield {
          text: "AI is temporarily rate-limited. Please wait a moment and try again.",
        };
      })();
    }
    throw err;
  }
}

/**
 * Generates an AI answer based on a transcript and session context.
 * Uses a single AI call — the model returns QUESTION + ANSWER in one response.
 */
export async function getAIAnswer(
  id: string,
  transcript: string,
  isCustomQuery: boolean = false,
  isRegenerate: boolean = false,
  aiModel?: string,
) {
  const session = await prisma.session.findUnique({
    where: { id },
    include: { company: true },
  });

  if (!session) {
    throw new Error("Session not found");
  }

  const context = await getSessionFullContext(id, transcript);

  // For regenerate calls the user is explicitly asking to re-answer a specific
  // question. Strip conversation history from the context so RULE 8 (follow-up
  // detection) cannot misidentify the question as a follow-up to a recent
  // prior answer (e.g. regenerating "Explain the first line of the code" after
  // a Databricks question should NOT produce a Databricks answer).
  const contextForCall = isRegenerate
    ? { ...context, history: "No previous interactions in this session." }
    : context;

  try {
    const targetModel = resolveModelId(aiModel) || model;
    const result = ai.callModel({
      model: targetModel,
      // Raised to support multi-question transcripts without truncation.
      maxOutputTokens: 8000,
      input: [
        {
          role: "system",
          type: "message",
          content: buildSystemMessage(contextForCall),
        } as any,
        {
          role: "user",
          type: "message",
          content: buildUserMessage(transcript, isCustomQuery, isRegenerate, contextForCall),
        },
      ],
    });

    return processAIStream(
      result,
      session,
      id,
      isCustomQuery ? transcript : transcript.slice(0, 300),
    );
  } catch (err: any) {
    console.error("OpenRouter Streaming Error (getAIAnswer):", err);
    if (err.status === 429 || err.statusCode === 429) {
      return (async function* () {
        yield {
          text: "AI is temporarily rate-limited. Please wait a moment and try again.",
        };
      })();
    }
    throw err;
  }
}

/**
 * Transcribes audio (Placeholder - implementation logic needed or restored).
 */
export async function transcribe(file: Express.Multer.File) {
  // Logic to call transcription service (e.g., Deepgram/Sarvam)
  return { text: "Transcription placeholder (restored)" };
}

/**
 * Appends a message to the session's JSON messages array AND (when allowed) the Transcript array.
 * When `saveTranscription === false` the entire DB write is skipped — no messages, no transcript.
 * This prevents any data from accumulating for ephemeral sessions.
 */
export async function appendMessage(
  sessionId: string,
  role: "INTERVIEWER" | "AI_ASSISTANT" | "USER",
  question: string,
  answer: string,
  time?: string,
) {
  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    select: { messages: true, transcript: true, saveTranscription: true },
  });

  if (!session) throw new Error("Session not found");

  // Ephemeral session — user opted out of all persistence.
  // Skip both messages[] and transcript[] writes entirely.
  if (session.saveTranscription === false) return;

  const currentMessages = Array.isArray(session.messages)
    ? (session.messages as any[])
    : [];

  const currentTranscript = Array.isArray(session.transcript)
    ? (session.transcript as any[])
    : [];

  const newMessage = {
    role,
    question,
    answer,
    timestamp: new Date().toISOString(),
    time,
  };

  const transcriptEntry = {
    role,
    question,
    answer,
    content: answer ? `Q: ${question}\n\nA: ${answer}` : question,
    time:
      time ||
      new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    createdAt: new Date().toISOString(),
  };

  return prisma.session.update({
    where: { id: sessionId },
    data: {
      messages: [...currentMessages, newMessage],
      transcript: [...currentTranscript, transcriptEntry],
    },
  });
}

export async function saveTranscript(
  sessionId: string,
  role: string,
  content: string,
  time?: string,
  question?: string,
  answer?: string,
) {
  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    select: { transcript: true, saveTranscription: true },
  });

  if (!session) throw new Error("Session not found");

  // Honour the user's transcript preference — skip writing if opted out.
  if (session.saveTranscription === false) return;

  const currentTranscript = Array.isArray(session.transcript)
    ? (session.transcript as any[])
    : [];

  const transcriptEntry = {
    role,
    content,
    question,
    answer,
    time:
      time ||
      new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    createdAt: new Date().toISOString(),
  };

  return prisma.session.update({
    where: { id: sessionId },
    data: {
      transcript: [...currentTranscript, transcriptEntry],
    },
  });
}

/**
 * Generates and saves post-session analytics feedback using AI.
 * This analyzes the transcript, QA records, and session context (Resume/JD).
 * @param rawTranscript Optional transcript string provided directly
 */
export async function generateSessionFeedback(
  sessionId: string,
  rawTranscript?: string,
) {
  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    include: {
      questions: { orderBy: { createdAt: "asc" } },
      company: true,
    },
  });

  if (!session) throw new Error("Session not found");

  // Fetch Resume context if available
  let resumeContext = "";
  if (session.resumeId) {
    try {
      const resume = await prisma.resume.findUnique({
        where: { id: session.resumeId },
      });
      resumeContext = resume?.resumeContext || "";
    } catch (e) {
      console.warn("Failed to fetch resume context for analytics:", e);
    }
  }

  // Fetch Document context if available
  let documentContext = "";
  if (session.documentId) {
    try {
      const doc = await prisma.document.findUnique({
        where: { id: session.documentId },
      });
      if (doc) {
        const ext = path.extname(doc.path).toLowerCase();
        documentContext = await documentService.extractTextFromFile(
          doc.path,
          ext,
        );
      }
    } catch (e) {
      console.warn("Failed to fetch document context for analytics:", e);
    }
  }

  // Use provided rawTranscript or build it from the transcript JSON field
  let formattedTranscript = "";
  if (rawTranscript) {
    formattedTranscript = rawTranscript;
  } else {
    const transcriptArray = Array.isArray(session.transcript)
      ? (session.transcript as any[])
      : [];

    formattedTranscript = transcriptArray
      .map((t) => `[${t.time || t.createdAt}] ${t.role}: ${t.content}`)
      .join("\n");

    // Fallback: If transcripts table is empty, check extraContext
    if (!formattedTranscript && session.extraContext) {
      formattedTranscript = session.extraContext;
    }
  }

  const formattedQA = session.questions
    .map(
      (q, i) =>
        `Q${i + 1}: ${q.ques}\nA${i + 1}: ${q.answer || "No answer provided"}`,
    )
    .join("\n\n");

  const messagesArray = Array.isArray(session.messages)
    ? (session.messages as any[])
    : [];
  const formattedMessages = messagesArray
    .map(
      (m, i) =>
        `Message ${i + 1} (${m.role}) [${m.time || m.timestamp}]:\nQuestion: ${m.question}\nAI Suggested Answer: ${m.answer}`,
    )
    .join("\n\n");

  const userPrompt = buildAnalyticsUserPrompt({
    company: session.companyName || session.company?.name || "Unknown",
    role: session.jobDescription || "Not specified",
    language: session.language || "General",
    aiUsage: session.aiUsage || 0,
    resumeContext,
    documentContext: documentContext.substring(0, 5000),
    mode: session.mode,
    extraContext: session.extraContext || "None",
    transcript: formattedTranscript,
    qa: formattedQA,
    messages: formattedMessages,
  });

  try {
    const result = ai.callModel({
      model,
      input: [
        { role: "system", type: "message", content: ANALYTICS_SYSTEM_PROMPT },
        { role: "user", type: "message", content: userPrompt },
      ],
      text: {
        format: { type: "json_object" },
      },
    });

    const content = await result.getText();

    if (!content) throw new Error("No content received from AI");

    // Robust JSON extraction (handles markdown blocks if model still provides them)
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    const feedbackData = JSON.parse(jsonMatch ? jsonMatch[0] : content);

    // Upsert feedback
    return await prisma.sessionFeedback.upsert({
      where: { sessionId },
      create: {
        sessionId,
        score: feedbackData.score || 0,
        confidence: feedbackData.confidence || 0,
        sessionQuality: feedbackData.sessionQuality || "N/A",
        verdict: feedbackData.verdict || "N/A",
        communication: feedbackData.communication || 0,
        interactivity: feedbackData.interactivity || 0,
        technicalDepth: feedbackData.technicalDepth || 0,
        conciseness: feedbackData.conciseness || 0,
        avgResponseLen: feedbackData.avgResponseLen || 0,
        answeredCount: feedbackData.answeredCount || 0,
        aiAssistsCount: session.aiUsage || 0,
        avgResponseTime: feedbackData.avgResponseTime || 0,
        strengths: feedbackData.strengths || [],
        improvements: feedbackData.improvements || [],
        interviewerMood: feedbackData.interviewerMood || "N/A",
      },
      update: {
        score: feedbackData.score || 0,
        confidence: feedbackData.confidence || 0,
        sessionQuality: feedbackData.sessionQuality || "N/A",
        verdict: feedbackData.verdict || "N/A",
        communication: feedbackData.communication || 0,
        interactivity: feedbackData.interactivity || 0,
        technicalDepth: feedbackData.technicalDepth || 0,
        conciseness: feedbackData.conciseness || 0,
        avgResponseLen: feedbackData.avgResponseLen || 0,
        answeredCount: feedbackData.answeredCount || 0,
        aiAssistsCount: session.aiUsage || 0,
        avgResponseTime: feedbackData.avgResponseTime || 0,
        strengths: feedbackData.strengths || [],
        improvements: feedbackData.improvements || [],
        interviewerMood: feedbackData.interviewerMood || "N/A",
      },
    });
  } catch (error) {
    console.error("Error generating session feedback:", error);
    throw new Error("Failed to generate session feedback");
  }
}
