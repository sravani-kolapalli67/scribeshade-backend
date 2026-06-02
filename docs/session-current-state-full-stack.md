# ScribeShade Session Architecture (Current State, Full Stack)

## Scope
This document describes the **current implemented session flow** across:
- Frontend (Tauri + React hooks)
- Realtime transport (Deepgram WebSocket, backend SSE, HTTP streaming)
- Backend (Express session module, AI orchestration, policy, follow-up logic)
- Persistence (PostgreSQL/Prisma models, legacy JSON snapshots)
- Background workers (watchdog, credit deduction, hold expiry)

It reflects the code paths in:
- Backend: `scribeshade-01-backend`
- Frontend: `scribeshade-01-frontend`

---

## 1. End-to-End Architecture

```text
Tauri Overlay (FloatingApp/useFloatingSession)
  ├─ Mic STT path (Deepgram WS via Tauri/browser hooks)
  ├─ System audio STT path (Rust loopback -> local WS -> Deepgram WS)
  ├─ STT normalization + dedupe + transcript commit
  ├─ Active question detection + adaptive context window
  └─ POST /api/session/:id/ai-answer (streaming)
           |
           v
Backend session.controller -> session.service
  ├─ Request normalization + in-flight dedup lock
  ├─ CIE context assembly (resume/doc/projects/history/vector)
  ├─ Follow-up target resolution + answer policy
  ├─ OpenRouter streaming call
  ├─ Stream chunks back to frontend
  └─ Persist AI turn (TranscriptChunk + QA + optional snapshot)
           |
           v
Persistence / infra
  ├─ Session + TranscriptChunk + QA (+ snapshots)
  ├─ Legacy JSON messages/transcript flush from live chunks
  ├─ Heartbeat endpoint + SSE events for credit/session closure
  └─ BullMQ workers: watchdog, credit deduction, hold expiry
```

---

## 2. Frontend Session Runtime

## 2.1 Core runtime hook
- Main orchestrator: `src/features/session/hooks/useFloatingSession.ts`
- Responsibilities:
  - Audio lifecycle control (mic/system)
  - Transcript insertion/patching
  - Active question detection
  - AI answer request payload construction
  - Heartbeat + SSE subscription
  - Regenerate/manual/custom query wiring via `useAIChat`

## 2.2 Transcript ingestion and normalization
- STT normalization is applied on both interim/final paths via `normalizeSttTranscript`.
- Dedup/reconciliation includes:
  - phrase dedupe within a chunk
  - overlap removal between consecutive chunks
  - near-duplicate suppression by sender + timestamp window
  - interim fallback commit timers for missed final packets
- Persist path:
  - frontend inserts/patches Redux transcript rows immediately
  - async POST to backend `POST /api/session/:id/save-message`
  - patch API for transcript edits/upgrades:
    - `PATCH /api/session/:id/transcript/:messageId`

## 2.3 Active question detection (before AI call)
- Detector: `src/features/session/detection/activeQuestionDetector.ts`
- Input signals:
  - live interim text (highest priority)
  - interviewer/user messages after cutoff timestamp
  - fallback recent transcript window
- Output:
  - `cleanedQuestion`
  - `isFollowUp`
  - `topicChanged`
  - `confidenceScore`
  - `ignoredNoise`
  - optional `referencedHistoryTurnId`
- `useFloatingSession` applies explicit-click recovery if confidence is low:
  - prefers interviewer-derived candidate when available
  - falls back to merged transcript question

## 2.4 Adaptive context packaging
- Built by `buildAdaptiveAiContext(...)` before `/ai-answer`.
- Includes:
  - `recentTranscriptWindow`
  - `speakerSeparatedTranscript`
  - `previousAiAnswers[]`
  - `previousAiAnswer`
  - `previousCodeBlocks[]`
  - selected answer binding (`selectedAnswerId`, question/text/topic/code blocks)
  - `activeQuestionDetection`

## 2.5 AI chat transport and stream handling
- Hook: `src/hooks/useAIChat.ts`
- Request behavior:
  - sanitizes payload shape and length caps
  - per-session operation dedup guard
  - sends `requestId` + `x-request-id` + `x-session-id`
- Stream behavior:
  - reads chunked text stream
  - supports segmented responses via `===NEXT_QUESTION===`
  - handles backend sentinel `===NO_NEW_QUESTION===`
  - captures backend snapshot marker `===SNAPSHOT_ID=...===`

## 2.6 Realtime session control (credits/closure)
- Heartbeat hook: `useSessionHeartbeat`
  - POST every 60s to `/api/session/:id/heartbeat`
- SSE hook: `useSessionEvents`
  - EventSource to `/api/session/:id/events`
  - listens for:
    - `CREDIT_WARNING`
    - `SESSION_CLOSED` (notably `CREDIT_EXHAUSTED`)

---

## 3. STT / Audio Transport Paths

## 3.1 Mic path
- Hook: `src/hooks/useDeepgram.ts`
- Browser/Tauri compatible Deepgram WebSocket with:
  - interim results
  - keepalive every 8s
  - retry/backoff guards
  - device selection and cached mic stream reuse

## 3.2 System audio path (mini overlay optimized)
- Service: `src/services/MiniRemoteAudio.ts`
- Pipeline:
  - Rust capture (platform loopback) -> local WS (`127.0.0.1:<port>`)
  - zero-copy PCM forward -> Deepgram WS
  - transcript callbacks back into UI state
- Reliability:
  - DG-only reconnect on silence close
  - full restart on Rust WS close
  - watchdog if PCM does not arrive after metadata handshake

---

## 4. Backend HTTP + Streaming Layer

## 4.1 API mount and routes
- Global mount: `/api` in `src/app.ts`
- Session router: `src/features/session/session.router.ts`
- Core endpoints:
  - `POST /session/create-session`
  - `POST /session/:id/activate`
  - `POST /session/:id/deactivate`
  - `POST /session/:id/heartbeat`
  - `GET  /session/:id/events` (SSE)
  - `POST /session/:id/save-message`
  - `PATCH /session/:id/transcript/:messageId`
  - `POST /session/:id/ai-answer` (chunked text stream)
  - `POST /session/:id/analyze-screen` (chunked text stream)

## 4.2 `/ai-answer` controller path
- File: `src/features/session/session.controller.ts`
- Sequence:
  1. Normalize request via `normalizeAIAnswerRequestBody`
     - resolved question priority:
       - `patchedTranscript`
       - `currentQuestion`
       - `transcript`
  2. Acquire in-flight lock (`ai-answer:<sessionId>`) via `acquireInFlight`
     - duplicate request returns `409 DUPLICATE_IN_FLIGHT`
  3. Call `sessionService.getAIAnswer(...)`
  4. Stream text with chunked encoding
  5. Release in-flight lock in `finally`

---

## 5. Backend Session Service: AI Answer Engine

Primary file: `src/features/session/session.service.ts`

## 5.1 Live source of truth for follow-up memory
- Live answer history is pulled from `TranscriptChunk` where:
  - `questionGroupId = "live-transcript"`
  - `speakerType = ASSISTANT`
- Fallback to legacy `session.messages` only if needed.

## 5.2 Question guard + follow-up resolution
- Normalization and STT correction: `normalizeTranscriptForQuestionDetection(...)`
- Guarding/reconstruction: `guardCurrentQuestion(...)`
- Intent + follow-up targeting:
  - `classifyConversationIntent(...)`
  - `resolveFollowupTarget(...)`
  - `selectTargetCodeContext(...)`
  - `toAnswerHistory(...)`

## 5.3 Decision layer
- Two modes:
  - deterministic fallback decision
  - optional short-timeout AI decision (`decideAISessionState`) when deterministic signal is weak
- Confidence threshold gates whether AI decision is authoritative.

## 5.4 Context assembly (CIE)
- Built by `buildOptimizedContext(...)` (`cie.service.ts`)
- Includes:
  - company/role/language/simpleLanguage
  - selected resume/document content
  - selected projects (with ordering by primary project id)
  - recent in-session history
  - optional semantic vector context
- Complexity tiering adjusts context budgets:
  - `simple_atomic`, `simple_contextual`, `followup`, `scenario_based`, `system_design`

## 5.5 Request-scoped policy and hard constraints
- Policy engine: `buildRequestScopedPolicy(...)` (`answer-policy.ts`)
- Enforces answer intent-specific behavior:
  - concept vs project/experience vs code-generation vs code-follow-up vs system-design/scenario
- Follow-up binding:
  - injects selected prior code context when relevant
  - avoids generic “no previous code” fallback if recent code exists in history
- Current question authority:
  - explicit prompt block requiring first `QUESTION:` line to match only current question
- Project explain architecture requirement:
  - detects project-explain questions
  - injects mandatory fenced `text` architecture flow block
  - uses explicit project diagram if present, else conservative synthesized flow

## 5.6 Model call and stream
- Provider: OpenRouter SDK (`ai.callModel`)
- Response streamed token-by-token to client
- Max output tokens dynamically chosen by complexity + question count

## 5.7 Post-stream persistence
- `processAIStream(...)` parses structured output:
  - supports multi-question delimiter `===NEXT_QUESTION===`
  - extracts `QUESTION` / `ANSWER` pairs
- For non-ephemeral sessions:
  - upserts QA entries
  - appends assistant message via `appendMessage(...)`
  - optionally creates/updates generation snapshots for regenerate

---

## 6. Transcript Persistence Model (Live + Legacy)

## 6.1 Live write path
- `appendMessage(...)` writes each turn to `TranscriptChunk` with:
  - `questionGroupId = "live-transcript"`
  - mapped `speakerType` and `chunkType`

## 6.2 Legacy compatibility path
- Background flush (`scheduleLegacyTranscriptFlush`) copies live chunks back into:
  - `Session.messages` (JSON)
  - `Session.transcript` (JSON)
- Flush delay is controlled by `LEGACY_TRANSCRIPT_FLUSH_DELAY_MS` (default 7000).
- Explicit flush is called on key lifecycle transitions (deactivate, exhaustion, etc.).

## 6.3 Ephemeral privacy mode
- If `saveTranscription === false`:
  - write paths skip persistence
  - session read response strips transcript/messages
  - finalization clears transcript/messages

---

## 7. Realtime Session Control (Heartbeat + SSE + Watchdog)

## 7.1 Heartbeat
- Endpoint: `POST /api/session/:id/heartbeat`
- Backend computes effective elapsed time using:
  - startedAt
  - pausedDurationSeconds
  - optional frontend elapsed hint
- Returns:
  - `NONE`
  - `CREDIT_WARNING`
  - `CREDIT_EXHAUSTED`

## 7.2 SSE transport
- Endpoint: `GET /api/session/:id/events`
- Managed by `SSEManager` (`src/shared/lib/sse.ts`)
- Features:
  - session-scoped subscriber map
  - keep-alive comments every 25s
  - safe dead-client cleanup

## 7.3 Watchdog and terminalization
- Worker: `session-watchdog.job.ts`
- Tick: every 60s
- Transitions:
  - `ACTIVE/PAUSED` -> `DISCONNECTED` after heartbeat timeout
  - `DISCONNECTED` -> `AUTO_ENDED` after grace window
  - overrun check -> `CREDIT_EXHAUSTED` safety close

---

## 8. Billing and Session Finalization

## 8.1 Activation
- `activateSession(...)`:
  - enforces single active session per user
  - computes `maxAllowedMinutes` from available credits (non-free)
  - sets state to `ACTIVE`

## 8.2 Deactivation path
- `deactivateSession(...)`:
  - transitions to `COMPLETING` (idempotent guards)
  - enqueues `credit-deduction` job when needed
  - free sessions can complete synchronously

## 8.3 Credit deduction worker
- Worker: `credit-deduction.job.ts`
- Computes active minutes from started/ended/paused durations.
- Applies bracket snapshot pricing.
- Final statuses preserved:
  - `COMPLETED`
  - `CREDIT_EXHAUSTED`
  - `AUTO_ENDED`

---

## 9. Database Entities Used by Session Flow

## 9.1 `Session`
Critical fields:
- identity/context: `userId`, `companyId`, `companyName`, `jobDescription`, `language`
- source selections: `resumeId`, `documentId`, `projectIds`, `primaryProjectId`
- transcript/legacy cache: `messages` (JSON), `transcript` (JSON)
- lifecycle: `status`, `startedAt`, `endedAt`, `pausedDurationSeconds`, `lastHeartbeatAt`, `disconnectedAt`
- billing: `maxAllowedMinutes`, `creditsDeducted`, `deductionReason`, `bracketConfigSnapshot`, `creditExhaustedAt`

## 9.2 `TranscriptChunk`
Used as live transcript + AI turn history:
- linkage: `sessionId`, `userId`, `questionGroupId`, `questionId`
- content: `question`, `aiAnswer`, `content`
- typing: `speakerType`, `chunkType`, `isQuestion`
- ordering/time: `createdAt`, `startTime`, `chunkOrder`
- semantic support: `embedding` (pgvector)

## 9.3 `QA`
- Durable Q/A records per session/company/user
- Auto-populated from parsed AI stream pairs

## 9.4 `AnswerGenerationSnapshot`
- Stores original generation context for regenerate flow consistency

---

## 10. Session State Machine (Observed)

```text
PRE_CHECK
  -> ACTIVE
ACTIVE <-> PAUSED
ACTIVE/PAUSED -> DISCONNECTED (watchdog no heartbeat)
DISCONNECTED -> ACTIVE (reconnect activation path)
DISCONNECTED -> AUTO_ENDED (watchdog timeout)
ACTIVE -> CREDIT_EXHAUSTED (heartbeat/watchdog enforcement)
ACTIVE/PAUSED/DISCONNECTED -> COMPLETING -> COMPLETED
PRE_CHECK -> ABANDONED (hold-expiry worker)
```

Deletion guard currently allows terminal/non-running statuses only.

---

## 11. Reliability and Safety Controls

- Request-level dedup lock for `/ai-answer` (`acquireInFlight`).
- Frontend operation registry prevents duplicate clicks while active request exists.
- Stream abort handling on client disconnect.
- Transcript patch path supports both live chunk patching and legacy JSON fallback.
- Explicit assistant question rewrite to prevent prior-turn contamination in first `QUESTION:` block.
- Low-confidence/noise gating can emit `===NO_NEW_QUESTION===` sentinel.

---

## 12. Current “Socket” Reality

Current system uses **three realtime transports**:
- Deepgram WebSockets (frontend STT paths).
- Local Rust WS bridge for system loopback audio (Tauri mini path).
- Backend SSE for credit/session lifecycle notifications.

AI answer generation itself is **HTTP chunked streaming**, not WebSocket.

---

## 13. Operational Debug Checklist

When debugging context loss or wrong follow-ups, inspect these in order:
1. Frontend payload logs from `useFloatingSession` and `useAIChat`.
2. `/ai-answer` backend normalized request snapshot (`resolvedFrom`, detection, selectedAnswer fields).
3. Follow-up resolution logs in `session.service.ts` (`selectedFollowupTargetId`, `contextBindingSource`, `reasonForNoTarget`).
4. `TranscriptChunk` rows for `questionGroupId = live-transcript` to verify live history visibility.
5. Whether session is ephemeral (`saveTranscription=false`) causing intentional persistence skips.
6. Watchdog/heartbeat logs for unexpected lifecycle transitions during answer generation.

---

## 14. Key Implementation Files

Backend:
- `src/features/session/session.router.ts`
- `src/features/session/session.controller.ts`
- `src/features/session/session.service.ts`
- `src/features/session/answer-quality.ts`
- `src/features/session/answer-policy.ts`
- `src/features/session/cie.service.ts`
- `src/features/session/ai-answer.dto.ts`
- `src/shared/lib/sse.ts`
- `src/features/jobs/session-watchdog.job.ts`
- `src/features/jobs/credit-deduction.job.ts`
- `prisma/schema.prisma`

Frontend:
- `src/features/session/hooks/useFloatingSession.ts`
- `src/hooks/useAIChat.ts`
- `src/features/session/detection/activeQuestionDetector.ts`
- `src/hooks/useSessionHeartbeat.ts`
- `src/hooks/useSessionEvents.ts`
- `src/services/MiniRemoteAudio.ts`
- `src/hooks/useDeepgram.ts`

