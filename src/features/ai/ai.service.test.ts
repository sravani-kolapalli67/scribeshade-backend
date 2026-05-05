import test from "node:test";
import assert from "node:assert/strict";
import {
  computeSkillMismatch,
  detectCredibilityWarning,
  extractSkillsFromResumeArtifacts,
  getProjectCategories,
} from "./ai.service";

test("getProjectCategories returns role-aware categories", () => {
  const result = getProjectCategories("fullstack");
  assert.equal(result.role_type, "fullstack");
  assert.ok(result.categories.includes("Web App"));
  assert.ok(result.categories.includes("API Service"));
});

test("extractSkillsFromResumeArtifacts merges parsed_data and metadata_index skills", () => {
  const parsedData = {
    skills: ["React", "TypeScript", "Node.js"],
  };

  const metadataIndex = {
    skills: {
      backend: ["PostgreSQL", "Prisma"],
      infra: ["Docker"],
    },
  };

  const result = extractSkillsFromResumeArtifacts(
    parsedData,
    metadataIndex,
    "Worked with Redis and AWS",
  );

  assert.ok(result.includes("react"));
  assert.ok(result.includes("typescript"));
  assert.ok(result.includes("postgresql"));
  assert.ok(result.includes("redis"));
});

test("computeSkillMismatch enforces scope limiting when mismatch > 40%", () => {
  const result = computeSkillMismatch(
    ["react", "node.js", "kubernetes", "go", "azure"],
    ["react", "node.js"],
  );

  assert.equal(result.scopeLimited, true);
  assert.ok(result.mismatchRatio > 0.4);
  assert.ok(result.allowedSkills.includes("react"));
  assert.ok(result.allowedSkills.includes("node.js"));
});

test("detectCredibilityWarning warns for unrealistic fresher claims", () => {
  const result = detectCredibilityWarning(
    "fresher",
    "Handled 10 million users and improved throughput by 1000%.",
  );

  assert.equal(result.warning, true);
  assert.ok(result.message);
});
