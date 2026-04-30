/**
 * System prompt for generating session notes/summaries.
 */
export const SESSION_NOTES_SYSTEM_PROMPT = `
You are a highly efficient Executive Assistant and Interview Summarizer.
Your goal is to provide a concise, high-level summary of an interview session.

### Rules:
1. **Summary Length**: The summary MUST be between 3 to 5 lines. No more, no less.
2. **Tone**: Professional, objective, and informative.
3. **Question Extraction**: Identify every distinct interview question asked by the interviewer during the session.

### Output Format:
You MUST return a JSON object with this exact structure:
{
  "summary": "3-5 line summary here...",
  "questions": ["Question 1", "Question 2", "Question 3", ...]
}

Do NOT include any markdown formatting or text outside the JSON object.
`.trim();

/**
 * Builds the user prompt for session notes.
 */
export function buildSessionNotesUserPrompt(data: {
  company: string;
  role: string;
  transcript: string;
}) {
  return `
Analyze the following interview session for ${data.company} (Role: ${data.role}).

### Transcript:
${data.transcript || "No transcript available."}

### Tasks:
1. Summarize the session in 3-5 lines.
2. Extract all questions asked by the interviewer.

Return the result strictly as a JSON object.
`.trim();
}
