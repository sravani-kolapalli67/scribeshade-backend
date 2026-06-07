import crypto from "crypto";
import type { CodeTaskMemory } from "../session-intelligence.types";

const FUNCTION_RE =
  /\b(?:def|function)\s+([a-zA-Z_][a-zA-Z0-9_]*)|\b(row_number|lag|lead|collect_list|broadcast|groupBy|withColumn|join)\b/g;

function normalizeSpaces(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function inferLanguage(code: string): string {
  const normalized = code.toLowerCase();
  if (/\bselect\b|\bfrom\b|\bwhere\b|\bjoin\b/.test(normalized)) return "sql";
  if (/\bpyspark\b|\bwithcolumn\b|\bwindow\b/.test(normalized)) {
    return "python/pyspark";
  }
  if (/\bdef\b|\bimport\b/.test(normalized)) return "python";
  if (/\bconst\b|\blet\b|\bfunction\b|=>/.test(normalized)) {
    return "javascript/typescript";
  }
  return "text";
}

function extractFunctions(code: string): string[] {
  return [
    ...new Set(
      Array.from(code.matchAll(FUNCTION_RE))
        .map((match) => match[1] || match[2])
        .filter(Boolean),
    ),
  ].slice(0, 8);
}

export function buildCodeTaskMemory(input: {
  answerId: string;
  question: string;
  answer: string;
  topic: string;
  explicitCodeTask: boolean;
}): CodeTaskMemory | null {
  if (!input.explicitCodeTask) return null;
  const code = Array.from(
    input.answer.matchAll(/```([^\n`]*)\n?([\s\S]*?)```/g),
  )
    .map((match) => match[2].trim())
    .filter(Boolean)
    .join("\n\n");
  if (!code) return null;
  const languageHint =
    input.answer.match(/```([^\n`]*)/)?.[1]?.trim() || "";

  return {
    answerId: input.answerId,
    question: normalizeSpaces(input.question),
    language: languageHint || inferLanguage(code),
    codeSummary: normalizeSpaces(code).slice(0, 500),
    codePreview: code.slice(0, 1500),
    codeHash: crypto.createHash("sha256").update(code).digest("hex"),
    keyFunctions: extractFunctions(code),
    assumptions: [],
    edgeCases: [],
    topic: input.topic,
  };
}
