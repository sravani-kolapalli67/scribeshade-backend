import {
  buildScenarioEvidence,
  type TranscriptEvidenceLine,
} from "../ai-answer-context-guards";
import type { ScenarioEvidencePacket } from "../session-intelligence.types";

export function buildScenarioEvidencePacket(input: {
  lines: TranscriptEvidenceLine[];
  currentQuestionHint?: string;
}): ScenarioEvidencePacket | null {
  const evidence = buildScenarioEvidence({
    lines: input.lines,
    currentQuestionHint: input.currentQuestionHint || "",
  });
  return evidence?.scenarioPacket || null;
}
