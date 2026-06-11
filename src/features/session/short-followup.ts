export type ManualQueryType =
  | "full_question"
  | "short_followup"
  | "command"
  | "unknown";

const SHORT_FOLLOWUP_COMMANDS = new Set([
  "example",
  "explain",
  "explain it",
  "give example",
  "give me example",
  "show example",
  "more",
  "why",
  "how",
  "continue",
  "elaborate",
]);

const COMMAND_ONLY_RE =
  /^(click ai answer|clear transcript|enable automation|disable automation|next question|stop recording|start recording|open overlay|close overlay)$/i;
const EXPLICIT_CODE_REQUEST_RE =
  /\b(write code|implement|create\s+(?:a\s+)?component|give\s+(?:me\s+)?(?:a\s+)?snippet|typescript code|javascript code|python code)\b|(?:\b(write|create|build|show|give|provide)\b.{0,60}\b(code|snippet|function|class|api|algorithm|program|component)\b)/i;

function normalizeCommand(text: string): string {
  return (text || "")
    .toLowerCase()
    .replace(/[?.!,;:]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function isShortFollowupCommand(text: string): boolean {
  return SHORT_FOLLOWUP_COMMANDS.has(normalizeCommand(text));
}

export function hasExplicitCodeRequest(text: string): boolean {
  return EXPLICIT_CODE_REQUEST_RE.test(text || "");
}

export function getCodeIntentSuppressedReason(text: string): string | null {
  return isShortFollowupCommand(text) && !hasExplicitCodeRequest(text)
    ? "short_followup_without_explicit_code_request"
    : null;
}

export function classifyManualQueryType(text: string): ManualQueryType {
  const normalized = normalizeCommand(text);
  if (!normalized) return "unknown";
  if (isShortFollowupCommand(normalized)) return "short_followup";
  if (COMMAND_ONLY_RE.test(normalized)) return "command";
  if (/[?]/.test(text) || /^(what|why|how|when|where|which|who|can|could|would|should|is|are|do|does|did|explain|define|describe|tell me|write|implement|design)\b/i.test(text)) {
    return "full_question";
  }
  return "unknown";
}
