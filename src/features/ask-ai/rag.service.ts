import { prisma } from "../../shared/lib/prisma";
import { AppError } from "../../shared/middleware/error.middleware";
import { extractSkillsFromText } from "../ai/ai.service";
import { EmbeddingService } from "./embedding.service";
import { AI_CONFIG } from "../../config/ai.config";

/**
 * Service to handle RAG (Retrieval-Augmented Generation) operations:
 * - Transcript segmentation and chunking by question
 * - Vector embedding generation via EmbeddingService
 * - Contextual retrieval with semantic similarity
 */
export class RagService {
  private embeddingService: EmbeddingService;

  constructor() {
    this.embeddingService = new EmbeddingService();
  }

  /**
   * Processes a session transcript: segments into blocks based on questions.
   */
  async processSession(sessionId: string, userId: string) {
    const session = await prisma.session.findUnique({
      where: { id: sessionId },
      select: { transcript: true }
    });

    if (!session) throw new AppError(404, "Session not found");

    // Clear existing chunks for this session
    await prisma.transcriptChunk.deleteMany({
      where: { sessionId }
    });

    const transcript = session.transcript as any[] || [];
    const chunksToProcess: any[] = [];

    // 1. Segment Transcript into Question/Answer blocks
    for (let i = 0; i < transcript.length; i++) {
      const msg = transcript[i];
      const role = (msg.role || "").toLowerCase();
      if (role !== "assistant" && role !== "ai" && role !== "ai_assistant") continue;


      const content = msg.content || "";
      const segments = this.segmentContent(content);

      for (const segment of segments) {
        const { question, answer } = this.parseSegment(segment);
        if (!question && !answer) continue;

        chunksToProcess.push({
          sessionId,
          userId,
          questionId: `${i}-${chunksToProcess.length}`,
          question,
          aiAnswer: answer,
          content: `Question: ${question}\nAI Answer: ${answer}`,
          technologies: extractSkillsFromText(`${question} ${answer}`),
          difficulty: "Medium",
          speakerType: "assistant",
          chunkOrder: chunksToProcess.length,
          isQuestion: true,
          chunkType: "question"
        });


      }
    }

    if (chunksToProcess.length === 0) return { processedChunks: 0 };

    // 2. Generate Embeddings and Save to pgvector
    console.log(`[RagService] Generating embeddings for ${chunksToProcess.length} chunks...`);
    
    for (const chunk of chunksToProcess) {
      try {
        const { embedding } = await this.embeddingService.generateEmbedding(chunk.content);
        
        await prisma.$executeRawUnsafe(
          `INSERT INTO "TranscriptChunk" (
            id, "sessionId", "userId", "questionId", question, "aiAnswer", content, technologies, difficulty, "speakerType", embedding, "createdAt",
            "chunkOrder", "isQuestion", "chunkType"
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::"SpeakerType", $11::vector, NOW(),
            $12, $13, $14::"ChunkType"
          )`,

          crypto.randomUUID(),
          chunk.sessionId,
          chunk.userId,
          chunk.questionId,
          chunk.question,
          chunk.aiAnswer,
          chunk.content,
          chunk.technologies,
          chunk.difficulty,
          chunk.speakerType,
          `[${embedding.join(",")}]`,
          chunk.chunkOrder,
          chunk.isQuestion,
          chunk.chunkType
        );

      } catch (err) {
        console.error(`[RagService] Failed to index chunk ${chunk.questionId}:`, err);
        // Continue with other chunks
      }
    }

    return { processedChunks: chunksToProcess.length };
  }

  /**
   * Retrieves top-K relevant chunks based on semantic similarity
   */
  async retrieveContext(sessionId: string, userId: string, query: string) {
    try {
      const { embedding } = await this.embeddingService.generateEmbedding(query);
      const embeddingStr = `[${embedding.join(",")}]`;

      // Semantic search using cosine distance via pgvector (<=> operator)
      const results = await prisma.$queryRawUnsafe<any[]>(
        `SELECT 
          id, question, "aiAnswer", content, technologies,
          (embedding <=> $1::vector) as distance
        FROM "TranscriptChunk"
        WHERE "sessionId" = $2 AND "userId" = $3
        ORDER BY distance ASC
        LIMIT $4`,
        embeddingStr,
        sessionId,
        userId,
        AI_CONFIG.rag.topK
      );

      // Filter out low relevance results (distance threshold)
      return results.filter(r => r.distance < 0.6); 
    } catch (err) {
      console.error("[RagService] Context retrieval failed:", err);
      return [];
    }
  }

  private segmentContent(content: string): string[] {
    // Use a capturing group to keep the delimiter in the result, then merge them
    const splitRegex = /((?:\n|^)(?:===NEXT_QUESTION===|\*\*?Extracted Question:|\*\*?QUESTION:|\*\*?Question \d+:))/i;
    const parts = content.split(splitRegex);
    const segments: string[] = [];
    
    // parts will be [pre, delim, post, delim, post, ...]
    for (let i = 1; i < parts.length; i += 2) {
      segments.push((parts[i] + (parts[i+1] || "")).trim());
    }
    
    // Fallback if no delimiters found but content is long
    if (segments.length === 0 && content.trim().length > 20) {
      segments.push(content.trim());
    }
    
    return segments.filter(s => s.length > 10);
  }


  private parseSegment(segment: string): { question: string; answer: string } {
    const cleanSeg = segment.replace(/===NEXT_QUESTION===/g, "").trim();
    let question = "";
    let answer = "";

    const qLabelRegex = /(?:\*\*|###)?\s*(?:Extracted Question|QUESTION|Question \d+)\s*:\s*/i;
    const aLabelRegex = /(?:\n|^)(?:\*\*|###)?\s*(?:Suggested Answer|ANSWER|Answer \d+|A)\s*:\s*/i;

    const qMatch = qLabelRegex.exec(cleanSeg);
    if (qMatch) {
      const qStart = qMatch.index + qMatch[0].length;
      const aMatch = aLabelRegex.exec(cleanSeg);
      if (aMatch) {
        question = cleanSeg.slice(qStart, aMatch.index).trim();
        answer = cleanSeg.slice(aMatch.index + aMatch[0].length).trim();
      } else {
        // Look for newline as fallback answer separator
        const lines = cleanSeg.slice(qStart).split("\n").filter(l => l.trim());
        if (lines.length >= 2) {
          question = lines[0].trim();
          answer = lines.slice(1).join("\n").trim();
        } else {
          question = cleanSeg.slice(qStart).trim();
          answer = "";
        }
      }
    } else {
      // No explicit Q: label, treat first line as question if it looks like one
      const lines = cleanSeg.split("\n").filter(l => l.trim());
      if (lines.length >= 2) {
        question = lines[0].trim();
        answer = lines.slice(1).join("\n").trim();
      } else {
        answer = cleanSeg;
      }
    }

    return { 
      question: question.replace(/[*#_]+$|^[*#_]+/g, "").trim(), 
      answer: answer.replace(/[*#_]+$|^[*#_]+/g, "").trim() 
    };
  }

}
