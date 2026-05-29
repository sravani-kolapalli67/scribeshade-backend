import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyComplexity,
  detectFollowupIntent,
  extractRelevantProjectContext,
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

test("CIE project context places PRIMARY project first for overview asks", () => {
  const projectRecords = [
    {
      id: "optional-1",
      projects: [{ projectHeader: { title: "Optional Payments Engine", role: "Backend Engineer" }, sections: [] }],
    },
    {
      id: "primary-1",
      projects: [{ projectHeader: { title: "Primary Finance Platform", role: "Tech Lead" }, sections: [] }],
    },
  ];

  const context = extractRelevantProjectContext(
    projectRecords,
    "Tell me about your projects",
    700,
    { selectedProjectIds: ["primary-1", "optional-1"], primaryProjectId: "primary-1" },
  );

  assert.ok(context.includes("PRIMARY PROJECT: Primary Finance Platform"));
  assert.ok(context.indexOf("PRIMARY PROJECT: Primary Finance Platform") < context.indexOf("OPTIONAL PROJECT: Optional Payments Engine"));
});

test("CIE project context still allows optional project to lead when explicitly asked", () => {
  const projectRecords = [
    {
      id: "primary-1",
      projects: [{ projectHeader: { title: "Primary Finance Platform", role: "Tech Lead" }, sections: [] }],
    },
    {
      id: "optional-1",
      projects: [{ projectHeader: { title: "Optional Logistics Tool", role: "Backend Engineer" }, sections: [] }],
    },
  ];

  const context = extractRelevantProjectContext(
    projectRecords,
    "Explain Optional Logistics Tool project",
    700,
    { selectedProjectIds: ["primary-1", "optional-1"], primaryProjectId: "primary-1" },
  );

  assert.ok(context.includes("PRIMARY PROJECT: Primary Finance Platform"));
  assert.ok(context.includes("OPTIONAL PROJECT: Optional Logistics Tool"));
  assert.ok(context.indexOf("OPTIONAL PROJECT: Optional Logistics Tool") < context.indexOf("PRIMARY PROJECT: Primary Finance Platform"));
});

test("CIE project context includes concise architecture and flow details when available", () => {
  const projectRecords = [
    {
      id: "primary-1",
      projects: [{
        projectHeader: { title: "Payments Core", role: "Backend Engineer", domain: "Fintech" },
        sections: [
          { key: "architecture_diagram", type: "code_block", content: "Client -> API Gateway -> Payments Service -> Postgres" },
          {
            key: "data_flow",
            type: "steps",
            content: [
              { step: "Capture request", description: "Receive payment" },
              { step: "Validate", description: "Fraud and schema checks" },
              { step: "Persist", description: "Store transaction" },
            ],
          },
          {
            key: "challenges_resolution",
            type: "challenge_cards",
            content: [{ challenge: "Duplicate webhook retries", solution: "Idempotency keys + dedupe table" }],
          },
        ],
      }],
    },
  ];

  const context = extractRelevantProjectContext(
    projectRecords,
    "Explain your project architecture",
    900,
    { selectedProjectIds: ["primary-1"], primaryProjectId: "primary-1" },
  );

  assert.ok(
    context.includes("[Architecture]:") ||
      context.includes("[Architecture Diagram]:"),
  );
  assert.ok(context.includes("[Flow]:"));
  assert.ok(context.includes("[Challenge]:"));
});

test("CIE project context preserves architecture diagram markdown block", () => {
  const projectRecords = [
    {
      id: "primary-1",
      projects: [{
        projectHeader: { title: "Banking Gateway", role: "Backend Engineer", domain: "Fintech" },
        sections: [
          {
            key: "architecture_diagram",
            title: "Architecture Diagram",
            type: "code_block",
            content: "Web -> API Gateway -> Service\nService -> Redis\nService -> Postgres",
          },
        ],
      }],
    },
  ];

  const context = extractRelevantProjectContext(
    projectRecords,
    "explain your project",
    1000,
    { selectedProjectIds: ["primary-1"], primaryProjectId: "primary-1" },
  );

  assert.ok(context.includes("[Architecture Diagram]:"));
  assert.ok(context.includes("```text"));
  assert.ok(context.includes("Web -> API Gateway -> Service"));
});

test("CIE keeps architecture diagram block even under tighter project token budget", () => {
  const projectRecords = [
    {
      id: "primary-1",
      projects: [{
        projectHeader: { title: "Payments Core", role: "Backend Engineer", domain: "Fintech" },
        sections: [
          { key: "resume_ready_bullets", type: "bullets", content: ["A", "B", "C", "D", "E"] },
          { key: "introduction", type: "narrative", content: "Long intro ".repeat(60) },
          {
            key: "architecture_diagram",
            title: "Architecture Diagram",
            type: "code_block",
            content: "Client -> API -> Service\nService -> Redis\nService -> Postgres",
          },
          { key: "business_purpose", type: "narrative", content: "Purpose ".repeat(80) },
        ],
      }],
    },
  ];

  const context = extractRelevantProjectContext(
    projectRecords,
    "Explain your project",
    350,
    { selectedProjectIds: ["primary-1"], primaryProjectId: "primary-1" },
  );

  assert.ok(context.includes("[Architecture Diagram]:"));
  assert.ok(context.includes("```text"));
});
