export const AI_CONFIG = {
  models: {
    chat: {
      primary: "deepseek/deepseek-v4-flash:free",
      fallback: "google/gemini-flash-1.5",
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
