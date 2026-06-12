import { AI_CONFIG } from "../../../config/ai.config";
import { EmbeddingService } from "../../ask-ai/embedding.service";
import type { RoutedAnswerContext } from "../session-intelligence.types";
import {
  readQuestionVector,
  searchMemoryDocuments,
} from "./redis-vector-store.service";
import { hashRagQuestion, normalizeRagQuestion } from "./session-rag-indexer.service";

export type SessionRagRetrievalResult = {
  evidence: string[];
  count: number;
  latencyMs: number;
  skipReason?: "no_query_vector" | "no_allowed_types" | "no_matches";
};

export async function retrieveSessionSupportingEvidence(input: {
  sessionId: string;
  userId: string;
  question: string;
  route: RoutedAnswerContext;
}): Promise<SessionRagRetrievalResult> {
  const startedAt = Date.now();
  if (input.route.retrieveTypes.length === 0) {
    return {
      evidence: [],
      count: 0,
      latencyMs: Date.now() - startedAt,
      skipReason: "no_allowed_types",
    };
  }

  // Try to read a pre-indexed question vector. If missing (async race, or question
  // came from the candidate side not the interviewer), generate on-demand so the
  // RAG search always runs rather than silently returning no evidence.
  let queryEmbedding = await readQuestionVector({
    sessionId: input.sessionId,
    questionHash: hashRagQuestion(input.question),
  });
  if (!queryEmbedding) {
    try {
      const embeddingService = new EmbeddingService();
      const result = await embeddingService.generateEmbedding(
        normalizeRagQuestion(input.question),
      );
      queryEmbedding = result.embedding;
    } catch {
      return {
        evidence: [],
        count: 0,
        latencyMs: Date.now() - startedAt,
        skipReason: "no_query_vector",
      };
    }
  }
  const matches = await searchMemoryDocuments({
    sessionId: input.sessionId,
    userId: input.userId,
    queryEmbedding,
    includeTypes: input.route.retrieveTypes,
    topicFilters: input.route.topicFilters,
    trustFilter: input.route.trustFilter,
    limit: AI_CONFIG.rag.topK,
  });
  return {
    evidence: matches.map(
      ({ document }) =>
        `[${document.type}; trust=${document.trust}; topic=${document.topic || "general"}] ${document.text}`,
    ),
    count: matches.length,
    latencyMs: Date.now() - startedAt,
    ...(matches.length === 0 ? { skipReason: "no_matches" as const } : {}),
  };
}
