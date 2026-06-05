# Requirements Document

## Introduction

Requirements Document: AI Answer Refactoring

This feature refactors the ScribeShade AI Answer system to simplify the `/session/:id/ai-answer` endpoint by removing unnecessary pre-check layers. The goal is to make AI answers fast, dynamic, and memory-aware by using a single main AI call that streams immediately without blocking on question composition, segmentation, or context orchestration.

## Glossary

- **AI Answer**: The main AI model call that streams an interview answer
- **Composer**: Question composer service that runs in background to index memory and select questions
- **Segmenter**: Transcript segmenter that separates interviewer/candidate speech
- **Context Orchestration**: Process of building optimized context packet for AI
- **Runtime Context Cache**: Redis cache storing session memory (intent ledger, answer ledger, code memory, topic memory)
- **Direct Infer + Answer Task**: Single AI prompt that infers question from evidence and answers
- **Compact Evidence Packet**: 200-500 token transcript summary sent to AI
- **Pre-check Layers**: Sequential decision points that block the main AI call (composer, segmenter, orchestrator, decision precheck)
- **Fallback Question**: Static or heuristic-selected question used when active detection fails (to be eliminated)

## Requirements

### Requirement 1: Single Main AI Call

**User Story:** As a candidate, I want my AI answer to start streaming immediately when I click "AI Answer", so that I don't experience delays from background processing.

#### Acceptance Criteria

1. WHEN a user clicks "AI Answer" THEN THE Session Controller SHALL NOT call `resolveAnswerSelection`, `runComposerAI`, `orchestrateAIContext`, `decideAISessionState`, `reconstructFallbackQuestion`, `reconstructQuestion`, `guardCurrentQuestion`, or `buildEvidenceBatchFallback`
2. WHEN the main AI call is initiated THEN THE Backend SHALL receive transcript evidence directly from the frontend
3. IF the main AI call succeeds THEN THE First token SHALL be streamed within 200ms of the request
4. IF any pre-check layer times out THEN THE System SHALL NOT block or delay the user's stream

### Requirement 2: Remove Pre-Check Layers

**User Story:** As a developer, I want pre-check layers removed from the AI answer click path, so that the answer flow is not blocked by slow or failing background services.

#### Acceptance Criteria

1. WHEN `/session/:id/ai-answer` is called THEN THE Session Service SHALL NOT invoke `resolveAnswerSelection(...)` as a synchronous step
2. WHEN `/session/:id/ai-answer` is called THEN THE Session Service SHALL NOT invoke `runComposerAI(...)` on the request path
3. WHEN `/session/:id/ai-answer` is called THEN THE Session Service SHALL NOT invoke `orchestrateAIContext(...)` on the request path
4. WHEN `/session/:id/ai-answer` is called THEN THE Session Service SHALL NOT invoke `decideAISessionState(...)` on the request path
5. WHEN `/session/:id/ai-answer` is called THEN THE Session Service SHALL NOT invoke `reconstructFallbackQuestion(...)` on the request path
6. WHEN `/session/:id/ai-answer` is called THEN THE Session Service SHALL NOT invoke `guardCurrentQuestion(...)` on the request path
7. WHEN `/session/:id/ai-answer` is called THEN THE Session Service SHALL NOT invoke `buildEvidenceBatchFallback(...)` on the request path

### Requirement 3: Compact Evidence Packet Builder

**User Story:** As a developer, I want a compact evidence packet builder that creates a 200-500 token transcript summary, so that the main AI call is fast and focused.

#### Acceptance Criteria

1. WHEN `buildCompactEvidencePacket` is called with `payload` THEN THE Function SHALL include `recentTranscriptWindow` (array of strings)
2. WHEN `buildCompactEvidencePacket` is called with `payload` THEN THE Function SHALL include `speakerSeparatedTranscript` (array of `{speaker, text}`)
3. WHEN `buildCompactEvidencePacket` is called with `payload` THEN THE Function SHALL include `currentQuestionHint` if present
4. WHEN `buildCompactEvidencePacket` is called with `payload` THEN THE Function SHALL include `answerClickMode` if present
5. WHEN `buildCompactEvidencePacket` is called with `payload` THEN THE Function SHALL include `selectedIntentId` if present
6. WHEN `buildCompactEvidencePacket` is called with `payload` THEN THE Function SHALL include `selectedAnswerIntentId` if present
7. WHEN `buildCompactEvidencePacket` is called with `payload` THEN THE Function SHALL include `previousAnswerSummary` if pre-computed
8. WHEN `buildCompactEvidencePacket` is called with `payload` THEN THE Function SHALL include `previousCodeBlocks` if pre-computed
9. WHEN `buildCompactEvidencePacket` finishes THEN THE Total token count SHALL be between 200-500 tokens

### Requirement 4: Cached Runtime Context Helper

**User Story:** As a developer, I want a runtime context helper that prioritizes Redis cache, so that the AI answer path avoids heavy DB/RAG calls that could slow down the response.

#### Acceptance Criteria

1. WHEN `readCachedRuntimeContextOrBuildSmallContext` is called THEN THE Function SHALL first attempt to read from Redis key `session:{id}:runtime-context-cache`
2. WHEN `readCachedRuntimeContextOrBuildSmallContext` is called THEN THE Function SHALL attempt to read from `session:{id}:intent-ledger` if cache miss
3. WHEN `readCachedRuntimeContextOrBuildSmallContext` is called THEN THE Function SHALL attempt to read from `session:{id}:answer-ledger` if cache miss
4. WHEN `readCachedRuntimeContextOrBuildSmallContext` is called THEN THE Function SHALL attempt to read from `session:{id}:code-memory` if cache miss
5. WHEN `readCachedRuntimeContextOrBuildSmallContext` is called THEN THE Function SHALL attempt to read from `session:{id}:topic-memory` if cache miss
6. WHEN cached context is available THEN THE Function SHALL return: candidate resume digest, relevant project digest (only when needed), topic/session summary, previous answer summaries, code memory summary, selected answer/code context, lightweight job/company metadata
7. WHEN cached context is missing AND Redis is unavailable THEN THE Function SHALL NOT fall back to heavy RAG/vector/full DB context on click path
8. WHEN `readCachedRuntimeContextOrBuildSmallContext` returns THEN THE Result SHALL be a compact context packet (under 500 tokens)

### Requirement 5: Updated Prompt Builder

**User Story:** As a developer, I want the prompt builder updated to accept compact evidence packets and support follow-up resolution, so that the main AI can infer questions from evidence.

#### Acceptance Criteria

1. WHEN `buildDirectInferAndAnswerTask` is called with `transcriptEvidence: CompactEvidencePacket` THEN THE Function SHALL include transcript evidence in the prompt
2. WHEN `buildDirectInferAndAnswerTask` is called with `currentQuestionHint` THEN THE Function SHALL include it in the prompt
3. WHEN `buildDirectInferAndAnswerTask` is called with `answerClickMode` THEN THE Function SHALL include it in the prompt
4. WHEN `buildDirectInferAndAnswerTask` is called with `selectedIntentId` THEN THE Function SHALL include it in the prompt
5. WHEN `buildDirectInferAndAnswerTask` is called with `selectedAnswerIntentId` THEN THE Function SHALL include it in the prompt
6. WHEN `buildDirectInferAndAnswerTask` is called with `activeQuestionDetection` THEN THE Function SHALL include it in the prompt
7. WHEN `buildDirectInferAndAnswerTask` finishes THEN THE Prompt MUST contain: "You are given recent interview transcript evidence. First infer the clean interview question(s), then answer as the candidate."
8. WHEN `buildDirectInferAndAnswerTask` finishes THEN THE Prompt MUST say: "Ignore filler/admin/noise"
9. WHEN `buildDirectInferAndAnswerTask` finishes THEN THE Prompt MUST say: "Candidate speech may contain the interviewer question if system audio is missing"
10. WHEN `buildDirectInferAndAnswerTask` finishes THEN THE Prompt MUST say: "Treat candidate-repeated question-like text as valid evidence"
11. WHEN `buildDirectInferAndAnswerTask` finishes THEN THE Prompt MUST say: "If multiple independent questions are present, answer each separately with ===NEXT_QUESTION=== between blocks"
12. WHEN `buildDirectInferAndAnswerTask` finishes THEN THE Prompt MUST say: "If follow-up, use session memory/code memory to resolve what that/it/there/this code/previous answer refers to"
13. WHEN `buildDirectInferAndAnswerTask` finishes THEN THE Prompt MUST say: "Do not invent a question if evidence is weak"
14. WHEN `buildDirectInferAndAnswerTask` finishes THEN THE Prompt MUST say: "Output only **QUESTION:** and **ANSWER:**"
15. WHEN `buildDirectInferAndAnswerTask` finishes THEN THE Prompt MUST say: "Output ===NO_NEW_QUESTION=== only when no answerable question exists"

### Requirement 6: Refactored getAIAnswer Function

**User Story:** As a developer, I want the getAIAnswer function refactored to use the new flow (compact evidence + cached context + single AI call), so that the answer path is simple and fast.

#### Acceptance Criteria

1. WHEN `getAIAnswer` is called THEN THE Function SHALL call `buildCompactEvidencePacket(payload)` to create evidence packet
2. WHEN `getAIAnswer` is called THEN THE Function SHALL call `readCachedRuntimeContextOrBuildSmallContext(sessionId, payload)` to get runtime context
3. WHEN `getAIAnswer` is called THEN THE Function SHALL call `buildDirectInferAndAnswerTask` with the evidence packet and hints
4. WHEN `getAIAnswer` is called THEN THE Function SHALL NOT call `resolveAnswerSelection`, `runComposerAI`, `orchestrateAIContext`, `decideAISessionState`, `reconstructFallbackQuestion`, `reconstructQuestion`, `guardCurrentQuestion`, or `buildEvidenceBatchFallback`
5. WHEN `getAIAnswer` finishes THEN THE Function SHALL return `streamMainAnswerModel(messages)` where messages include system, runtime context, and direct infer task
6. IF `composerSelection.questions.length === 0` THEN THE Function SHALL return `noNewQuestionStream()`

### Requirement 7: Composer Background-Only

**User Story:** As a developer, I want the composer to only run from background events, so that it never blocks live AI answers.

#### Acceptance Criteria

1. WHEN `save-message` endpoint is called THEN THE System SHALL invoke question composer for memory indexing
2. WHEN `patch-transcript` endpoint is called THEN THE System SHALL invoke question composer for memory indexing
3. WHEN `getAIAnswer` is called THEN THE System SHALL NOT invoke question composer
4. WHEN question composer runs in background THEN THE System SHALL update intent ledger, answer ledger, code memory, and topic memory asynchronously

### Requirement 8: Post-Stream Memory Updates

**User Story:** As a candidate, I want memory ledgers updated after my answer streams, so that follow-up questions work correctly without delaying my current answer.

#### Acceptance Criteria

1. WHEN a streamed answer completes THEN THE System SHALL parse generated QUESTION/ANSWER blocks
2. WHEN a streamed answer completes THEN THE System SHALL save the QA to the database
3. WHEN a streamed answer completes THEN THE System SHALL update answer ledger asynchronously
4. WHEN a streamed answer completes THEN THE System SHALL update topic memory asynchronously
5. WHEN a streamed answer completes THEN THE System SHALL extract code blocks if present and update code memory
6. WHEN a streamed answer completes THEN THE System SHALL update intent status if matching ledger intent exists
7. WHEN post-stream memory updates begin THEN THE System SHALL NOT delay the user's stream

### Requirement 9: Frontend Behavior

**User Story:** As a frontend developer, I want the frontend to send evidence only, never creating synthetic Q&A, so that the backend can correctly infer questions from transcript evidence.

#### Acceptance Criteria

1. WHEN frontend sends `/ai-answer` request THEN THE System SHALL include `transcript` evidence
2. WHEN frontend sends `/ai-answer` request THEN THE System SHALL include `recentTranscriptWindow`
3. WHEN frontend sends `/ai-answer` request THEN THE System SHALL include `speakerSeparatedTranscript`
4. WHEN frontend sends `/ai-answer` request THEN THE System MAY include `currentQuestion` as hint
5. WHEN frontend sends `/ai-answer` request THEN THE System SHALL include `activeQuestionDetection` as hint
6. WHEN frontend sends `/ai-answer` request THEN THE System SHALL include `answerClickMode`
7. WHEN frontend sends `/ai-answer` request THEN THE System SHALL include `selectedIntentId` if applicable
8. WHEN frontend sends `/ai-answer` request THEN THE System SHALL include `selectedAnswerIntentId` if applicable
9. WHEN frontend sends `/ai-answer` request THEN THE System SHALL include selected answer/code metadata if applicable
10. WHEN frontend sends `/ai-answer` request THEN THE System SHALL NOT create fake fallback answers or synthetic Q&A cards

### Requirement 10: Success Criteria

**User Story:** As a product manager, I want the refactored system to meet performance and correctness criteria, so that candidates have a fast, reliable AI interview experience.

#### Acceptance Criteria

1. WHEN a user clicks "AI Answer" THEN THE System SHALL use ONE main AI streaming call
2. WHEN the first token is generated THEN THE System SHALL be faster than current because Composer/prechecks are removed from click path
3. WHEN transcript evidence is sent to main AI THEN THE System SHALL infer clean question(s) from evidence
4. WHEN follow-up questions are asked THEN THE System SHALL use cached answer/topic/code memory to resolve references
5. WHEN coding follow-ups are asked THEN THE System SHALL use code memory for continuity
6. WHEN scenario-based follow-ups are asked THEN THE System SHALL use topic/answer summaries for context
7. WHEN Composer times out in background THEN THE System SHALL NOT affect live answer quality
8. WHEN no clear question exists in evidence THEN THE System SHALL NOT send static or fake fallback questions to prompt
9. WHEN frontend receives evidence-only mode THEN THE System SHALL NOT create fake Q&A cards
10. WHEN background Composer runs THEN THE System SHALL maintain ledgers for long memory and selected/re-answer flows

## Acceptance Criteria Testing Prework

10.1 WHEN a user clicks "AI Answer" THEN THE System SHALL use ONE main AI streaming call
  Thoughts: This is about verifying the flow uses a single AI call. We can generate random session IDs and verify that only one AI call is made.
  Testable: yes - property

10.2 WHEN the first token is generated THEN THE System SHALL be faster than current because Composer/prechecks are removed from click path
  Thoughts: This is a performance criterion. We can measure latency and verify it's under 200ms. This is more of an example test than a property.
  Testable: yes - example

10.3 WHEN transcript evidence is sent to main AI THEN THE System SHALL infer clean question(s) from evidence
  Thoughts: We can generate various transcript inputs and verify the AI correctly infers questions. This is a good property for PBT.
  Testable: yes - property

10.4 WHEN follow-up questions are asked THEN THE System SHALL use cached answer/topic/code memory to resolve references
  Thoughts: We can generate follow-up questions and verify that cached memory is used to resolve references. This is a good property.
  Testable: yes - property

10.5 WHEN coding follow-ups are asked THEN THE System SHALL use code memory for continuity
  Thoughts: We can generate coding follow-up questions and verify that code memory is included in the context. This is a good property.
  Testable: yes - property

10.6 WHEN scenario-based follow-ups are asked THEN THE System SHALL use topic/answer summaries for context
  Thoughts: We can generate scenario-based follow-up questions and verify that topic summaries are used. This is a good property.
  Testable: yes - property

10.7 WHEN Composer times out in background THEN THE System SHALL NOT affect live answer quality
  Thoughts: This is about error handling. We can simulate Composer timeouts and verify live answers are not affected. This is a property.
  Testable: yes - property

10.8 WHEN no clear question exists in evidence THEN THE System SHALL NOT send static or fake fallback questions to prompt
  Thoughts: We can generate transcripts with no clear questions and verify that no fake questions are sent. This is a property.
  Testable: yes - property

10.9 WHEN frontend receives evidence-only mode THEN THE System SHALL NOT create fake Q&A cards
  Thoughts: This is about frontend behavior. We can test that the frontend doesn't create synthetic Q&A. This is a property.
  Testable: yes - property

10.10 WHEN background Composer runs THEN THE System SHALL maintain ledgers for long memory and selected/re-answer flows
  Thoughts: This is about background job integrity. We can verify that ledgers are updated correctly. This is a property.
  Testable: yes - property

## Testing Strategy

### Property-Based Tests

The following acceptance criteria are suitable for property-based testing:

- **10.1**: Verify single AI call flow for various session scenarios
- **10.3**: Verify question inference from various transcript patterns
- **10.4**: Verify follow-up resolution using cached memory
- **10.5**: Verify code memory continuity for coding follow-ups
- **10.6**: Verify topic summaries for scenario-based follow-ups
- **10.7**: Verify Composer timeout doesn't affect live answers
- **10.8**: Verify no fake questions when evidence is weak
- **10.9**: Verify frontend doesn't create synthetic Q&A
- **10.10**: Verify ledger updates from background Composer

### Example-Based Tests

The following acceptance criteria are better tested with specific examples:

- **10.2**: Measure latency and verify it's under 200ms (performance benchmark)

### Integration Tests

The following aspects should be tested with integration tests:

- Composer runs only from save-message and patch-transcript endpoints
- Post-stream memory updates happen asynchronously
- Redis cache reads complete in under 50ms
- All existing re-answer flows continue to work
- All existing selected-answer flows continue to work