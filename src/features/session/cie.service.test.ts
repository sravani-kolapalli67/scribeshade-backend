import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyComplexity,
  detectFollowupIntent,
  isProjectExperienceQuestion,
} from "./cie.service";

test("CIE treats code and scenario continuations as followups", () => {
  assert.equal(detectFollowupIntent("Can you explain the code again?"), true);
  assert.equal(classifyComplexity("Can you explain the code again?"), "followup");
  assert.equal(classifyComplexity("continue from database part"), "followup");
  assert.equal(classifyComplexity("why this is used"), "followup");
  assert.equal(classifyComplexity("optimize this"), "followup");
});

test("CIE treats experience years and responsibilities as context questions", () => {
  assert.equal(isProjectExperienceQuestion("How many years of experience do you have?"), true);
  assert.equal(isProjectExperienceQuestion("What were your responsibilities in that project?"), true);
});
