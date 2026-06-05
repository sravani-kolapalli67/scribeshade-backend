import test from "node:test";
import assert from "node:assert/strict";
import {
  mergeNormalizedBlocks,
  normalizeTranscriptForAI,
} from "./transcript-normalizer.service";

test("preserves resolved user transcript when speaker-separated entries omit it", () => {
  const blocks = normalizeTranscriptForAI({
    rawText: "I worked on the Razorpay payment flow and credit holds.",
    metadata: {
      speakerSeparatedTranscript: [
        {
          speakerType: "interviewer",
          content: "Can you explain the billing system?",
        },
      ],
    },
    dictionaryTerms: ["Razorpay"],
    activeTopicKeywords: [],
    confidence: 0.82,
  });

  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].speakerType, "INTERVIEWER");
  assert.equal(blocks[1].speakerType, "UNKNOWN");
  assert.match(mergeNormalizedBlocks(blocks), /billing system/i);
  assert.match(mergeNormalizedBlocks(blocks), /Razorpay payment flow/i);
});

test("does not duplicate resolved transcript already present in speaker-separated entries", () => {
  const blocks = normalizeTranscriptForAI({
    rawText: "Can you explain the billing system?",
    metadata: {
      speakerSeparatedTranscript: [
        {
          speakerType: "interviewer",
          content: "Can you explain the billing system?",
        },
      ],
    },
    dictionaryTerms: [],
    activeTopicKeywords: [],
    confidence: 0.76,
  });

  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].speakerType, "INTERVIEWER");
});
