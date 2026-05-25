import test from "node:test";
import assert from "node:assert/strict";
import {
  buildScreenAnalysisMessage,
  buildScreenSystemMessage,
  buildSystemMessage,
  buildUserMessage,
} from "./prompt";

const baseContext = {
  company: "Acme",
  role: "Data Engineer",
  language: "Python",
  resume: "5.9 years of data engineering experience with Spark and Databricks.",
  document: "None provided.",
  history: "No previous interactions in this session.",
  instructions: "None.",
  projects: "No projects provided.",
  simpleLanguage: false,
};

test("system prompt requires markdown answer body and allows answer-body bold labels", () => {
  const prompt = buildSystemMessage({
    ...baseContext,
    complexity: "scenario_based",
  });

  assert.ok(prompt.includes("MANDATORY MARKDOWN ANSWER FORMAT"));
  assert.ok(prompt.includes("The answer body under **ANSWER:** must be Markdown"));
  assert.ok(prompt.includes("**Direct answer:**"));
  assert.ok(prompt.includes("Inside the answer body, markdown bold is allowed"));
  assert.equal(prompt.includes("Never put '**' anywhere except"), false);
});

test("compact and follow-up prompts include the same markdown contract", () => {
  const compact = buildSystemMessage({
    ...baseContext,
    complexity: "simple_contextual",
  });
  const followup = buildSystemMessage({
    ...baseContext,
    complexity: "followup",
  });

  assert.ok(compact.includes("MANDATORY MARKDOWN ANSWER FORMAT"));
  assert.ok(compact.includes("raw HTML"));
  assert.ok(followup.includes("MANDATORY MARKDOWN ANSWER FORMAT"));
  assert.ok(followup.includes("'- ' bullets"));
});

test("user prompts include markdown contract across answer entrypoints", () => {
  const normal = buildUserMessage("How many years of experience do you have?", false, false, {
    ...baseContext,
    complexity: "simple_contextual",
  });
  const custom = buildUserMessage("Explain Spark", true, false, baseContext);
  const regenerate = buildUserMessage("Explain Spark", false, true, baseContext);

  assert.ok(normal.includes("MANDATORY MARKDOWN ANSWER FORMAT"));
  assert.ok(custom.includes("MANDATORY MARKDOWN ANSWER FORMAT"));
  assert.ok(regenerate.includes("MANDATORY MARKDOWN ANSWER FORMAT"));
});

test("screen prompts require markdown bullets without changing sentinel behavior", () => {
  const system = buildScreenSystemMessage(baseContext);
  const user = buildScreenAnalysisMessage(baseContext);

  assert.ok(system.includes("MANDATORY MARKDOWN ANSWER FORMAT"));
  assert.ok(user.includes("MANDATORY MARKDOWN ANSWER FORMAT"));
  assert.ok(user.includes("===NO_NEW_QUESTION==="));
  assert.ok(user.includes("===NEXT_QUESTION==="));
});
