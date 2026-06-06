# Implementation Plan

[Overview]
Refactor ScribeShade’s Session module into a **Session-State-First** modular monolith with **async workers** that enforces strict transcript-evidence routing, eliminates stale selected-card/previous-answer pollution, and upgrades to a **SessionStateV3 + ContextRouterV3 + (async) vector RAG** architecture with robust post-stream validation.

This refactor keeps the current TypeScript/Express backend, uses PostgreSQL as canonical truth, uses Redis/BullMQ as the hot async layer, and keeps **OpenRouter streaming** as the single main model call per `/session/:id/ai-answer` click. The click path must become deterministic and read-only with respect to state inference; any embeddings and indexing happen in background jobs/streams only.

Key authority chain (non-negotiable):
- **Transcript is source of truth**
- **LiveRequestSanitizerV4** is the sole authority on *what can be used right now*
- **SessionStateV3** decides *what is happening now*
- **ContextRouterV3** decides *what context/memory is allowed*
- **RAG** is supporting-only (never question authority)
- **AnswerValidationGate** decides persistence/memory trust after the stream, without silently deleting valid streamed UI output

[Types]
Introduce/align contracts for sanitizer → state → routing → runtime prompt assembly → validation.

Sanitizer (authoritative contract)
- `LiveRequestKind`
  - `"latest_question" | "true_followup" | "selected_card_followup" | "regenerate" | "code_generation" | "code_followup" | "scenario" | "project_question" | "challenge_or_correction" | "provisional_guidance" | "noise"`
- `SanitizedLiveRequest`
  - `kind: LiveRequestKind`
  - `effectiveAnswerClickMode: string`
  - `metadata: AIAnswerLiveContextMetadata`
  - `latestQuestionHint?: string`
  - `clearReason?: string`
  - `allowSelectedAnswer: boolean`
  - `allowPreviousAnswer: boolean`
  - `allowPreviousAnswers: boolean`
  - `allowCodeMemory: boolean`
  - `allowProjectContext: boolean`
  - `allowHistory: boolean`
  - `answerKind: "provisional" | "final" | "followup" | "regenerate" | "correction"`
  - `answerTrust: "none" | "weak" | "strong"`
  - Additionally log fields (see below)

Session hot state
- `SessionStateV3`
  - `sessionId: string`
  - `activeTopic?: string`
  - `latestCleanQuestion?: string`
  - `questionChain: string[]`
  - `askState: "setup_in_progress" | "answerable_question" | "provisional_guidance" | "true_followup" | "challenge_or_correction" | "topic_switch" | "code_task"`
  - `interviewerTone: "neutral" | "clarification" | "deep_dive" | "challenge" | "skeptical" | "stress_test" | "urgency"`
  - `activeScenarioId?: string`
  - `activeCodeTaskId?: string`
  - `activeFollowupTargetId?: string`
  - `updatedAt: string`

Routing output (strict)
- `RoutedAnswerContext`
  - `includeResume: boolean`
  - `includeProjects: boolean`
  - `includeHistory: boolean`
  - `includeCodeMemory: boolean`
  - `includeScenarioMemory: boolean`
  - `includeDocuments: boolean`
  - `budgets: { resume; projects; history; code; scenario; documents; total }`
  - `retrieveTypes: MemoryDoc["type"][]` (if using type-based retrieval)
  - `excludeTypes: MemoryDoc["type"][]`
  - `topicFilters: string[]`
  - `trustFilter: Array<"weak" | "strong">`

Validation gate contract
- `AnswerValidationResult`
  - `persistCard: boolean`
  - `updateMemory: boolean`
  - `trust: "none" | "weak" | "strong"`
  - `reasons: string[]`
  - **UI safety rule:** validation must rarely remove an already streamed visible card; it only gates persistence/memory trust. (It may mark “non-trusted” but should not make valid streamed cards disappear.)

RAG docs
- `MemoryDoc` (vector store payload)
  - `id, sessionId, userId`
  - `type: "transcript_turn" | "clean_question" | "qa_summary" | "code_task" | "code_block" | "scenario_packet" | "candidate_fact" | "project_fact" | "resume_fact" | "interviewer_challenge"`
  - `topic, text, speaker?, timestamp, trust`
  - optional `answerId, projectId, codeHash`
  - `embedding: number[]`

[Files]
This refactor is implemented as **3 PRs** to keep risk low and reviewable. Each PR delivers runnable functionality and leaves clear integration points.

PR 1 (Correctness): sanitizer authority + routing applied + frontend contract fixes
New:
- `src/features/session/state/live-request-sanitizer-v4.ts`
  - Deterministic sanitizer; authoritative clearing; code/scenario/challenge/noise classification priority.
- `src/features/session/context/context-router-v3.service.ts`
  - Apply router decisions strictly before prompt building.
- `src/features/session/context/runtime-context-builder.ts` (only if needed)
  - Prefer RuntimeContext v3.1; avoid RuntimeContext v4 unless schema changes are unavoidable.
- `src/features/session/validation/answer-validation-gate.ts` (lightweight gating only for UI safety if needed in PR1)

Modified (critical correctness):
- `src/features/session/ai-answer-context-guards.ts`
  - Delegate/replace to new sanitizer-v4 logic; stop preserving stale `selectedAnswer*` / `previousAi*` based solely on followup detection.
- `src/features/session/session.service.ts`
  - `/session/:id/ai-answer` click path becomes:
    - sanitize (authoritative) → read SessionStateV3 (stub ok in PR1 if not fully implemented) → router (real) → runtime context builder → ONE AI stream call → gate persistence only.
  - **RAG must come after routing is correct** (do not add embeddings before correctness).
- `src/features/session/answer-policy.ts`
  - Must not reintroduce prior answer bindings when sanitizer disallows.
- Frontend:
  - Remove stale fields from normal AI answer payload contract and fix dedupe to not drop valid streamed code cards.

PR 2 (Memory): SessionStateV3 + MemoryV3 + scenario/code extraction
New:
- `src/features/session/state/session-state-v3.service.ts`
  - Redis hot read model (async updates done elsewhere).
- `src/features/session/memory/session-memory-v3.service.ts`
  - Redis cache for SessionMemoryV3 + persistence hooks.
- `src/features/session/transcript/scenario-evidence-builder.ts`
  - Scenario setup extraction preserving setup → final ask.
- `src/features/session/memory/code-task-memory.service.ts`
  - CodeTaskMemory injection rules: only for code follow-ups / explicit code tasks.

Modified:
- `src/features/session/session.service.ts`
  - Use SessionStateV3 + MemoryV3 for runtime context.
- Async persistence/indexing jobs (BullMQ first)
  - Add jobs: memory-update, scenario-update, code-task-update.

PR 3 (RAG + Scale): Redis vector RAG + async index pipeline + replay benchmarks
New:
- Redis vector store modules:
  - `src/features/session/rag/redis-vector-store.service.ts`
  - `src/features/session/rag/session-rag-indexer.service.ts`
  - `src/features/session/rag/session-rag-retriever.service.ts`
- Replay benchmark integration test improvements
  - Extend existing replay harness; add acceptance matrix tests.

Modified:
- `src/features/session/session.service.ts`
  - Integrate retriever only after router is applied and sanitized kind is honored.
  - Ensure **no embedding happens on `/ai-answer` click path**.

Configuration/queues:
- Prefer BullMQ jobs in PR3; only introduce Redis Streams if/when throughput demands it.

[Functions]
PR 1: correctness-critical deterministic behavior

New functions/modules:
- `sanitizeLiveRequestContextV4(...)`
  - Must ignore any stale `selectedAnswer*`, `previousAiAnswer`, `previousAiAnswers`, `previousCodeBlocks` unless explicitly allowed by kind.
  - Must classify with priority:
    - code intent detection beats coding/project/scenario classification
    - scenario detection recognizes setup + constraints + numbers + final vague ask (do not reduce scenario)
    - challenge/correction triggers `challenge_or_correction`
    - filler/noise returns short provisional response but does not update trusted memory
  - Logs required fields:
    - `originalMode, effectiveMode, requestKind, answerKind, answerTrust, selectedCleared, previousAnswerCleared, codeIntentDetected, scenarioDetected, challengeDetected, clearReason`
- `applyContextRouterV3(...)` (or existing router adapted)
  - Enforce router output flags *before* runtime context message building.

Modified functions:
- `getAIAnswer(...)` in `src/features/session/session.service.ts`
  - Integrate sanitizer-v4 and router-v3 for real (remove bypass paths).
  - Keep **one streaming call** per click.
  - Ensure RAG does not get called before routing flags are correct.

PR 2: state/memory updates
- Session state builder reads transcript evidence + ledgers; no AI calls on click.
- ScenarioEvidenceBuilder and CodeTaskMemory extraction used by async workers.

PR 3: RAG retriever + replay
- Redis vector retriever only returns supporting evidence types.
- Ensure retriever never “decides the current question”.

[Classes]
No class hierarchy required; services are exported function modules.
- Create service modules with pure functions where possible; keep orchestration in the session service.

[Dependencies]
No new runtime dependencies required. Use existing embedding/RAG code only in async workers.
- Embeddings must not execute on `/ai-answer` click path.
- Prefer BullMQ jobs first; Streams later if needed.

[Testing]
Add unit tests and integration replay tests, staged per PR.

PR 1 tests (Correctness):
- Sanitizer:
  - stale `selectedAnswer*` ignored for `"latest_question"`
  - selected context preserved only for `"selected_card_followup"` and regenerate targeting
  - code intent overrides other classification
  - scenario setup + final ask preserved
  - challenge/correction triggers proper askState/memory allowance
  - noise returns provisional without trusted memory update
- Router application:
  - ensure `includeHistory/includeProjects/includeCodeMemory` matches sanitizer kind
  - ensure no stale previous answer context is injected
- Frontend contract:
  - normal click payload does not include selected/previous fields
  - dedupe does not drop valid streamed code cards

PR 2 tests (Memory):
- ScenarioEvidenceBuilder extraction tests (numbers/constraints preservation)
- CodeTaskMemory extraction tests (binds to correct code task only)
- SessionStateV3 read model tests (Redis key correctness)

PR 3 tests (RAG/Scale):
- Retriever type filtering tests (allowed types only; no question authority)
- Replay benchmark acceptance matrix tests (18 cases)

Validation commands:
- `pnpm type-check`
- `pnpm test`
- `pnpm build`
- Frontend:
  - `pnpm -C /Users/hiddenmindsolutions/Projects/scribeshade-01-frontend exec tsc --noEmit`
  - `pnpm -C /Users/hiddenmindsolutions/Projects/scribeshade-01-frontend build`

[Implementation Order]
Split into 3 PRs to reduce risk:

PR 1 (Correctness first)
1) Implement LiveRequestSanitizerV4
2) Apply ContextRouterV3 for real in click path (before prompt building)
3) Frontend stale payload removal + dedupe fixes
4) Ensure one click = one main streaming call; no embeddings or RAG on click

PR 2 (Memory correctness)
5) Add SessionStateV3 Redis hot state read model
6) Add ScenarioEvidenceBuilder + CodeTaskMemory extraction and wire to async memory updates
7) Add SessionMemoryV3 cache and persistence update hooks

PR 3 (RAG + scale)
8) Add async Redis vector RAG retriever/indexer pipeline
9) Add replay benchmark tests + latency instrumentation

task_progress Items:
- [ ] Step 1 (PR1): Implement LiveRequestSanitizerV4 + integrate into `/ai-answer` click path
- [ ] Step 2 (PR1): Apply ContextRouterV3 for real (no bypass before runtime prompt)
- [ ] Step 3 (PR1): Frontend stale payload removal + card dedupe/persistence safety
- [ ] Step 4 (PR2): Implement SessionStateV3 + ScenarioEvidenceBuilder + CodeTaskMemory + SessionMemoryV3
- [ ] Step 5 (PR3): Implement Redis vector RAG async pipeline + retriever supporting-only
- [ ] Step 6: Implement replay benchmark acceptance matrix + latency metrics
- [ ] Step 7: Run full test + build validation commands
