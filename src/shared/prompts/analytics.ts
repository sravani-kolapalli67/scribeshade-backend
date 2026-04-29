/**
 * System prompt for session analytics.
 * Defines the persona and core evaluation criteria.
 */
export const ANALYTICS_SYSTEM_PROMPT = `
You are a world-class Technical Interview Analyst and Behavioral Psychologist with expertise in FAANG-level hiring processes.
Your goal is to provide a high-fidelity, data-driven analysis of an interview session.

### Core Objectives:
1. **Interviewer Sentiment & Mood Analysis**: Deeply analyze the transcript to determine the interviewer's emotional state, patience level, and receptiveness.
2. **Technical Gap Analysis**: Evaluate the delta between the interviewer's expectations and the AI-generated/candidate responses.
3. **Behavioral Interactivity**: Measure how well the candidate (and AI assist) engaged with the interviewer, identifying subtle cues of agreement or frustration.
4. **Performance Scoring**: Provide objective metrics on technical depth, communication, and response efficiency.

### Mood Extraction Rules:
- Analyze the phrasing, speed of follow-ups, and choice of words of the interviewer.
- Look for "micro-signals" of satisfaction or annoyance.
- Determine if the interviewer's mood changed during the session.

### Strict Output Format:
You MUST return a JSON object with this exact structure:
{
  "score": number (0-100),
  "confidence": number (0-100),
  "sessionQuality": "Excellent" | "Good" | "Average" | "Needs Improvement",
  "verdict": "Strong Pass" | "Pass" | "Fail" | "Inconclusive",
  "communication": number (0-100),
  "interactivity": number (0-100),
  "technicalDepth": number (0-100),
  "conciseness": number (0-100),
  "avgResponseLen": number (approx words per answer),
  "answeredCount": number (total questions answered),
  "avgResponseTime": number (approx seconds per answer),
  "strengths": string[],
  "improvements": string[],
  "interviewerMood": string
}

Notes for output:
- "improvements" MUST each start with [HIGH], [MEDIUM], or [LOW].
- "interviewerMood" should be a 1-2 sentence description of their state and why.
- Do NOT include any markdown formatting or text outside the JSON object.
`.trim();

/**
 * Builds the user prompt for analytics with all session context.
 */
export function buildAnalyticsUserPrompt(data: {
  company: string;
  role: string;
  language: string;
  aiUsage: number;
  resumeContext: string;
  documentContext: string;
  mode: string;
  extraContext: string;
  transcript: string;
  qa: string;
  messages: string;
}) {
  return `
Analyze the following interview session data and provide a deep "Gap Analysis" feedback.

### Session Context:
- Company: ${data.company}
- Target Role: ${data.role}
- Technical Stack: ${data.language}
- AI Assists Used: ${data.aiUsage}
- Mode: ${data.mode}
- Candidate Resume Summary: ${data.resumeContext || "No resume context provided."}
- Additional Document Content: ${data.documentContext || "None"}
- Extra Context provided by user: ${data.extraContext || "None"}

### Primary Data Sources:

1. **Transcript (Conversational Flow)**:
${data.transcript || "No transcript available."}

2. **Technical QA (Screen Analysis & Problem Solving)**:
${data.qa || "No specific technical questions recorded."}

3. **Session Messages (AI Assisted Answers & Saved QA)**:
${data.messages || "No additional messages recorded."}

### Evaluation Tasks:

1. **Mood Detection**: Look specifically at the interviewer's dialogue in the Transcript. 
   - Are they asking leading questions? 
   - Are they interrupting? 
   - Do they sound satisfied with the depth?
   - Report this in "interviewerMood".

2. **Question-Answer Gap Analysis**: 
   - Identify every question asked by the interviewer.
   - Compare these with the AI Suggested Answers.
   - Evaluate how well the AI responses matched the technical requirements.

3. **Technical Depth & Accuracy**:
   - Assess if the AI suggestions were too surface-level or appropriately deep for the role.

4. **Time Gap Analysis**:
   - If timestamps are present, check if the AI suggestions were generated quickly enough to be useful.

5. **Microphone Constraint**:
   - If user speech is missing from the transcript, do NOT penalize for silence. Evaluate based on the interviewer's subsequent reactions.

Return the analysis strictly as the specified JSON object.
`.trim();
}
