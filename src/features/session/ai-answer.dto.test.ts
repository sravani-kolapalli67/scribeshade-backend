import test from "node:test";
import assert from "node:assert/strict";
import {
  aiAnswerRequestSchema,
  normalizeAIAnswerRequestBody,
} from "./ai-answer.dto";

test("ai-answer DTO accepts transcript evidence without transcript string", () => {
  const payload = {
    requestId: "evidence-only",
    recentTranscriptWindow: [
      "[Interviewer]: Can you explain useEffect?",
    ],
    speakerSeparatedTranscript: [
      {
        speakerType: "interviewer",
        content: "Can you explain useEffect?",
        timestamp: 1780667248124,
      },
    ],
  };

  const parsed = aiAnswerRequestSchema.safeParse(payload);
  assert.equal(parsed.success, true);

  const normalized = normalizeAIAnswerRequestBody(payload);
  assert.equal(normalized.resolvedQuestion, "");
  assert.equal(normalized.resolvedFrom, "none");
  assert.deepEqual(normalized.liveContextMetadata?.recentTranscriptWindow, payload.recentTranscriptWindow);
  assert.deepEqual(normalized.liveContextMetadata?.speakerSeparatedTranscript, payload.speakerSeparatedTranscript);
});

test("custom query removes synthetic frontend continuity suffix", () => {
  const normalized = normalizeAIAnswerRequestBody({
    transcript:
      "Explain your projects (in context of: Can you please introduce yourself?)",
    currentQuestion:
      "Explain your projects (in context of: Can you please introduce yourself?)",
    isCustomQuery: true,
  });

  assert.equal(normalized.resolvedQuestion, "Explain your projects");
  assert.equal(normalized.resolvedFrom, "currentQuestion");
});
