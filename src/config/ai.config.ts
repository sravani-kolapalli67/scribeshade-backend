export const AI_CONFIG = {
  models: {
    chat: {
      primary: "google/gemini-2.0-flash-001",
      fallback: "openai/gpt-4o-mini",
    },
    embeddings: {
      primary: "perplexity/pplx-embed-v1-4b",
      fallback: "perplexity/pplx-embed-v1-4b", // Keep same to avoid dimension mismatch (4096)
    }
  },
  rag: {
    chunkSize: 1000,
    overlap: 200,
    topK: 5,
  },
  limits: {
    maxHistoryMessages: 10,
    timeoutMs: 30000,
  }
};

export type AIModelType = typeof AI_CONFIG.models.chat.primary;
