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

test("markdown contract requires spacing, keyword highlighting, and candidate voice", () => {
  const prompt = buildSystemMessage({
    ...baseContext,
    complexity: "simple_contextual",
  });

  assert.ok(prompt.includes("Put one blank line between top-level project bullets"));
  assert.ok(prompt.includes("Highlight exact numbers and measurable values with bold"));
  assert.ok(prompt.includes("Use inline code for explicit tools"));
  assert.ok(prompt.includes("Do not explain like a tutor"));
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

test("project-explain rules include architecture diagram exception and required flow guidance", () => {
  const prompt = buildSystemMessage({
    ...baseContext,
    complexity: "scenario_based",
    projects:
      "━━━ PRIMARY PROJECT: Banking Gateway ━━━\n[Architecture Diagram]:\n```text\nA -> B -> C\n```",
    hasSelectedProjects: true,
    isProjectQuestion: true,
    projectPriorityMode: "project_questions_only",
  });

  assert.ok(
    prompt.includes(
      "Exception: for project-explanation questions, if selected project context includes an Architecture Diagram block",
    ),
  );
  assert.ok(
    prompt.includes(
      "This is required for project-explain asks when diagram context is available.",
    ),
  );
});

test("compact resume-backed project prompts require in-depth per-project structure", () => {
  const prompt = buildSystemMessage({
    ...baseContext,
    complexity: "simple_contextual",
    projects:
      "RESUME-BACKED PROJECT/WORK CONTEXT (selected resume only; do not invent beyond this):\nPROJECTS\nHilton Grand Vacations\n- Migrated legacy data pipelines using Databricks and Azure.",
    hasSelectedProjects: false,
    isProjectQuestion: true,
  });

  assert.ok(prompt.includes("PROJECT EXPLANATION FORMAT"));
  assert.ok(prompt.includes("CANDIDATE'S RESUME PROJECT/WORK CONTEXT"));
  assert.ok(prompt.includes("Do not start with a generic overview paragraph"));
  assert.ok(prompt.includes("**Business problem:**"));
  assert.ok(prompt.includes("**Architecture/approach:**"));
  assert.ok(prompt.includes("Keep each nested point interview-spoken"));
  assert.ok(prompt.includes("you MAY infer the business problem and architecture flow"));
  assert.ok(prompt.includes("Do not invent company names, tools, exact metrics"));
});

test("simple language keeps project headings but requires easy wording", () => {
  const prompt = buildSystemMessage({
    ...baseContext,
    complexity: "simple_contextual",
    simpleLanguage: true,
    projects:
      "RESUME-BACKED PROJECT/WORK CONTEXT (selected resume only; do not invent beyond this):\nPROJECTS\nINFY\n- Developed a scalable Data Lake.",
    hasSelectedProjects: false,
    isProjectQuestion: true,
  });

  assert.ok(prompt.includes("If simple language mode is on, keep the same headings"));
  assert.ok(prompt.includes("SIMPLE LANGUAGE MODE: use plain easy English"));
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
