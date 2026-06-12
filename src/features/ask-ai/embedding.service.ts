import { AI_CONFIG } from "../../config/ai.config";
import { AppError } from "../../shared/middleware/error.middleware";

export interface EmbeddingResult {
  embedding: number[];
  model: string;
  dimensions: number;
}

export class EmbeddingService {
  private apiKey: string;

  constructor() {
    this.apiKey = process.env.OPENROUTER_API_KEY || "";
    if (!this.apiKey) {
      console.warn("[EmbeddingService] OPENROUTER_API_KEY missing");
    }
  }

  /**
   * Generates embeddings for a given text with retry and fallback logic.
   */
  async generateEmbedding(text: string): Promise<EmbeddingResult> {
    if (!this.apiKey) throw new AppError(500, "AI service not configured");

    const cleanText = text.replace(/\n/g, " ").trim();
    
    try {
      return await this.fetchWithFallback(cleanText);
    } catch (error: any) {
      console.error("[EmbeddingService] All embedding attempts failed:", error.message);
      throw new AppError(503, "Embedding service temporarily unavailable");
    }
  }

  private async fetchWithFallback(input: string): Promise<EmbeddingResult> {
    const models = [
      AI_CONFIG.models.embeddings.primary,
      AI_CONFIG.models.embeddings.fallback
    ];

    let lastError = null;

    for (const model of models) {
      try {
        console.log(`[EmbeddingService] Attempting embedding with model: ${model}`);
        const response = await fetch("https://openrouter.ai/api/v1/embeddings", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
            "HTTP-Referer": "https://scribeshade.com",
            "X-Title": "ScribeShade",
          },
          body: JSON.stringify({ model, input })
        });

        const data = await response.json() as any;

        if (data.data && data.data[0] && data.data[0].embedding) {
          const embedding = data.data[0].embedding;
          return {
            embedding,
            model,
            dimensions: embedding.length
          };
        }

        throw new Error(data.error?.message || `Model ${model} returned no data`);
      } catch (err: any) {
        console.warn(`[EmbeddingService] Model ${model} failed:`, err.message);
        lastError = err;
        continue; // Try next model
      }
    }

    throw lastError || new Error("Unknown embedding error");
  }

  /**
   * Batch process multiple texts (useful for indexing)
   */
  async generateBatch(texts: string[]): Promise<EmbeddingResult[]> {
    // For simplicity, we'll process sequentially for now to handle fallbacks per text
    // but a real implementation would use Promise.all or OpenRouter batch API
    const results: EmbeddingResult[] = [];
    for (const text of texts) {
      results.push(await this.generateEmbedding(text));
    }
    return results;
  }
}
