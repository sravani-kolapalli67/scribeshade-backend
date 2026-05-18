import { prisma } from "../../shared/lib/prisma";
import { MessageRole } from "@prisma/client";

import { RagService } from "./rag.service";
import { AppError } from "../../shared/middleware/error.middleware";
import { OpenRouter } from "@openrouter/sdk";
import { Response } from "express";
import { AI_CONFIG } from "../../config/ai.config";

export class AskAiService {
  private ragService: RagService;
  private ai: OpenRouter | null;

  constructor() {
    this.ragService = new RagService();
    this.ai = process.env.OPENROUTER_API_KEY
      ? new OpenRouter({ apiKey: process.env.OPENROUTER_API_KEY })
      : null;
  }

  /**
   * Queries the AI assistant about the session context with RAG grounding.
   */
  async askQuestion(sessionId: string, userId: string, query: string, res: Response) {
    if (!this.ai) {
      return this.sendStructuredError(res, "AI service not configured", 500);
    }

    try {
      // 1. Vector RAG — retrieve then re-fetch after auto-indexing if empty
      let contextChunks = await this.ragService.retrieveContext(sessionId, userId, query);
      if (contextChunks.length === 0) {
        console.log(`[AskAiService] No chunks for session ${sessionId}, indexing now...`);
        await this.ragService.processSession(sessionId, userId);
        contextChunks = await this.ragService.retrieveContext(sessionId, userId, query);
      }

      const ragText = contextChunks
        .map((c, i) => `[Ref ${i + 1}]\nQ: ${c.question}\nA: ${c.aiAnswer}`)
        .join("\n\n---\n\n");

      // 2. Direct session data fallback (always runs — supplements RAG)
      const directContext = await this.buildDirectSessionContext(sessionId);

      const hasContext = ragText.trim().length > 0 || directContext.trim().length > 0;

      // 3. Build grounded system prompt
      const systemPrompt = `You are an interview analytics assistant. Your ONLY job is to analyze the interview data below and answer the user's question concisely.

STRICT RULES:
- DO NOT reproduce, copy, or quote large sections of the context data verbatim.
- DO NOT output the context as your answer.
- ANALYZE the data and produce a SHORT, structured answer using markdown.
- Use bullet points, bold key terms, and ## headers for sections.
- If asked about technologies: list only the technology names found in the Q&A data.
- If asked about weak answers: summarize which topics the user answered poorly.
- If the context is empty: say "No session data is available yet for this session."
- Keep answers concise. Maximum 400 words unless a detailed report is explicitly requested.

---
${hasContext ? `SESSION DATA:\n${ragText || ""}\n\n${directContext || ""}` : "No session data available."}
---`;

      const history = await prisma.askAiMessage.findMany({
        where: { sessionId, userId },
        orderBy: { createdAt: "asc" },
        take: AI_CONFIG.limits.maxHistoryMessages
      });

      const messages = [
        { role: "system", content: systemPrompt },
        ...history.map(m => ({ role: m.role.toLowerCase() as any, content: m.content })),
        { role: "user", content: query }
      ];


      // 3. Persist User Message
      await prisma.askAiMessage.create({
        data: { sessionId, userId, role: MessageRole.USER, content: query }
      });


      // 4. Stream Response with Fallback Logic
      await this.streamWithFallback(messages, sessionId, userId, contextChunks, res);

    } catch (error: any) {
      console.error("[AskAiService] Critical pipeline failure:", error.message);
      this.sendStructuredError(res, "Assistant processing failed", 500);
    }
  }

  private async streamWithFallback(
    messages: any[], 
    sessionId: string, 
    userId: string, 
    contextChunks: any[], 
    res: Response
  ) {
    const models = [
      AI_CONFIG.models.chat.primary,
      AI_CONFIG.models.chat.fallback
    ];

    for (const model of models) {
      try {
        console.log(`[AskAiService] Streaming with model: ${model}`);
        const stream = await this.ai!.chat.send({
          chatRequest: {
            model,
            messages,
            stream: true,
          },
        });

        // Setup SSE headers
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");

        let fullResponse = "";

        for await (const chunk of stream) {
          const content = chunk.choices[0]?.delta?.content || "";
          fullResponse += content;
          res.write(`data: ${JSON.stringify({ content })}\n\n`);
        }

        // Save Assistant Response
        await prisma.askAiMessage.create({
          data: {
            sessionId,
            userId,
            role: MessageRole.ASSISTANT,
            content: fullResponse,
            citations: contextChunks.map(c => ({ id: c.id, question: c.question }))
          }
        });


        res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
        res.end();
        return; // Success!

      } catch (err: any) {
        console.warn(`[AskAiService] Model ${model} failed:`, err.message);
        if (model === models[models.length - 1]) {
          throw err; // Last fallback failed
        }
        // Otherwise continue to next model
      }
    }
  }

  private sendStructuredError(res: Response, message: string, statusCode: number) {
    if (!res.headersSent) {
      res.status(statusCode).json({
        success: false,
        error: message,
        provider: "OpenRouter"
      });
    } else {
      res.write(`data: ${JSON.stringify({ error: message })}\n\n`);
      res.end();
    }
  }

  async getChatHistory(sessionId: string, userId: string) {
    const messages = await prisma.askAiMessage.findMany({
      where: { sessionId, userId },
      orderBy: { createdAt: "asc" }
    });

    return messages.map(m => ({
      id: m.id,
      role: m.role.toLowerCase() as "user" | "assistant",
      content: m.content,
      citations: m.citations,
      timestamp: m.createdAt,
    }));
  }

  async clearChat(sessionId: string, userId: string) {
    await prisma.askAiMessage.deleteMany({
      where: { sessionId, userId }
    });
  }

  async indexSession(sessionId: string, userId: string) {
    return this.ragService.processSession(sessionId, userId);
  }

  /**
   * Builds direct DB context from session messages + QA records.
   * Used as fallback when embeddings haven't been indexed yet.
   */
  private async buildDirectSessionContext(sessionId: string): Promise<string> {
    const parts: string[] = [];
    try {
      const session = await prisma.session.findUnique({
        where: { id: sessionId },
        select: {
          companyName: true,
          status: true,
          durationSeconds: true,
          createdAt: true,
        },
      });

      if (session) {
        parts.push(
          `Session: ${session.companyName} | Status: ${session.status} | Duration: ${session.durationSeconds ? Math.round(session.durationSeconds / 60) + " min" : "N/A"} | Date: ${session.createdAt.toISOString().split("T")[0]}`,
        );
      }

      const qaRecords = await prisma.qA.findMany({
        where: { sessionId },
        orderBy: { createdAt: "desc" },
        take: 20,
        select: { ques: true, answer: true, difficulty: true, industry: true },
      });

      if (qaRecords.length > 0) {
        parts.push(`\n### Q&A Records (${qaRecords.length})`);
        for (const qa of qaRecords) {
          parts.push(
            `**[${qa.difficulty}/${qa.industry}]** ${qa.ques}\n→ ${(qa.answer || "No answer recorded").slice(0, 300)}`,
          );
        }
      }

      const notes = await prisma.sessionNotes.findFirst({
        where: { sessionId },
        select: { summary: true, questions: true },
      });
      if (notes?.summary) {
        parts.push(`\n### Session Notes Summary\n${notes.summary}`);
        const qs = (notes.questions as any[]) || [];
        if (qs.length > 0) {
          parts.push(`**Topics covered:** ${qs.map((q: any) => q.question || q).join(" | ")}`);
        }
      }
    } catch (err) {
      console.warn("[AskAiService] Direct context build failed:", err);
    }
    return parts.join("\n");
  }
}
