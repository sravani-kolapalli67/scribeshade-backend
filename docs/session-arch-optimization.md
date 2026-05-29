Looking at your architecture, the core problems are:

1. **Regex classification is brittle** — interview language is too varied and contextual
2. **Sequential pipeline** (detect → classify → build context → call AI) adds 800ms+ of overhead before the first token
3. **Follow-up resolution by scoring** is gaming similarity instead of understanding intent
4. **Single model doing everything** — no separation between fast classification and deep generation

Here's a concrete re-architecture:

---

## The Core Problem with Your Current Flow

```
Click → 600ms debounce → detect question → regex classify 
      → AI decision (OpenRouter round-trip) → build context 
      → build prompt → AI generate → stream
```

That's **2-3 full round-trips before the user sees anything.** In a real interview, the candidate needs the answer in under 2 seconds from click.

---

## Proposed Architecture

### 1. Replace Regex Classification with a Streaming Micro-Classifier

Instead of `classifyConversationIntent()` with regex patterns, run a **tiny fast model** (Gemini Flash / GPT-4o-mini / Haiku) as a pure classifier that runs **in parallel** with context building, not before it:

```typescript
// answer-quality.ts — replace regex classifier
export async function classifyQuestionIntent(
  question: string,
  recentTranscript: string,
  lastAiAnswer: string,
): Promise<QuestionIntent> {
  
  const prompt = `Classify this interview question into exactly one category.
  
Recent conversation:
${recentTranscript.slice(-400)}

Last AI answer topic: ${lastAiAnswer.slice(0, 150)}

New question: "${question}"

Respond with JSON only:
{
  "intent": "new_concept|code_write|code_explain|code_optimize|code_debug|followup_same|followup_different|behavioral|system_design|scenario",
  "needsPreviousCode": true|false,
  "needsPreviousAnswer": true|false,
  "confidence": 0.0-1.0
}`;

  // Use smallest/fastest model — this should complete in ~200ms
  const result = await ai.callModel({
    model: "google/gemini-flash-1.5-8b",
    maxOutputTokens: 80,
    input: [{ role: "user", content: prompt }]
  });
  
  return JSON.parse(result);
}
```

**Why this beats regex**: It understands "can you make it faster" as `code_optimize`, "what about edge cases" as `followup_same`, "explain why you'd use this in production" as `followup_different` — none of which your current regex patterns reliably catch.

---

### 2. Parallel Pipeline — Kill Sequential Latency

This is the biggest win. Currently everything is sequential. Make it parallel:

```typescript
// session.service.ts — rewrite the main handler

async function handleAIAnswer(sessionId, payload) {
  
  // PARALLEL TRACK A: Fast classification (200ms)
  const classificationPromise = classifyQuestionIntent(
    payload.currentQuestion,
    payload.recentTranscriptWindow,
    payload.previousAiAnswer ?? ""
  );
  
  // PARALLEL TRACK B: Context building (300-500ms, DB reads)
  const contextPromise = buildOptimizedContext(sessionId, {
    question: payload.currentQuestion,
    resumeId: session.resumeId,
    projectIds: session.projectIds,
  });
  
  // PARALLEL TRACK C: History prep (local, ~10ms)
  const historyPromise = Promise.resolve(
    toAnswerHistory((session as any).messages)
  );
  
  // Wait for all three in parallel
  const [classification, context, history] = await Promise.all([
    classificationPromise,
    contextPromise,
    historyPromise,
  ]);
  
  // NOW: Context binding + prompt construction (~50ms, pure CPU)
  const prompt = buildPromptFromClassification(
    classification,
    context,
    history,
    payload
  );
  
  // Stream immediately
  return streamAIResponse(prompt);
}
```

**Latency impact**: Drops from ~1.2s pre-generation delay to ~350ms.

---

### 3. Replace Follow-up Scoring with Explicit Turn Linking

Your current follow-up resolution scores history entries by topic/recency/code presence. This is fragile. Use **explicit conversation threading** instead:

```typescript
// New data structure — store in Redis alongside session
interface ConversationThread {
  turnId: string;
  question: string;
  answerSummary: string;    // 100-char summary for fast matching
  codeLanguage?: string;    // "sql" | "python" | null
  topicVector?: number[];   // embedding for semantic search
  childTurnIds: string[];   // follow-up turns linked to this
  timestamp: number;
}

// When saving an answer:
async function saveTurnToThread(sessionId, turn) {
  const existing = await redis.get(`thread:${sessionId}`);
  const thread: ConversationThread[] = existing ? JSON.parse(existing) : [];
  
  // Generate embedding for semantic follow-up detection
  const embedding = await embedText(`${turn.question} ${turn.answer.slice(0, 300)}`);
  
  thread.push({
    turnId: turn.id,
    question: turn.question,
    answerSummary: turn.answer.slice(0, 100),
    codeLanguage: detectCodeLanguage(turn.answer),
    topicVector: embedding,
    childTurnIds: [],
    timestamp: Date.now()
  });
  
  await redis.set(`thread:${sessionId}`, JSON.stringify(thread), "EX", 7200);
}

// When detecting follow-up:
async function resolveFollowupTarget(question, sessionId) {
  const thread = await getThread(sessionId);
  if (!thread.length) return null;
  
  // Embed current question and cosine-search history
  const qEmbed = await embedText(question);
  
  let bestMatch = null;
  let bestScore = 0;
  
  for (const turn of thread.slice(-5)) {  // Only last 5 turns
    const score = cosineSimilarity(qEmbed, turn.topicVector);
    if (score > 0.75 && score > bestScore) {
      bestMatch = turn;
      bestScore = score;
    }
  }
  
  // Hard rule: if explicit code reference, always use last code turn
  const hasExplicitRef = /\b(this|that|same|the) (code|query|function|approach)\b/i.test(question);
  if (hasExplicitRef) {
    const lastCodeTurn = [...thread].reverse().find(t => t.codeLanguage);
    return lastCodeTurn ?? bestMatch;
  }
  
  return bestMatch;
}
```

---

### 4. Streaming Question Detection — Don't Wait for Silence

Your current system waits for the user to click "AI Answer." For auto-mode, you should be detecting question completion **from the transcript stream itself**:

```typescript
// New: useInterviewerQuestionDetector hook
// Runs continuously on incoming tab transcript chunks

const QUESTION_END_SIGNALS = [
  /\?$/,                                    // ends with ?
  /\bthoughts?\b.*\.$/i,                   // "your thoughts on that."
  /\bhow would you\b.*[.?]$/i,             // "how would you approach..."
  /\bwhat (?:is|are|would|do you)\b.*[.?]$/i,
  /\btell me about\b.*\.$/i,
];

function detectQuestionCompletion(
  buffer: TranscriptChunk[],
  silenceGapMs: number,
): DetectedQuestion | null {
  
  const recentText = buffer
    .slice(-8)
    .map(c => c.text)
    .join(" ")
    .trim();
  
  // 1. Explicit question pattern detected
  const matchedPattern = QUESTION_END_SIGNALS.some(re => re.test(recentText));
  
  // 2. Silence gap (interviewer stopped speaking for >1.2s)
  const hasSignificantSilence = silenceGapMs > 1200;
  
  // 3. Minimum length check (avoid triggering on filler words)
  const hasSubstance = recentText.split(" ").length > 6;
  
  if ((matchedPattern || hasSignificantSilence) && hasSubstance) {
    return {
      text: recentText,
      triggerType: matchedPattern ? "pattern" : "silence",
      timestamp: Date.now(),
    };
  }
  
  return null;
}
```

This allows **auto-answer mode** where the system generates answers the moment the interviewer finishes asking — before the user even clicks.

---

### 5. Context Tiering — Stop Over-Fetching

Your `buildOptimizedContext()` always fetches resume + docs + projects via RAG. For 80% of interview questions this is wasted latency. Tier it:

```typescript
type ContextTier = "minimal" | "resume" | "full";

function selectContextTier(intent: QuestionIntent): ContextTier {
  switch (intent) {
    // Pure technical — no personal context needed
    case "new_concept":
    case "code_write":
    case "code_optimize":
    case "code_debug":
    case "system_design":
      return "minimal";  // Just job description
    
    // Needs resume experience
    case "behavioral":
    case "followup_different":
      return "resume";   // JD + resume + 2 recent answers
    
    // Full context
    case "scenario":
      return "full";     // Everything + projects + docs
    
    default:
      return "resume";
  }
}

async function buildTieredContext(
  sessionId: string,
  tier: ContextTier,
  session: Session
) {
  const base = {
    jobDescription: session.jobDescription,
    language: session.language,
  };
  
  if (tier === "minimal") return base;
  
  const resume = await fetchResume(session.resumeId);
  if (tier === "resume") return { ...base, resume };
  
  const [docs, projects] = await Promise.all([
    fetchDocument(session.documentId),
    fetchProjects(session.projectIds),
  ]);
  
  return { ...base, resume, docs, projects };
}
```

**Impact**: "Explain what a JOIN is" goes from 400ms context fetch to 5ms. "Tell me about a project where you optimized performance" still gets full context.

---

### 6. Prompt Caching — Stop Re-sending the System Prompt

Your system prompt (resume + job description + instructions) is **identical** for every answer in a session. With Anthropic/OpenRouter prompt caching, you can cache it:

```typescript
// session.service.ts
async function getOrBuildSystemPrompt(sessionId: string, context) {
  // Cache key = sessionId (prompt only changes if context changes)
  const cacheKey = `sysprompt:${sessionId}`;
  const cached = await redis.get(cacheKey);
  
  if (cached) {
    return {
      content: cached,
      cacheHit: true  // Anthropic cache_control: {"type": "ephemeral"}
    };
  }
  
  const prompt = buildSystemMessage(context);
  await redis.set(cacheKey, prompt, "EX", 3600);
  
  return { content: prompt, cacheHit: false };
}

// In AI call:
input: [
  {
    role: "system",
    content: systemPrompt,
    // Anthropic: mark for caching
    cache_control: { type: "ephemeral" }
  },
  {
    role: "user", 
    content: userMessage   // Only this changes per request
  }
]
```

**Impact**: 60-70% token reduction on repeated calls within a session. Meaningful latency reduction on Anthropic models specifically.

---

## Revised Architecture Diagram

```
Interviewer speaks
       │
       ▼
┌─────────────────────┐
│ Transcript Buffer    │  ← Continuous chunk accumulation
│ + Silence Detection  │
└──────────┬──────────┘
           │ question completion detected (silence/pattern)
           │ OR user clicks AI Answer
           ▼
┌─────────────────────────────────────────────────────┐
│              PARALLEL LAUNCH (t=0)                   │
├───────────────┬──────────────────┬──────────────────┤
│ Fast Classify │  Context Fetch   │ Thread Lookup    │
│ (~200ms)      │  (tiered, ~200ms)│ (~20ms, Redis)   │
└───────┬───────┴────────┬─────────┴────────┬─────────┘
        │                │                  │
        └────────────────┼──────────────────┘
                         │ all ready (~250ms)
                         ▼
              ┌─────────────────────┐
              │  Prompt Assembly    │  ← ~30ms, pure CPU
              │  (tiered + cached   │
              │   system prompt)    │
              └──────────┬──────────┘
                         │
                         ▼
              ┌─────────────────────┐
              │   Stream to LLM     │  ← first token ~300ms after click
              │   (OpenRouter)      │
              └──────────┬──────────┘
                         │ chunks
                         ▼
              ┌─────────────────────┐
              │  Frontend SSE       │  ← user sees text immediately
              └──────────┬──────────┘
                         │ on complete
                         ▼
              ┌─────────────────────┐
              │  Save + Thread      │  ← async, non-blocking
              │  Update (Redis+DB)  │
              └─────────────────────┘
```

---

## Priority Order for Implementation

Given your current codebase, here's what to do first for the highest ROI:

**Week 1 — biggest latency wins:**
1. Parallelize classification + context fetch (Step 2 above) — 30 min change, ~600ms saved
2. Implement context tiering (Step 5) — 1-2 hours, ~300ms saved on technical questions

**Week 2 — reliability wins:**
3. Replace regex classifier with micro-LLM (Step 1) — eliminates the majority of wrong classifications
4. Add Redis thread store for follow-up linking (Step 3) — eliminates the scoring heuristic

**Week 3 — quality of life:**
5. Auto-question detection from transcript (Step 4) — enables hands-free mode
6. Prompt caching (Step 6) — cost reduction + minor latency improvement

The parallel pipeline + context tiering alone will get you from ~1.8s to first token down to under ~500ms, which is the threshold where it stops feeling like "waiting" in an interview context.