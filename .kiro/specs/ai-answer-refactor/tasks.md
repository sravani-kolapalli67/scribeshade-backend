# Implementation Plan: AI Answer Refactoring

## Overview

This implementation plan refactors the ScribeShade AI Answer system to remove blocking pre-check layers and use a single streaming AI call with compact evidence packets and Redis-cached runtime context. The key architectural changes include: removing Composer/orchestrator from the click path, building 200-500 token evidence packets, using Redis-first context retrieval, and moving memory updates to post-stream background processing.

## Tasks

- [ ] 1. Create core data structures and helper functions
  - [ ] 1.1 Define CompactEvidencePacket interface and buildCompactEvidencePacket function
    - Create `CompactEvidencePacket` TypeScript interface in `src/features/session/session.service.ts`
    - Implement `buildCompactEvidencePacket(payload: any): CompactEvidencePacket` function
    - Enforce 200-500 token budget through truncation logic (max 8 recentTranscriptWindow, max 10 speakerSeparatedTranscript)
    - Handle optional fields: currentQuestionHint, answerClickMode, selectedIntentId, selectedAnswerIntentId, previousAnswerSummary, previousCodeSummaries
    - Normalize speaker types to uppercase constants (INTERVIEWER, CANDIDATE, AI_ASSISTANT)
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9_
  
  - [ ]* 1.2 Write unit tests for buildCompactEvidencePacket
    - Test with full payload containing all fields (verify token count 200-500)
    - Test with partial payload with missing optional fields
    - Test with empty payload (verify empty packet object)
    - Test speaker type normalization (lowercase/mixed → uppercase constants)
    - _Requirements: 3.9_
  
  - [ ] 1.3 Implement readCachedRuntimeContextOrBuildSmallContext function
    - Create `readCachedRuntimeContextOrBuildSmallContext(sessionId: string, payload: any): Promise<any>` function
    - Try combined cache key `session:{id}:runtime-context-cache` first (2-hour TTL)
    - Fall back to individual ledger keys: intent-ledger, answer-ledger, code-memory, topic-memory
    - Build minimal context packet if all cache misses: candidateResumeDigest, relevantProjectDigest, topicSessionSummary, previousAnswerSummaries (last 3), codeMemorySummary (last 3), selectedAnswerContext, selectedCodeContext, jobCompanyMetadata
    - Handle Redis errors gracefully with console.warn and fallback to minimal context
    - Never fall back to heavy DB queries (explicit requirement)
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 4.8_
  
  - [ ]* 1.4 Write unit tests for readCachedRuntimeContextOrBuildSmallContext
    - Test combined cache hit (verify parsed object returned)
    - Test cache miss with individual ledger hits (verify merged context)
    - Test all cache misses (verify minimal context from payload)
    - Test Redis unavailable (verify no error thrown, graceful fallback)
    - Mock Redis client with jest or sinon
    - _Requirements: 4.6, 4.7, 4.8_

- [ ] 2. Update prompt builder for direct inference
  - [ ] 2.1 Update buildDirectInferAndAnswerTask in src/shared/lib/prompt.ts
    - Accept input: `{ transcriptEvidence: string, currentQuestionHint?: string, activeQuestionDetection?: unknown, selectedIntentId?: string, answerClickMode?: string }`
    - Include transcript evidence in prompt (already serialized as string)
    - Include optional hints when present (currentQuestionHint, answerClickMode, selectedIntentId)
    - Add text: "You are given recent interview transcript evidence. First infer the clean interview question(s), then answer as the candidate."
    - Add text: "Ignore filler like hello, okay, yeah, hmm, let's start."
    - Add text: "Candidate speech may contain the interviewer question if system audio is missing."
    - Add text: "Treat candidate-repeated question-like text as valid evidence for the question to answer."
    - Add text: "If multiple independent questions are present, answer each separately with ===NEXT_QUESTION=== between blocks"
    - Add text: "If follow-up, use session memory/code memory to resolve what that/it/there/this code/previous answer refers to"
    - Add text: "Do not invent missing questions. If no clear question exists, output ===NO_NEW_QUESTION===."
    - Add text: "Output ONLY **QUESTION:** and **ANSWER:** blocks. Do not output analysis, reasoning, or any extra text."
    - Add text: "The first non-whitespace characters must be **QUESTION:**."
    - Support re-answer mode: add line for selectedIntentId when answerClickMode === "re-answer"
    - Support selected-answer mode: add line for selectedIntentId when answerClickMode === "selected-answer"
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8, 5.9, 5.10, 5.11, 5.12, 5.13, 5.14, 5.15_
  
  - [ ]* 2.2 Write unit tests for buildDirectInferAndAnswerTask
    - Test with evidence packet + hints (verify all sections present)
    - Test without hints (verify fallback text)
    - Test re-answer mode (verify re-answer text added)
    - Test selected-answer mode (verify selected-answer text added)
    - Verify required text strings are present in output
    - _Requirements: 5.7, 5.8, 5.9, 5.10, 5.11, 5.12, 5.13, 5.14, 5.15_

- [ ] 3. Checkpoint - Verify core building blocks
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 4. Refactor getAIAnswer function
  - [ ] 4.1 Refactor getAIAnswer to use new flow
    - Update function signature if needed to accept `liveContextMetadata?: AIAnswerLiveContextMetadata`
    - Step 1: Call `buildCompactEvidencePacket` with payload from liveContextMetadata
    - Step 2: Call `readCachedRuntimeContextOrBuildSmallContext(sessionId, payload)` to get runtime context
    - Step 3: Call `buildDirectInferAndAnswerTask` with evidence packet and hints
    - Step 4: Build messages array: [system, runtime context, direct task]
    - Step 5: Return `streamMainAnswerModel(messages, aiModel)` directly
    - Remove all calls to: `resolveAnswerSelection`, `runComposerAI`, `orchestrateAIContext`, `decideAISessionState`, `reconstructFallbackQuestion`, `reconstructQuestion`, `guardCurrentQuestion`, `buildEvidenceBatchFallback`
    - Handle case when no new question: return `noNewQuestionStream()` if applicable
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6_
  
  - [ ] 4.2 Implement post-stream memory updates
    - Create `processPostStreamMemoryUpdates(sessionId: string, liveContextMetadata?: AIAnswerLiveContextMetadata): Promise<void>` function
    - Parse generated QUESTION/ANSWER blocks from the full transcript
    - Save QA to database using `prisma.qa.create`
    - Update answer ledger in Redis (incremental update)
    - Update topic memory in Redis (session state summary)
    - Extract code blocks if present and update code memory in Redis
    - Update intent status if matching ledger intent exists
    - All operations should be fire-and-forget (no await on outer request)
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7_
  
  - [ ] 4.3 Wire post-stream updates to stream end event
    - In `getAIAnswer`, attach `stream.on("end")` handler
    - Call `processPostStreamMemoryUpdates(sessionId, liveContextMetadata).catch(...)` with error logging
    - Ensure error in post-stream updates does NOT affect the user's stream
    - _Requirements: 8.7_
  
  - [ ]* 4.4 Write integration tests for getAIAnswer flow
    - Test valid sessionId + payload (verify NO calls to old pre-check functions)
    - Verify evidence packet is built
    - Verify cached context is read
    - Verify direct task is built
    - Verify streamMainAnswerModel is called with correct messages
    - Mock OpenRouter streaming response
    - _Requirements: 6.4, 10.1_

- [ ] 5. Update Composer to run only from background endpoints
  - [ ] 5.1 Verify Composer is NOT called from getAIAnswer
    - Audit getAIAnswer code path to ensure no `runComposerAI` or `scheduleQuestionComposer` calls
    - Ensure Composer is only called from `save-message` and `patch-transcript` endpoints
    - _Requirements: 7.1, 7.2, 7.3_
  
  - [ ] 5.2 Add background Composer scheduling to save-message endpoint
    - In `POST /api/session/:id/save-message` endpoint, call `scheduleQuestionComposer(sessionId).catch(...)` at the end
    - Ensure Composer runs asynchronously without blocking the response
    - Update intent ledger, answer ledger, code memory, and topic memory in background
    - _Requirements: 7.1, 7.4_
  
  - [ ] 5.3 Add background Composer scheduling to patch-transcript endpoint
    - In `PATCH /api/session/:id/patch-transcript/:messageId` endpoint, call `scheduleQuestionComposer(sessionId).catch(...)` at the end
    - Ensure Composer runs asynchronously without blocking the response
    - Update intent ledger, answer ledger, code memory, and topic memory in background
    - _Requirements: 7.2, 7.4_
  
  - [ ]* 5.4 Write integration tests for Composer background-only behavior
    - Test `POST /api/session/:id/save-message` → verify Composer is scheduled
    - Test `PATCH /api/session/:id/patch-transcript/:messageId` → verify Composer is scheduled
    - Test `POST /api/session/:id/ai-answer` → verify Composer is NOT called
    - Mock BullMQ job queue to verify job enqueueing
    - _Requirements: 7.1, 7.2, 7.3, 7.4_

- [ ] 6. Checkpoint - Verify core refactoring complete
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 7. Update session controller for evidence-only frontend
  - [ ] 7.1 Update session.controller.getAIAnswer to accept evidence payload
    - Accept `recentTranscriptWindow`, `speakerSeparatedTranscript` from request body
    - Accept `currentQuestion`, `activeQuestionDetection` as optional hints
    - Accept `answerClickMode`, `selectedIntentId`, `selectedAnswerIntentId` for re-answer/selected-answer flows
    - Accept selected answer/code metadata if applicable
    - Build `liveContextMetadata` object from request body
    - Pass `liveContextMetadata` to `session.service.getAIAnswer`
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7, 9.8_
  
  - [ ] 7.2 Add request validation for evidence fields
    - Validate `recentTranscriptWindow` is array of strings (optional)
    - Validate `speakerSeparatedTranscript` is array of objects with speaker/text (optional)
    - Validate `answerClickMode` is one of: "auto", "re-answer", "selected-answer" (optional)
    - Use Zod or manual validation, return 400 if invalid
    - _Requirements: 9.1, 9.2, 9.3, 9.6_
  
  - [ ] 7.3 Update error handling for streaming failures
    - If headers not sent, return `res.status(500).json({ error: ... })`
    - If headers already sent (stream started), call `res.end()` gracefully
    - Log error details for debugging
    - Never throw error that blocks user request
    - _Requirements: 2.4, 6.4_
  
  - [ ]* 7.4 Write integration tests for controller evidence handling
    - Test valid evidence payload (verify 200 OK with streaming response)
    - Test missing evidence fields (verify graceful fallback or 400)
    - Test invalid answerClickMode (verify 400)
    - Test re-answer mode with selectedIntentId (verify flow works)
    - Test selected-answer mode with selectedAnswerIntentId (verify flow works)
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7, 9.8_

- [ ] 8. Add Redis cache error handling
  - [ ] 8.1 Add graceful degradation for Redis failures
    - In `readCachedRuntimeContextOrBuildSmallContext`, wrap all Redis calls in try-catch
    - Log cache failures with `console.warn` for monitoring
    - Fall back to minimal context packet on Redis errors
    - Never throw error that blocks user request
    - _Requirements: 4.7, 2.4_
  
  - [ ] 8.2 Add cache hit/miss logging for observability
    - Log `[runtime-context] cache hit (combined)` when combined cache succeeds
    - Log `[runtime-context] cache miss, built minimal context` when fallback occurs
    - Log `[runtime-context] combined cache read failed` on Redis errors
    - Log `[runtime-context] individual cache read failed` on individual key errors
    - Include sessionId in all logs for traceability
    - _Requirements: 4.7_
  
  - [ ]* 8.3 Write error handling tests for Redis failures
    - Mock Redis client to throw errors
    - Verify cache failures are logged (check console.warn calls)
    - Verify minimal context is returned (no error thrown)
    - Verify user request completes successfully
    - _Requirements: 4.7, 2.4_

- [ ] 9. Update API documentation
  - [ ] 9.1 Document new request payload format
    - Update `POST /api/session/:id/ai-answer` in docs/api-reference.md
    - Document evidence fields: recentTranscriptWindow, speakerSeparatedTranscript, currentQuestion, activeQuestionDetection
    - Document click modes: answerClickMode, selectedIntentId, selectedAnswerIntentId
    - Document optional context fields: candidateResumeDigest, relevantProjectDigest, companyName, jobDescription
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7, 9.8_
  
  - [ ] 9.2 Document response format and behavior
    - Document streaming response format (plain text chunks)
    - Document `===NO_NEW_QUESTION===` output when no question found
    - Document `===NEXT_QUESTION===` separator for multiple questions
    - Document expected performance: first token < 200ms
    - _Requirements: 1.3, 5.15_
  
  - [ ] 9.3 Add examples for common use cases
    - Example 1: Basic AI answer click with transcript evidence
    - Example 2: Re-answer flow with selectedIntentId
    - Example 3: Selected-answer flow with selectedAnswerIntentId
    - Example 4: Follow-up question with code memory
    - _Requirements: 9.1, 9.2, 9.3, 9.6, 9.7, 9.8_

- [ ] 10. Final checkpoint and integration verification
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional test tasks and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation at key milestones
- The refactoring removes 7+ pre-check layers from the AI answer path
- Expected performance improvement: 3-5x faster first token latency (target < 200ms)
- Redis cache is prioritized over DB queries to minimize latency
- Post-stream memory updates are fire-and-forget to avoid blocking the user
- Composer runs only from background endpoints (save-message, patch-transcript)
- Frontend sends evidence-only payloads, never synthetic Q&A

## Testing Strategy

### Unit Tests
- `buildCompactEvidencePacket`: Token budget enforcement, field truncation, speaker normalization
- `readCachedRuntimeContextOrBuildSmallContext`: Cache hit/miss, Redis error handling, minimal context fallback
- `buildDirectInferAndAnswerTask`: Prompt structure, required text, mode handling

### Integration Tests
- `getAIAnswer` flow: Evidence → context → task → streaming, no pre-check calls
- Composer background-only: Scheduled from save-message/patch-transcript, NOT from ai-answer
- Post-stream memory updates: QA saved, ledgers updated, intent status updated
- Controller evidence handling: Validation, re-answer/selected-answer modes, error handling

### Performance Tests
- First token latency: Target < 200ms (95th percentile)
- Cache hit rate: Target > 70%
- End-to-end latency: Target < 5 seconds for 500 tokens
- Concurrent requests: 10 concurrent AI answers, verify no resource contention

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.3", "2.1"] },
    { "id": 1, "tasks": ["1.2", "1.4", "2.2"] },
    { "id": 2, "tasks": ["4.1"] },
    { "id": 3, "tasks": ["4.2", "4.3", "5.1"] },
    { "id": 4, "tasks": ["4.4", "5.2", "5.3", "7.1", "7.2", "8.1", "8.2"] },
    { "id": 5, "tasks": ["5.4", "7.3", "7.4", "8.3", "9.1", "9.2"] },
    { "id": 6, "tasks": ["9.3"] }
  ]
}
```
