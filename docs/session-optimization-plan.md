# Session Architecture Optimization Plan

## Executive Summary

This document outlines an incremental, phased approach to optimize the ScribeShade session architecture. The goal is to reduce latency from ~1.8s to first token down to under 500ms while improving follow-up detection reliability, all without breaking existing functionality.

**Key Principles:**
- Incremental deployment with feature flags
- Zero breaking changes to existing session flow
- Clear rollback paths for each phase
- Comprehensive testing before each phase rollout
- Gradual migration from old to new systems

---

## Current State Analysis

### Existing Flow
```
Click → 600ms debounce → detect question → regex classify 
      → AI decision (OpenRouter round-trip) → build context 
      → build prompt → AI generate → stream
```

**Current Latency Breakdown:**
- Frontend debounce: 600ms
- Question detection: ~50ms
- Regex classification: ~10ms
- AI decision (OpenRouter): ~400ms
- Context building (DB + RAG): ~300-500ms
- Prompt construction: ~50ms
- AI generation (first token): ~300ms
- **Total to first token: ~1.7-1.9s**

### Current Issues
1. **Sequential pipeline** — Each step waits for the previous to complete
2. **Regex classification** — Brittle patterns miss contextual follow-ups
3. **Follow-up scoring** — Heuristic scoring instead of semantic understanding
4. **Always-full context** — Fetches resume/docs/projects even for simple technical questions
5. **No prompt caching** — Re-sends identical system prompts

---

## Optimization Phases

### Phase 1: Parallel Pipeline (Low Risk, High Impact)

**Objective:** Parallelize independent operations to reduce sequential latency

**Estimated Impact:** ~600ms latency reduction

**Risk Level:** Low (pure refactoring, no behavior change)

---

#### 1.1 Parallel Context Building

**Files to Modify:**
- `src/features/session/session.service.ts` (lines 1176-1243)

**Implementation:**

```typescript
// session.service.ts

// BEFORE (sequential):
const context = await buildOptimizedContext(sessionId, { ... });
const history = toAnswerHistory((session as any).messages);
const guard = guardCurrentQuestion({ ... });

// AFTER (parallel):
const [context, history, guard] = await Promise.all([
  buildOptimizedContext(sessionId, { ... }),
  Promise.resolve(toAnswerHistory((session as any).messages)),
  Promise.resolve(guardCurrentQuestion({ ... })),
]);
```

**Feature Flag:**
```typescript
// src/config/env.ts
ENABLE_PARALLEL_PIPELINE: z.boolean().default(true),
```

**Rollback Plan:**
- Set `ENABLE_PARALLEL_PIPELINE=false` to revert to sequential behavior
- No data migration needed

**Testing:**
- Unit test: Verify context, history, and guard produce identical results
- Integration test: Compare AI answers with flag on/off
- Load test: Verify no race conditions under concurrent requests

---

#### 1.2 Parallel AI Decision with Context

**Files to Modify:**
- `src/features/session/session.service.ts` (lines 1269-1300)

**Implementation:**

```typescript
// session.service.ts

// AFTER parallel context building, launch AI decision in parallel
const [aiDecisionResult, classification, followup] = await Promise.all([
  decideAISessionState({ ... }),
  Promise.resolve(classifyConversationIntent(guard.resolvedCurrentQuestion)),
  Promise.resolve(resolveFollowupTarget({ ... })),
]);
```

**Feature Flag:**
```typescript
// Reuse ENABLE_PARALLEL_PIPELINE flag
```

**Rollback Plan:**
- Same flag controls both 1.1 and 1.2
- Fallback to sequential if flag disabled

**Testing:**
- Verify AI decision produces identical results
- Test with both low and high-latency AI providers

---

### Phase 2: Context Tiering (Medium Risk, High Impact)

**Objective:** Skip unnecessary context fetches for simple technical questions

**Estimated Impact:** ~300ms latency reduction on 80% of questions

**Risk Level:** Medium (behavior change, but with safe fallback)

---

#### 2.1 Intent-Based Tier Selection

**New File:**
- `src/features/session/context-tier.ts`

**Implementation:**

```typescript
// context-tier.ts

export type ContextTier = "minimal" | "resume" | "full";

export function selectContextTier(
  intent: ConversationIntent,
  cieComplexity?: string
): ContextTier {
  // Pure technical questions — minimal context
  if (
    intent === "EXPLAIN_CODE" ||
    intent === "DEBUG_CODE" ||
    intent === "OPTIMIZE_CODE" ||
    cieComplexity === "simple_atomic"
  ) {
    return "minimal";
  }

  // Behavioral/experience questions — need resume
  if (
    intent === "EXPERIENCE_QUESTION" ||
    cieComplexity === "simple_contextual"
  ) {
    return "resume";
  }

  // Complex scenarios — full context
  if (
    intent === "SCENARIO_QUESTION" ||
    cieComplexity === "scenario_based"
  ) {
    return "full";
  }

  // Default to resume for safety
  return "resume";
}
```

---

#### 2.2 Tiered Context Builder

**Modified File:**
- `src/features/session/session.service.ts` (lines 1176-1243)

**Implementation:**

```typescript
// session.service.ts

async function buildTieredContext(
  sessionId: string,
  tier: ContextTier,
  session: Session
): Promise<ContextData> {
  const base = {
    jobDescription: session.jobDescription,
    language: session.language,
    simpleLanguage: session.simpleLanguage,
  };

  if (tier === "minimal") {
    return base;
  }

  if (tier === "resume") {
    const resume = session.resumeId
      ? await fetchResume(session.resumeId)
      : null;
    return { ...base, resume };
  }

  // Full tier
  const [resume, docs, projects] = await Promise.all([
    session.resumeId ? fetchResume(session.resumeId) : Promise.resolve(null),
    session.documentId ? fetchDocument(session.documentId) : Promise.resolve(null),
    session.projectIds?.length ? fetchProjects(session.projectIds) : Promise.resolve([]),
  ]);

  return { ...base, resume, docs, projects };
}
```

**Feature Flag:**
```typescript
// src/config/env.ts
ENABLE_CONTEXT_TIERING: z.boolean().default(false),
```

**Rollback Plan:**
- Set `ENABLE_CONTEXT_TIERING=false` to always use full context
- No data migration needed

**Testing:**
- A/B test: Compare answers with tiering vs full context
- Verify technical questions produce correct answers with minimal context
- Verify behavioral questions still get resume context

---

### Phase 3: Micro-LLM Classifier (Medium Risk, Medium Impact)

**Objective:** Replace brittle regex patterns with semantic classification

**Estimated Impact:** Improved follow-up detection accuracy (not latency-focused)

**Risk Level:** Medium (introduces new AI dependency, but with fallback)

---

#### 3.1 Micro-LLM Classification Service

**New File:**
- `src/features/session/micro-classifier.ts`

**Implementation:**

```typescript
// micro-classifier.ts

export interface MicroClassificationResult {
  intent: ConversationIntent;
  needsPreviousCode: boolean;
  needsPreviousAnswer: boolean;
  confidence: number;
}

export async function classifyWithMicroLLM(
  question: string,
  recentTranscript: string,
  lastAiAnswer: string
): Promise<MicroClassificationResult> {
  const prompt = `Classify this interview question.

Recent transcript (last 400 chars):
${recentTranscript.slice(-400)}

Last AI answer topic (first 150 chars):
${lastAiAnswer.slice(0, 150)}

New question: "${question}"

Respond with JSON only:
{
  "intent": "EXPLAIN_CODE|DEBUG_CODE|OPTIMIZE_CODE|EXPERIENCE_QUESTION|SCENARIO_QUESTION|FOLLOW_UP|NEW_QUESTION|UNKNOWN",
  "needsPreviousCode": true|false,
  "needsPreviousAnswer": true|false,
  "confidence": 0.0-1.0
}`;

  try {
    const result = await ai.callModel({
      model: "google/gemini-flash-1.5-8b", // Fast, cheap
      maxOutputTokens: 80,
      input: [{ role: "user", content: prompt }],
    });

    return JSON.parse(result);
  } catch (error) {
    // Fallback to regex on error
    console.error("Micro-LLM classification failed, falling back to regex", error);
    return {
      intent: classifyConversationIntent(question),
      needsPreviousCode: false,
      needsPreviousAnswer: false,
      confidence: 0.5,
    };
  }
}
```

---

#### 3.2 Hybrid Classification (Micro-LLM + Regex Fallback)

**Modified File:**
- `src/features/session/session.service.ts` (lines 1269-1300)

**Implementation:**

```typescript
// session.service.ts

const classificationPromise = ENABLE_MICRO_CLASSIFIER
  ? classifyWithMicroLLM(
      guard.resolvedCurrentQuestion,
      liveContextMetadata?.recentTranscriptWindow?.join("\n") ?? "",
      liveContextMetadata?.previousAiAnswer ?? ""
    )
  : Promise.resolve({
      intent: classifyConversationIntent(guard.resolvedCurrentQuestion),
      needsPreviousCode: false,
      needsPreviousAnswer: false,
      confidence: 0.5,
    });
```

**Feature Flag:**
```typescript
// src/config/env.ts
ENABLE_MICRO_CLASSIFIER: z.boolean().default(false),
MICRO_CLASSIFIER_MODEL: z.string().default("google/gemini-flash-1.5-8b"),
```

**Rollback Plan:**
- Set `ENABLE_MICRO_CLASSIFIER=false` to use regex only
- Fallback to regex on micro-LLM error (automatic)

**Testing:**
- Compare classification results with regex baseline
- Test with edge cases (vague follow-ups, mixed intents)
- Monitor micro-LLM latency and error rates

---

### Phase 4: Redis Thread Store (Medium Risk, Medium Impact)

**Objective:** Replace heuristic follow-up scoring with semantic thread linking

**Estimated Impact:** Improved follow-up target resolution accuracy

**Risk Level:** Medium (introduces Redis dependency, but with DB fallback)

---

#### 4.1 Thread Data Structure

**New File:**
- `src/features/session/thread-store.ts`

**Implementation:**

```typescript
// thread-store.ts

export interface ConversationThread {
  turnId: string;
  question: string;
  answerSummary: string;
  codeLanguage?: string;
  topicVector?: number[];
  childTurnIds: string[];
  timestamp: number;
}

export async function saveTurnToThread(
  sessionId: string,
  turn: {
    id: string;
    question: string;
    answer: string;
  }
): Promise<void> {
  const key = `thread:${sessionId}`;
  const existing = await redis.get(key);
  const thread: ConversationThread[] = existing ? JSON.parse(existing) : [];

  // Generate embedding (can use existing RAG embedding service)
  const embedding = await embedText(`${turn.question} ${turn.answer.slice(0, 300)}`);

  thread.push({
    turnId: turn.id,
    question: turn.question,
    answerSummary: turn.answer.slice(0, 100),
    codeLanguage: detectCodeLanguage(turn.answer),
    topicVector: embedding,
    childTurnIds: [],
    timestamp: Date.now(),
  });

  // Keep only last 10 turns
  const trimmed = thread.slice(-10);
  await redis.set(key, JSON.stringify(trimmed), "EX", 7200);
}
```

---

#### 4.2 Semantic Follow-up Resolution

**Modified File:**
- `src/features/session/answer-quality.ts` (lines 397-565)

**Implementation:**

```typescript
// answer-quality.ts

export async function resolveFollowupTargetWithThread(
  question: string,
  sessionId: string
): Promise<FollowupTargetResult> {
  if (!ENABLE_THREAD_STORE) {
    // Fallback to existing scoring-based resolution
    return resolveFollowupTarget({ ... });
  }

  const thread = await getThread(sessionId);
  if (!thread?.length) {
    return { target: null, source: "none", targetConfidence: 0, reasonForNoTarget: "no_thread" };
  }

  // Embed current question
  const qEmbed = await embedText(question);

  let bestMatch = null;
  let bestScore = 0;

  for (const turn of thread.slice(-5)) {
    if (!turn.topicVector) continue;
    const score = cosineSimilarity(qEmbed, turn.topicVector);
    if (score > 0.75 && score > bestScore) {
      bestMatch = turn;
      bestScore = score;
    }
  }

  // Hard rule: explicit code reference → use last code turn
  const hasExplicitRef = /\b(this|that|same|the) (code|query|function|approach)\b/i.test(question);
  if (hasExplicitRef) {
    const lastCodeTurn = [...thread].reverse().find(t => t.codeLanguage);
    if (lastCodeTurn) {
      return {
        target: { id: lastCodeTurn.turnId, ... },
        source: "explicit_code_ref",
        targetConfidence: 0.9,
      };
    }
  }

  if (bestMatch) {
    return {
      target: { id: bestMatch.turnId, ... },
      source: "semantic_match",
      targetConfidence: bestScore,
    };
  }

  return { target: null, source: "none", targetConfidence: 0, reasonForNoTarget: "low_similarity" };
}
```

**Feature Flag:**
```typescript
// src/config/env.ts
ENABLE_THREAD_STORE: z.boolean().default(false),
THREAD_TTL_SECONDS: z.number().default(7200),
```

**Rollback Plan:**
- Set `ENABLE_THREAD_STORE=false` to use scoring-based resolution
- Redis failure automatically falls back to DB-based resolution

**Testing:**
- Compare follow-up target resolution with scoring baseline
- Test with explicit code references
- Monitor Redis memory usage

---

### Phase 5: Auto-Question Detection (Low Risk, Low Impact)

**Objective:** Detect question completion from transcript stream for auto-answer mode

**Estimated Impact:** Enables hands-free mode (not latency-focused)

**Risk Level:** Low (new feature, doesn't affect existing click-to-answer flow)

---

#### 5.1 Question Completion Detector

**New File:**
- `src/features/session/question-detector.ts`

**Implementation:**

```typescript
// question-detector.ts

const QUESTION_END_SIGNALS = [
  /\?$/,
  /\bthoughts?\b.*\.$/i,
  /\bhow would you\b.*[.?]$/i,
  /\bwhat (?:is|are|would|do you)\b.*[.?]$/i,
  /\btell me about\b.*\.$/i,
];

export interface DetectedQuestion {
  text: string;
  triggerType: "pattern" | "silence";
  timestamp: number;
}

export function detectQuestionCompletion(
  buffer: TranscriptChunk[],
  silenceGapMs: number
): DetectedQuestion | null {
  const recentText = buffer
    .slice(-8)
    .map(c => c.text)
    .join(" ")
    .trim();

  const matchedPattern = QUESTION_END_SIGNALS.some(re => re.test(recentText));
  const hasSignificantSilence = silenceGapMs > 1200;
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

---

#### 5.2 Frontend Integration

**Modified File:**
- `src/features/session/hooks/useFloatingSession.ts`

**Implementation:**

```typescript
// useFloatingSession.ts

const detectedQuestion = useMemo(() => {
  if (!ENABLE_AUTO_QUESTION_DETECTION) return null;
  return detectQuestionCompletion(
    transcriptBuffer,
    currentSilenceGapMs
  );
}, [transcriptBuffer, currentSilenceGapMs]);

// Auto-trigger AI answer if detected and auto-mode enabled
useEffect(() => {
  if (detectedQuestion && autoAnswerModeEnabled && !isAnswering) {
    handleAiAnswerClick({ sessionId: currentSessionId });
  }
}, [detectedQuestion, autoAnswerModeEnabled]);
```

**Feature Flag:**
```typescript
// src/config/env.ts (frontend)
VITE_ENABLE_AUTO_QUESTION_DETECTION: z.boolean().default(false),
```

**Rollback Plan:**
- Set flag to false to disable auto-detection
- Does not affect manual click-to-answer flow

**Testing:**
- Test with various question patterns
- Tune silence threshold to avoid false positives
- Verify auto-mode can be toggled on/off

---

### Phase 6: Prompt Caching (Low Risk, Low Impact)

**Objective:** Cache system prompts to reduce token usage and latency

**Estimated Impact:** 60-70% token reduction, minor latency improvement

**Risk Level:** Low (cache miss just rebuilds prompt)

---

#### 6.1 System Prompt Cache

**Modified File:**
- `src/features/session/session.service.ts`

**Implementation:**

```typescript
// session.service.ts

async function getOrBuildSystemPrompt(
  sessionId: string,
  context: ContextData
): Promise<{ content: string; cacheHit: boolean }> {
  if (!ENABLE_PROMPT_CACHING) {
    return { content: buildSystemMessage(context), cacheHit: false };
  }

  const cacheKey = `sysprompt:${sessionId}:${hashContext(context)}`;
  const cached = await redis.get(cacheKey);

  if (cached) {
    return { content: cached, cacheHit: true };
  }

  const prompt = buildSystemMessage(context);
  await redis.set(cacheKey, prompt, "EX", 3600);

  return { content: prompt, cacheHit: false };
}

// In AI call:
const { content: systemPrompt, cacheHit } = await getOrBuildSystemPrompt(sessionId, contextForCall);

input: [
  {
    role: "system",
    content: systemPrompt,
    // Anthropic cache control
    ...(cacheHit ? {} : { cache_control: { type: "ephemeral" } }),
  },
  { role: "user", content: userMessage },
];
```

**Feature Flag:**
```typescript
// src/config/env.ts
ENABLE_PROMPT_CACHING: z.boolean().default(false),
PROMPT_CACHE_TTL_SECONDS: z.number().default(3600),
```

**Rollback Plan:**
- Set flag to false to disable caching
- Cache miss transparently rebuilds prompt

**Testing:**
- Monitor cache hit rate
- Verify cached prompts produce identical answers
- Test with context changes (cache invalidation)

---

## Implementation Timeline

### Week 1: Parallel Pipeline + Context Tiering
- **Day 1-2**: Phase 1.1 (Parallel context building)
- **Day 3-4**: Phase 1.2 (Parallel AI decision)
- **Day 5**: Phase 2.1-2.2 (Context tiering)
- **Day 5**: Testing and validation

### Week 2: Micro-LLM Classifier + Thread Store
- **Day 1-2**: Phase 3.1-3.2 (Micro-LLM classifier)
- **Day 3-4**: Phase 4.1-4.2 (Redis thread store)
- **Day 5**: Testing and validation

### Week 3: Auto-Question Detection + Prompt Caching
- **Day 1-2**: Phase 5.1-5.2 (Auto-question detection)
- **Day 3-4**: Phase 6.1 (Prompt caching)
- **Day 5**: End-to-end testing and documentation

---

## Testing Strategy

### Unit Tests
- Each new function with feature flag logic
- Fallback paths (micro-LLM error, Redis failure)
- Context tier selection logic

### Integration Tests
- Compare AI answers with flags on/off
- Verify parallel operations produce identical results
- Test Redis thread store with real sessions

### Load Tests
- Verify no race conditions with parallel pipeline
- Test Redis under concurrent thread writes
- Monitor micro-LLM rate limits

### A/B Tests
- Gradual rollout with 10% → 50% → 100% traffic
- Compare latency metrics
- Compare follow-up detection accuracy

---

## Monitoring and Metrics

### Latency Metrics
- Time to first token (TTFB)
- Context building time
- Classification time
- AI generation time

### Accuracy Metrics
- Follow-up detection accuracy (manual sample)
- Context tier appropriateness (manual sample)
- Micro-LLM vs regex classification agreement

### Error Metrics
- Micro-LLM fallback rate
- Redis failure rate
- Cache hit/miss rate

---

## Rollback Procedures

### Per-Phase Rollback
1. Set feature flag to `false`
2. Monitor for 5 minutes
3. If issues persist, restart backend services

### Full Rollback
1. Set all feature flags to `false`
2. Clear Redis caches
3. Restart backend services
4. Verify baseline functionality

---

## Success Criteria

### Phase 1 (Parallel Pipeline)
- Time to first token reduced by ~600ms
- No regression in answer quality
- No increase in error rate

### Phase 2 (Context Tiering)
- Time to first token reduced by additional ~300ms on technical questions
- No regression in behavioral question answers
- 80% of questions use minimal/resume tiers

### Phase 3 (Micro-LLM Classifier)
- Follow-up detection accuracy improved by 20%+
- Micro-LLM latency < 250ms
- Fallback rate < 5%

### Phase 4 (Redis Thread Store)
- Follow-up target resolution accuracy improved by 15%+
- Redis memory usage < 100MB per 1000 sessions
- Thread store latency < 50ms

### Phase 5 (Auto-Question Detection)
- False positive rate < 10%
- Detection latency < 100ms
- Auto-mode can be toggled without issues

### Phase 6 (Prompt Caching)
- Cache hit rate > 70%
- Token usage reduced by 50%+
- No answer quality regression

---

## Dependencies

### New Dependencies
- None (uses existing Redis, OpenRouter, embedding service)

### Existing Dependencies
- Redis (already used for BullMQ)
- OpenRouter (already used for AI)
- Embedding service (already used for RAG)

---

## Risks and Mitigations

### Risk: Parallel Pipeline Race Conditions
**Mitigation:**
- Comprehensive unit tests
- Feature flag for easy rollback
- Load testing before rollout

### Risk: Context Tiering Misses Needed Context
**Mitigation:**
- Conservative tier selection (default to resume)
- Feature flag for easy rollback
- Manual review of tier assignments

### Risk: Micro-LLM Latency
**Mitigation:**
- Use fastest model (Gemini Flash)
- Automatic fallback to regex
- Monitor latency and error rates

### Risk: Redis Thread Store Memory
**Mitigation:**
- Limit thread length (10 turns)
- TTL expiration (2 hours)
- Monitor memory usage

### Risk: Auto-Question Detection False Positives
**Mitigation:**
- Conservative thresholds
- User toggle for auto-mode
- Manual review of detections

---

## Post-Implementation Tasks

1. Update documentation
2. Update API reference
3. Train support team on new features
4. Update monitoring dashboards
5. Create runbooks for rollback procedures
