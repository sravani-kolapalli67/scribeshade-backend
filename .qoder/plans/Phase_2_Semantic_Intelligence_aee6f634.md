# Phase 2: Semantic Classification, Scenario Grouping & Unified AI Reasoning

## Problem Root Cause

The primary issue is in `src/pages/Sessions/ActiveSession/page.tsx` (lines 47-82, 532-563):
1. `segmentQuestions()` splits transcript on `?`, numbered patterns, and newlines
2. The auto-answer flow then fires SEPARATE `handleAiAnswer()` calls for EACH segment (staggered 500ms)
3. This causes "Design a system... How would you scale... How would you cache..." to become 3 independent AI calls with 3 cards

The backend already handles multi-question in a single call properly (prompt Rule 7 + `===NEXT_QUESTION===` markers). The fix is primarily frontend: prevent premature splitting, add semantic classification, and route grouped scenarios as ONE request.

---

## Task 1: Create Transcript Stabilization Layer (Frontend)

**New file:** `src/lib/transcript-stabilizer.ts`

Purpose: Debounced freeze window that prevents AI triggering while STT is still mutating.

```ts
// Core exports:
stabilizeTranscript(rawTranscript: string, onStable: (snapshot: string) => void): void
cancelStabilization(): void
isStabilizing(): boolean
```

**Behavior:**
- 1200ms inactivity window (configurable) after last transcript mutation
- Produces an immutable frozen snapshot once stable
- Tracks timestamp of last mutation for continuation detection
- Integrates with existing debounce in page.tsx (replaces the 500ms DEBOUNCE_MS)

**Integration point:** Replace the direct debounce timer in `page.tsx` auto-answer flow (line ~540) with `stabilizeTranscript()`.

---

## Task 2: Create Semantic Question Classifier (Frontend)

**New file:** `src/lib/semantic-classifier.ts`

Purpose: Lightweight heuristic-based classification (NO LLM calls, NO extra costs).

```ts
// Core exports:
type QuestionType = 'scenario' | 'independent' | 'behavioral_star' | 'system_design' | 'follow_up' | 'continuation' | 'noise';

interface ClassificationResult {
  type: QuestionType;
  shouldGroup: boolean;
  segments: string[];  // If independent: split segments. If grouped: single element.
  confidence: number;
}

classifyTranscript(transcript: string, previousContext?: string): ClassificationResult
```

**Classification heuristics (no AI cost):**
- **Scenario markers:** "Suppose...", "Imagine...", "Design a...", "Build a...", "What would you do if...", "Let's say..."
- **System design markers:** "scale", "architecture", "database", "cache", "load balancer", "microservices" co-occurring with scenario markers
- **Dependency detection:** Multiple sub-questions sharing a common subject/scenario preamble
- **STAR markers:** "Tell me about a time...", "Describe a situation where...", "Give me an example of..."
- **Follow-up markers:** "And how would you...", "What about...", "Also...", "Then how..."
- **Independence detection:** Questions with ZERO shared context nouns (different subjects entirely)
- **Noise detection:** Very short fragments (< 5 words), repeated STT artifacts

**Key rule:** If ANY scenario/system-design markers are detected, the ENTIRE transcript is grouped as ONE question regardless of internal `?` characters.

---

## Task 3: Create Scenario Grouping Engine (Frontend)

**New file:** `src/lib/grouped-question-engine.ts`

Purpose: Implements `isScenarioBasedQuestion()` and dependency-chain scoring.

```ts
// Core exports:
isScenarioBasedQuestion(transcript: string): boolean
scoreDependencyChain(segments: string[]): number  // 0-1, high = dependent
splitIndependentQuestions(transcript: string, classification: ClassificationResult): string[]
```

**Grouping rules:**
- If transcript contains scenario preamble + multiple follow-up questions -> ONE group
- If all questions share a common architectural context -> ONE group  
- If questions are clearly independent (different subjects, no shared nouns) -> SPLIT
- Dependency chain scoring uses: shared noun overlap, temporal proximity, pronoun references ("it", "that", "this system")

**splitIndependentQuestions()** only splits when:
- Confidence of independence > 0.7
- No shared scenario context
- No pronoun back-references between segments

---

## Task 4: Create Stream Orchestration Guard (Frontend)

**New file:** `src/lib/stream-orchestrator.ts`

Purpose: Prevent duplicate stream cards and manage generation locking.

```ts
// Core exports:
interface GenerationGuard {
  canStartGeneration(segmentId: string): boolean;
  lockGeneration(segmentId: string): void;
  releaseGeneration(segmentId: string): void;
  isGenerationActive(): boolean;
  getActiveSegmentId(): string | null;
}

createGenerationGuard(): GenerationGuard
```

**Behavior:**
- Maintains a Set of active segment IDs
- Prevents duplicate card creation for same semantic group
- For grouped scenarios: locks into single container, prevents child streams
- Integrates with existing `startNewRequest()` abort logic in useAIChat.ts

---

## Task 5: Create Continuation Detection (Frontend)

**Add to:** `src/lib/semantic-classifier.ts`

```ts
isContinuationOfPreviousQuestion(
  newTranscript: string, 
  previousTranscript: string, 
  timeDeltaMs: number
): boolean
```

**Detection logic:**
- Time proximity: < 8000ms between last question end and new transcript start
- Semantic similarity: normalized token overlap > 0.3
- Pronoun references: "it", "that", "this" without clear antecedent in new text alone
- Follow-up markers: "And...", "Also...", "What about...", "How about..."
- Shared subject nouns between previous and new transcript

**Integration:** When continuation detected, MERGE with previous transcript and re-classify as grouped.

---

## Task 6: Create Unified Generation Pipeline (Frontend)

**New file:** `src/lib/generation-pipeline.ts`

Purpose: Single entry point for ALL AI generation flows (mic, manual, regenerate).

```ts
// Core exports:
interface GenerationInput {
  transcript: string;
  mode: 'mic' | 'manual' | 'regenerate' | 'screenshot';
  sessionId: string;
  aiModel: string;
  snapshotId?: string;
  isCustomQuery?: boolean;
}

interface GenerationDecision {
  shouldGenerate: boolean;
  groupedTranscript: string;
  segmentCount: number;
  classification: ClassificationResult;
  reason?: string;  // Why generation was deferred/blocked
}

async function prepareGeneration(input: GenerationInput, previousContext?: string): Promise<GenerationDecision>
```

**Pipeline order:**
1. `stabilizeTranscript()` (wait for freeze)
2. `normalizeSttTranscript()` (existing — reused)
3. `deduplicateQuestionsInText()` (existing — reused)
4. `classifyTranscript()` (new semantic classification)
5. If scenario/grouped: return single transcript, segmentCount=1
6. If independent: return split segments with segmentCount > 1
7. Return `GenerationDecision`

---

## Task 7: Integrate Pipeline into useAIChat.ts

**Modified file:** `src/hooks/useAIChat.ts`

**Changes:**
1. Import new pipeline: `prepareGeneration()`, `createGenerationGuard()`
2. Modify `handleAiAnswer()` to route through `prepareGeneration()` before calling `handleAiAnswerSingle()`
3. Add generation guard check before creating placeholder cards
4. For grouped scenarios: create ONE placeholder, send ONE request
5. For independent: maintain current multi-card behavior (but via pipeline decision, not regex splitting)
6. Preserve ALL existing exports, state shape, and return types

**Key constraint:** The `consumeSegmentedStream()` function remains UNCHANGED — backend still controls `===NEXT_QUESTION===` splitting for independent questions within a single request.

---

## Task 8: Integrate Pipeline into ActiveSession page.tsx

**Modified file:** `src/pages/Sessions/ActiveSession/page.tsx`

**Changes:**
1. Replace `segmentQuestions()` usage in auto-answer flow (lines 532-563) with:
   - `stabilizeTranscript()` instead of raw 500ms debounce
   - `classifyTranscript()` instead of regex-based splitting
   - Route through `prepareGeneration()` for decision
2. If `classification.shouldGroup === true`: call `handleAiAnswer()` ONCE with full transcript
3. If `classification.shouldGroup === false`: call for each independent segment (existing stagger behavior)
4. Add continuation detection: if new transcript arrives within 8s of previous, check `isContinuationOfPreviousQuestion()` and merge if true

**Preserved:** The `segmentQuestions()` function definition stays (backward compat) but is no longer called in the auto-answer hot path.

---

## Task 9: AI Trigger Intelligence

**Add to:** `src/lib/generation-pipeline.ts`

```ts
function shouldTriggerGeneration(input: {
  transcript: string;
  isStable: boolean;
  classification: ClassificationResult;
  lastGenerationTimestamp: number;
  recentQuestions: Array<{q: string; t: number}>;
}): { trigger: boolean; reason: string }
```

**Evaluation criteria:**
- Transcript must be stable (freeze window passed)
- Transcript must not be a continuation (merge instead)
- No exact duplicate within 4s window (existing recentQuestionsRef logic)
- Semantic completeness: transcript is at least 3 words
- NOT a noise classification

**Critical rule:** AI Answer BUTTON always bypasses this check and triggers immediately (user intent is explicit). This only gates AUTO-triggering from mic/tab transcript.

---

## Task 10: Backend Prompt Optimization for Grouped Scenarios

**Modified file:** `/backend/src/shared/lib/prompt.ts`

**Changes to `buildUserMessage()` (Normal Mode):**
- Add instruction: "If the input is a SINGLE scenario-based or system-design question with multiple sub-parts, provide ONE unified structured answer with numbered sections. Do NOT split into separate ===NEXT_QUESTION=== blocks."
- Add detection hint: "If sub-questions are dependent on a shared scenario (e.g., 'Design X... How would you scale... How would you cache...'), treat as ONE question and answer holistically."

This ensures that even if the frontend correctly identifies a grouped scenario and sends it as one transcript, the LLM doesn't re-split it into multiple `===NEXT_QUESTION===` blocks.

---

## Execution Order & Dependencies

```
Task 1 (Stabilizer)          ──┐
Task 2 (Classifier)          ──┼── Can run in parallel (independent new files)
Task 3 (Grouping Engine)     ──┤
Task 4 (Stream Guard)        ──┘
         │
         ▼
Task 5 (Continuation)        ── Depends on Task 2 (extends same file)
Task 6 (Pipeline)            ── Depends on Tasks 1-4 (imports all)
         │
         ▼
Task 7 (useAIChat integration)   ── Depends on Task 6
Task 8 (page.tsx integration)    ── Depends on Tasks 6, 7
Task 9 (Trigger Intelligence)    ── Depends on Task 6 (extends same file)
Task 10 (Backend prompt)         ── Independent, can run with Tasks 7-9
```

---

## Files Summary

**New files (frontend):**
- `src/lib/transcript-stabilizer.ts`
- `src/lib/semantic-classifier.ts`
- `src/lib/grouped-question-engine.ts`
- `src/lib/stream-orchestrator.ts`
- `src/lib/generation-pipeline.ts`

**Modified files (frontend):**
- `src/hooks/useAIChat.ts` — Route through unified pipeline
- `src/pages/Sessions/ActiveSession/page.tsx` — Replace segmentQuestions in auto-answer flow

**Modified files (backend):**
- `src/shared/lib/prompt.ts` — Add grouped-scenario instruction to user message

---

## Safety & Compatibility Guarantees

- All new code is in separate files (adapter pattern)
- Existing `consumeSegmentedStream()` UNCHANGED
- Existing `===NEXT_QUESTION===` protocol UNCHANGED  
- Existing SSE events UNCHANGED
- Existing regenerate flow UNCHANGED (passes through pipeline transparently)
- Existing Message interface UNCHANGED
- Existing Redux state shape UNCHANGED
- No new OpenRouter calls (all classification is heuristic-based)
- No breaking changes to backend API contract
- `segmentQuestions()` function preserved for backward compat
- All existing deduplication layers remain active