import { prisma } from "../../shared/lib/prisma";
import { MessageRole } from "@prisma/client";
import { Response } from "express";
import { OpenRouter } from "@openrouter/sdk";
import { AppError } from "../../shared/middleware/error.middleware";
import { AI_CONFIG } from "../../config/ai.config";
import { RagService } from "../ask-ai/rag.service";

// Valid OpenRouter model IDs (verified working)
const MODELS = {
  primary: "google/gemini-2.0-flash-001",
  fallbacks: [
    "openai/gpt-4o-mini",
    "anthropic/claude-3-haiku",
    "deepseek/deepseek-chat",
  ],
} as const;

// Map frontend model selector IDs → valid OpenRouter IDs
const MODEL_ID_MAP: Record<string, string> = {
  "auto": MODELS.primary,
  "google/gemini-flash-1.5": "google/gemini-2.0-flash-001",
  "google/gemini-2.0-flash-001": "google/gemini-2.0-flash-001",
  "openai/gpt-4o-mini": "openai/gpt-4o-mini",
  "anthropic/claude-haiku": "anthropic/claude-3-haiku",
  "anthropic/claude-3-haiku": "anthropic/claude-3-haiku",
  "anthropic/claude-3.5-sonnet": "anthropic/claude-3.5-sonnet",
  "deepseek/deepseek-chat": "deepseek/deepseek-chat",
  "deepseek/deepseek-v4-flash:free": "deepseek/deepseek-chat",
};

function buildSystemPrompt(contextText: string, directContext: string): string {
  const hasRAG = contextText.trim().length > 0;
  const hasDirect = directContext.trim().length > 0;
  const hasAnyContext = hasRAG || hasDirect;

  return `You are the ScribeShade AI Assistant — a secure, transcript-aware analytics engine. You operate exclusively over the authenticated user's own interview session data.

## YOUR IDENTITY & PURPOSE
You are NOT a general-purpose chatbot. You are a private analytics layer that reads, analyzes, and summarizes one user's interview sessions, transcripts, Q&A records, and detected topics. You do not have access to the internet, other users' data, or any knowledge outside what is provided in the CONTEXT sections below.

## CRITICAL BEHAVIORAL RULES

### Data Grounding
1. ALWAYS answer from the CONTEXT sections provided below — they contain the user's real session data.
2. NEVER say "I don't have access to your data" — you do. The data is in the CONTEXT below.
3. NEVER substitute internet knowledge or generic AI knowledge when session context exists.
4. NEVER fabricate session details, question text, or analytics figures.
5. If CONTEXT sections are empty, tell the user: "No session data is available yet. Please complete a ScribeShade interview session first, then ask again."
6. All data in CONTEXT belongs exclusively to this authenticated user — never reference or infer data from other users.

### Coding Restrictions
7. You are an analytics assistant, NOT a coding assistant. Treat all coding requests with strict limits:
   - ALLOW: Short code snippets (≤ 15 lines) to illustrate a concept mentioned in the transcript.
   - ALLOW: Brief conceptual explanations of a technology mentioned in the user's sessions.
   - DENY: Full project scaffolding, complete implementations, backend/frontend generation, large algorithms.
   - DENY: Any coding answer unrelated to a topic in the user's transcripts.
   - If a large code request is made, respond: "I'm a transcript analytics assistant. For full coding help, please use a dedicated coding tool. I can give you a brief conceptual overview of [topic] as it appeared in your sessions."

### Response Format
8. Use markdown: headers (##/###), bullet points, **bold** for key terms, tables for comparisons.
9. When referencing session data, cite it: "In your [Company] session on [date]..."
10. Be concise and data-driven. Every claim must trace back to the CONTEXT.

---

${hasAnyContext ? `## USER SESSION CONTEXT (Retrieved for this query only — not stored or shared)` : ""}

${hasRAG ? `### Semantic Search Results (Most Relevant Transcript Chunks)\n${contextText}` : ""}

${hasDirect ? `### Full Session Data (Sessions, Q&A Records, Transcripts)\n${directContext}` : ""}

${!hasAnyContext ? `## DATA STATUS\nNo session data is indexed yet for this user. Tell the user to complete a ScribeShade interview session first before asking analytics questions.` : ""}`;
}

export class AssistantService {
  private ragService: RagService;
  private ai: OpenRouter | null;

  constructor() {
    this.ragService = new RagService();
    this.ai = process.env.OPENROUTER_API_KEY
      ? new OpenRouter({ apiKey: process.env.OPENROUTER_API_KEY })
      : null;
  }

  async createChat(userId: string, title?: string) {
    return prisma.assistantChat.create({
      data: { userId, title: title ?? "New Chat" },
    });
  }

  async listChats(userId: string) {
    return prisma.assistantChat.findMany({
      where: { userId },
      orderBy: { updatedAt: "desc" },
      take: 50,
      select: {
        id: true,
        title: true,
        sessionId: true,
        createdAt: true,
        updatedAt: true,
        _count: { select: { messages: true } },
      },
    });
  }

  async renameChat(chatId: string, userId: string, title: string) {
    await this.assertOwnership(chatId, userId);
    return prisma.assistantChat.update({
      where: { id: chatId },
      data: { title, updatedAt: new Date() },
    });
  }

  async deleteChat(chatId: string, userId: string) {
    await this.assertOwnership(chatId, userId);
    return prisma.assistantChat.delete({ where: { id: chatId } });
  }

  async getMessages(chatId: string, userId: string) {
    await this.assertOwnership(chatId, userId);
    return prisma.assistantMessage.findMany({
      where: { chatId },
      orderBy: { createdAt: "asc" },
    });
  }

  async getUserSessions(userId: string) {
    return prisma.session.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: 50,
      select: {
        id: true,
        companyName: true,
        jobDescription: true,
        createdAt: true,
        status: true,
      },
    });
  }

  async setSessionScope(chatId: string, userId: string, sessionId: string | null) {
    await this.assertOwnership(chatId, userId);
    if (sessionId) {
      const session = await prisma.session.findFirst({
        where: { id: sessionId, userId },
        select: { id: true },
      });
      if (!session) throw new AppError(403, "Session not found or not owned by user");
    }
    return prisma.assistantChat.update({
      where: { id: chatId },
      data: { sessionId, updatedAt: new Date() },
    });
  }

  async sendMessage(
    chatId: string,
    userId: string,
    query: string,
    aiModel: string | undefined,
    res: Response,
  ) {
    if (!this.ai) throw new AppError(500, "AI service not configured");

    const chat = await this.assertOwnership(chatId, userId);

    // ── Layer 1: Vector RAG (TranscriptChunk embeddings) ─────────────────────
    let contextChunks: any[] = [];
    let contextText = "";
    try {
      if (chat.sessionId) {
        contextChunks = await this.ragService.retrieveContext(chat.sessionId, userId, query);
        if (contextChunks.length === 0) {
          console.log(`[AssistantService] No chunks for session ${chat.sessionId}, indexing now...`);
          await this.ragService.processSession(chat.sessionId, userId);
          contextChunks = await this.ragService.retrieveContext(chat.sessionId, userId, query);
        }
        // Enrich session-scoped chunks with companyName
        if (contextChunks.length > 0) {
          const sess = await prisma.session.findUnique({
            where: { id: chat.sessionId },
            select: { companyName: true },
          });
          if (sess?.companyName) {
            contextChunks = contextChunks.map((c) => ({ ...c, companyName: sess.companyName }));
          }
        }
      } else {
        contextChunks = await this.retrieveContextAcrossUser(userId, query);
        // If no chunks indexed at all, trigger background indexing of all sessions
        if (contextChunks.length === 0) {
          this.autoIndexUserSessions(userId).catch((e) =>
            console.warn("[AssistantService] Background indexing error:", e.message),
          );
        }
      }

      contextText = contextChunks
        .map((c, i) => {
          const session = c.sessionId ? ` [Session: ${c.sessionId.slice(0, 8)}]` : "";
          return `[Ref ${i + 1}${session}]\nQuestion: ${c.question}\nAnswer: ${c.aiAnswer}`;
        })
        .join("\n\n---\n\n");
    } catch (err) {
      console.warn("[AssistantService] RAG retrieval failed:", err);
    }

    // ── Layer 2: Direct DB context (always runs, supplements RAG) ─────────────
    const directContext = await this.buildDirectContext(userId, chat.sessionId ?? null);

    // ── Combine and build prompt ───────────────────────────────────────────────
    const systemPrompt = buildSystemPrompt(contextText, directContext);

    const historyMessages = await prisma.assistantMessage.findMany({
      where: { chatId },
      orderBy: { createdAt: "asc" },
      take: AI_CONFIG.limits.maxHistoryMessages,
    });

    const messages = [
      { role: "system", content: systemPrompt },
      ...historyMessages.map((m: { role: MessageRole; content: string }) => ({
        role: m.role === MessageRole.USER ? "user" : ("assistant" as const),
        content: m.content,
      })),
      { role: "user", content: query },
    ];

    await prisma.assistantMessage.create({
      data: { chatId, userId, role: MessageRole.USER, content: query },
    });

    await this.streamResponse(messages, chatId, userId, contextChunks, aiModel, res);

    await prisma.assistantChat.update({
      where: { id: chatId },
      data: { updatedAt: new Date() },
    });
  }

  /**
   * Builds direct DB context from sessions, QA records, and transcripts.
   * This is the fallback layer when embeddings haven't been indexed yet.
   */
  private async buildDirectContext(userId: string, sessionId: string | null): Promise<string> {
    const parts: string[] = [];

    try {
      // ── Sessions summary ──────────────────────────────────────────────────
      const sessions = await prisma.session.findMany({
        where: sessionId ? { id: sessionId, userId } : { userId },
        orderBy: { createdAt: "desc" },
        take: sessionId ? 1 : 10,
        select: {
          id: true,
          companyName: true,
          jobDescription: true,
          status: true,
          createdAt: true,
          durationSeconds: true,
          language: true,
          messages: true,
          transcript: true,
        },
      });

      if (sessions.length > 0) {
        parts.push(`### Sessions Overview (${sessions.length} session${sessions.length > 1 ? "s" : ""})`);
        for (const s of sessions) {
          parts.push(
            `- **Company:** ${s.companyName} | **Role:** ${(s.jobDescription || "").slice(0, 80)} | **Status:** ${s.status} | **Date:** ${s.createdAt.toISOString().split("T")[0]} | **Duration:** ${s.durationSeconds ? Math.round(s.durationSeconds / 60) + " min" : "N/A"}`,
          );

          // Extract transcript Q&A pairs directly from messages JSON
          const msgs = (s.messages as any[]) || [];
          const aiMessages = msgs.filter(
            (m: any) => ["assistant", "ai", "ai_assistant"].includes((m.role || "").toLowerCase()),
          );
          if (aiMessages.length > 0) {
            parts.push(`  **Transcript Q&A (${aiMessages.length} entries):**`);
            for (const m of aiMessages.slice(0, 8)) {
              const content = (m.content || m.answer || m.text || "").slice(0, 400);
              if (content) parts.push(`  > ${content}`);
            }
          }
        }
      }

      // ── QA records ────────────────────────────────────────────────────────
      const qaRecords = await prisma.qA.findMany({
        where: sessionId
          ? { sessionId, userId }
          : { userId },
        orderBy: { createdAt: "desc" },
        take: 30,
        select: {
          ques: true,
          answer: true,
          difficulty: true,
          industry: true,
          language: true,
          createdAt: true,
        },
      });

      if (qaRecords.length > 0) {
        parts.push(`\n### Q&A Records (${qaRecords.length} questions extracted)`);
        for (const qa of qaRecords) {
          parts.push(
            `**Q [${qa.difficulty}/${qa.industry}]:** ${qa.ques}\n**A:** ${(qa.answer || "No answer recorded").slice(0, 300)}`,
          );
        }
      }

      // ── Session notes / feedback ───────────────────────────────────────────
      if (sessionId) {
        const notes = await prisma.sessionNotes.findFirst({
          where: { sessionId },
          select: { companyName: true, jobDescription: true, summary: true, questions: true },
        });
        if (notes) {
          parts.push(`\n### Session Notes`);
          parts.push(`**Summary:** ${notes.summary}`);
          const qs = (notes.questions as any[]) || [];
          if (qs.length > 0) {
            parts.push(`**Questions covered:** ${qs.map((q: any) => q.question || q).join(" | ")}`);
          }
        }
      }
    } catch (err) {
      console.warn("[AssistantService] Direct context build failed:", err);
    }

    return parts.join("\n");
  }

  /**
   * Background-indexes all sessions for a user that have no TranscriptChunks yet.
   */
  private async autoIndexUserSessions(userId: string) {
    const sessions = await prisma.session.findMany({
      where: { userId },
      select: { id: true },
    });

    const indexedIds = await prisma.transcriptChunk
      .findMany({ where: { userId }, select: { sessionId: true }, distinct: ["sessionId"] })
      .then((rows) => new Set(rows.map((r) => r.sessionId)));

    const toIndex = sessions.filter((s) => !indexedIds.has(s.id));
    console.log(`[AssistantService] Auto-indexing ${toIndex.length} unindexed sessions for user ${userId}`);

    for (const s of toIndex) {
      try {
        await this.ragService.processSession(s.id, userId);
      } catch (e: any) {
        console.warn(`[AssistantService] Failed to index session ${s.id}:`, e.message);
      }
    }
  }

  private async retrieveContextAcrossUser(userId: string, query: string) {
    try {
      const { EmbeddingService } = await import("../ask-ai/embedding.service");
      const embeddingService = new EmbeddingService();
      const { embedding } = await embeddingService.generateEmbedding(query);
      const embeddingStr = `[${embedding.join(",")}]`;

      const results = await prisma.$queryRawUnsafe<any[]>(
        `SELECT
          tc.id, tc."sessionId", tc.question, tc."aiAnswer", tc.content, tc.technologies,
          s."companyName",
          (tc.embedding <=> $1::vector) as distance
        FROM "TranscriptChunk" tc
        LEFT JOIN "Session" s ON s.id = tc."sessionId"
        WHERE tc."userId" = $2
        ORDER BY distance ASC
        LIMIT $3`,
        embeddingStr,
        userId,
        AI_CONFIG.rag.topK,
      );

      // Relaxed threshold: 0.8 instead of 0.6 to cast wider net
      return results.filter((r) => r.distance < 0.8);
    } catch (err) {
      console.error("[AssistantService] Cross-user RAG failed:", err);
      return [];
    }
  }

  private async streamResponse(
    messages: any[],
    chatId: string,
    userId: string,
    contextChunks: any[],
    aiModel: string | undefined,
    res: Response,
  ) {
    // Resolve and validate model ID
    const resolvedModel = MODEL_ID_MAP[aiModel ?? "auto"] ?? MODELS.primary;
    const modelQueue = [resolvedModel, ...MODELS.fallbacks].filter(
      (v, i, a) => a.indexOf(v) === i,
    );

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    for (const model of modelQueue) {
      try {
        console.log(`[AssistantService] Trying model: ${model}`);
        const stream = await this.ai!.chat.send({
          chatRequest: { model, messages, stream: true },
        });

        let fullResponse = "";
        for await (const chunk of stream) {
          const content = chunk.choices[0]?.delta?.content || "";
          fullResponse += content;
          res.write(`data: ${JSON.stringify({ content })}\n\n`);
        }

        if (fullResponse.trim()) {
          await prisma.assistantMessage.create({
            data: {
              chatId,
              userId,
              role: MessageRole.ASSISTANT,
              content: fullResponse,
              citations: contextChunks.map((c) => ({
                id: c.id,
                question: c.question,
                sessionId: c.sessionId,
                companyName: c.companyName ?? null,
              })),
            },
          });
          res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
          res.end();
          return;
        }

        console.warn(`[AssistantService] Model ${model} returned empty response, trying next`);
      } catch (err: any) {
        console.warn(`[AssistantService] Model ${model} failed: ${err.message}`);
        if (model === modelQueue[modelQueue.length - 1]) {
          if (!res.headersSent) {
            res.write(`data: ${JSON.stringify({ error: "All AI models failed. Please try again shortly." })}\n\n`);
          }
          res.end();
          return;
        }
        // Continue to next model
      }
    }
  }

  private async assertOwnership(chatId: string, userId: string) {
    const chat = await prisma.assistantChat.findFirst({
      where: { id: chatId, userId },
    });
    if (!chat) throw new AppError(403, "Chat not found or access denied");
    return chat;
  }
}
