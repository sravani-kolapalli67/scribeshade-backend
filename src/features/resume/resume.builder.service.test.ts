import assert from "node:assert/strict";
import test from "node:test";

async function loadResumeBuilderService(): Promise<
  typeof import("./resume.builder.service")
> {
  process.env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "test-openrouter-key";
  process.env.OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || "test-model";
  return import("./resume.builder.service");
}

const COMPLETE_HTML = [
  "<!doctype html>",
  "<html>",
  "<head><meta charset=\"utf-8\"></head>",
  "<body><main><section>Resume</section></main></body>",
  "</html>",
].join("");

test("sanitizeGeneratedResumeHtml strips markdown fences around complete HTML", async () => {
  const { sanitizeGeneratedResumeHtml } = await loadResumeBuilderService();

  const actual = sanitizeGeneratedResumeHtml(`\`\`\`html\n${COMPLETE_HTML}\n\`\`\``);

  assert.equal(actual, COMPLETE_HTML);
});

test("sanitizeGeneratedResumeHtml extracts the HTML document from prose-wrapped output", async () => {
  const { sanitizeGeneratedResumeHtml } = await loadResumeBuilderService();

  const actual = sanitizeGeneratedResumeHtml(`Here is the populated resume:\n${COMPLETE_HTML}\nDone.`);

  assert.equal(actual, COMPLETE_HTML);
});

test("sanitizeGeneratedResumeHtml rejects HTML fragments without a full document", async () => {
  const { sanitizeGeneratedResumeHtml } = await loadResumeBuilderService();

  assert.throws(
    () => sanitizeGeneratedResumeHtml("<div>Resume fragment</div>"),
    /complete HTML document/,
  );
});
