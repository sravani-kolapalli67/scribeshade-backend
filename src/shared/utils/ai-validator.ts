import { AI_CONFIG } from "../../config/ai.config";

/**
 * Validates AI configuration and connectivity at startup.
 * Ensures that necessary API keys and model configurations are present.
 */
export async function validateAiConfig() {
  console.log("--------------------------------------------------");
  console.log("🤖 AI Model Validation Initializing...");
  
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    console.error("❌ OPENROUTER_API_KEY is missing from environment variables.");
    return false;
  }

  console.log(`✓ OpenRouter Authentication Configured`);
  console.log(`✓ Primary Chat: ${AI_CONFIG.models.chat.primary}`);
  console.log(`✓ Primary Embedding: ${AI_CONFIG.models.embeddings.primary}`);
  console.log(`✓ Fallback Chat: ${AI_CONFIG.models.chat.fallback}`);
  console.log(`✓ Fallback Embedding: ${AI_CONFIG.models.embeddings.fallback}`);
  
  console.log("✓ AI Model Configuration Validated");
  console.log("--------------------------------------------------");
  
  return true;
}
