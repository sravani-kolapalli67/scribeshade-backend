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
      // 1. Retrieve Relevant Context
      const contextChunks = await this.ragService.retrieveContext(sessionId, userId, query);
      
      if (contextChunks.length === 0) {
        // Auto-index if no context found
        await this.ragService.processSession(sessionId, userId);
      }

      const contextText = contextChunks
        .map((c, i) => `[Ref ${i+1}]\nQuestion: ${c.question}\nAI Answer: ${c.aiAnswer}\n`)
        .join("\n---\n");

      // 2. Build AI Context
      const systemPrompt = `You are a professional Interview Intelligence Copilot.
Your goal is to help the user review their interview performance based ONLY on the provided session context.

Rules:
1. Answer strictly based on the provided Context.
2. If the information is not in the context, say "I don't have enough information from this session to answer that."
3. Be concise, technical, and professional.
4. Refer to specific questions using the [Ref N] labels.
5. Format your response with markdown for readability.

Context:
${contextText || "No session data indexed yet."}
`;

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
      role: m.role,
      content: m.content,
      citations: m.citations
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
}
