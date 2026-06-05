# Implementation Plan: Prompt Optimization Phase 2

## Overview

This implementation follows a **3-phase migration strategy** (Foundation → Integration → Rollout) to refactor ScribeShade's AI answer-generation pipeline from 4,000-10,000 tokens to 1,500-3,000 tokens. The system introduces:

- **10 core components**: Context Orchestrator, Runtime Context Builder, Resume/Project/History Compressors, Memory Store, Active Task Builder, Token Budget Enforcer, Prompt Auditor, Context Tier Selector
- **Redis-based memory architecture** with 4 memory types (topic, turn, answer, intent)
- **Token budget framework**: system (1200) + runtime (200-1110) + active (400) = 1,800-2,610 tokens + 600 margin
- **3-tier context system**: minimal (800 tokens), resume (1200 tokens), full (2000 tokens)
- **28 correctness properties** for validation
- **Feature flags** for gradual rollout with zero database schema changes

## Tasks

### Phase 1: Foundation (Week 1-2)

- [ ] 1. Set up Redis memory store infrastructure
  - [ ] 1.1 Create Memory Store Service with Redis integration
    - Create `src/shared/lib/memory-store.service.ts`
    - Implement Redis client singleton with connection pooling
    - Define Redis key patterns: `memory:{sessionId}:{type}`
    - Implement TTL management (2-hour default with sliding window)
    - Add connection retry logic with exponential backoff (1s, 2s, 4s, 8s, max 30s)
    - _Requirements: 6.1, 6.2_
  
  - [ ] 1.2 Implement topic memory operations
    - Implement `getTopicMemory()` and `setTopicMemory()` methods
    - Add 30-token budget enforcement for topic keywords
    - Implement last-10-turns rolling window
    - Add JSON serialization/deserialization with error handling
    - _Requirements: 6.3_
  
  - [ ] 1.3 Implement turn memory operations
    - Implement `getTurnMemory()` and `appendTurnMemory()` methods
    - Add 60-token-per-turn budget enforcement
    - Implement last-5-turns rolling window with automatic pruning
    - Add code block truncation (200 tokens max) with structure preservation
    - _Requirements: 6.3, 6.4_
  
  - [ ] 1.4 Implement answer memory operations
    - Implement `getAnswerMemory()` and `appendAnswerMemory()` methods
    - Add 60-token-per-answer budget enforcement
    - Implement last-5-answers rolling window
    - Add answer type detection (prose, code, list)
    - _Requirements: 6.4_
  
  - [ ] 1.5 Implement intent memory operations
    - Implement `getIntentMemory()`, `appendIntentMemory()`, and `markIntentResolved()` methods
    - Add 40-token-per-intent budget enforcement
    - Implement last-8-intents rolling window
    - Add follow-up chain linking via parentIntentId
    - _Requirements: 6.5_
  
  - [ ] 1.6 Add memory store batch operations and cleanup
    - Implement `getFullMemoryContext()` for single-call retrieval
    - Implement `clearSessionMemory()` for cleanup
    - Add memory corruption detection and auto-repair
    - Add graceful degradation (in-memory fallback on Redis failure)
    - _Requirements: 6.1, 6.2_

- [ ] 2. Implement token counting and budget enforcement
  - [ ] 2.1 Create Token Budget Service
    - Create `src/shared/lib/token-budget.service.ts`
    - Integrate `js-tiktoken` with `cl100k_base` encoding
    - Implement `countTokens()` function with caching
    - Implement `clipToTokenBudget()` with structure preservation
    - Define `TOKEN_BUDGETS` constant with tier allocations
    - _Requirements: 9.1, 9.2, 9.3_
  
  - [ ] 2.2 Implement budget validation logic
    - Implement `enforceBudget()` function with per-section checks
    - Add 90% threshold warning detection
    - Add total budget validation (3000 token hard limit)
    - Create `BudgetCheck` and `BudgetViolation` types
    - Add compression triggering at 2400-token threshold
    - _Requirements: 9.5_
  
  - [ ] 2.3 Implement tier-based budget allocation
    - Create `getTierBudgets()` function for dynamic allocation
    - Implement minimal tier budgets (resume: 0, project: 0, memory: 120, history: 80)
    - Implement resume tier budgets (resume: 180, project: 250, memory: 180, history: 180)
    - Implement full tier budgets (resume: 180, project: 450, memory: 180, history: 180)
    - Add project budget dynamic reallocation based on question intent
    - _Requirements: 9.2, 18.1, 18.2, 18.3_

- [ ] 3. Build compression services
  - [ ] 3.1 Create Resume Digest Compressor
    - Create `src/features/session/compressors/resume-compressor.service.ts`
    - Implement `compressResumeDigest()` with 120-180 token target
    - Extract structured sections (experience, skills, education)
    - Preserve exact company names, role titles, tools, measurable outcomes
    - Remove verbose descriptions and redundant skill listings
    - Implement deduplication against project facts
    - _Requirements: 2.1, 2.2, 2.3, 2.5_
  
  - [ ] 3.2 Create History Summary Compressor
    - Create `src/features/session/compressors/history-compressor.service.ts`
    - Implement `compressHistory()` with 180-token target
    - Extract last 3 Q&A pairs from transcript
    - Include question topic (5-10 tokens), answer approach (10-20 tokens), code language
    - Strip full answer text, markdown formatting, and code blocks
    - Implement 15-minute time window pruning
    - _Requirements: 7.1, 7.2, 7.3, 7.5_
  
  - [ ] 3.3 Create Document Summary Compressor
    - Create `src/features/session/compressors/document-compressor.service.ts`
    - Implement `compressDocumentSummary()` with 120-token target
    - Extract key concepts, terminology, and business context
    - Detect document type (technical, business, product) with tagging
    - Prioritize function signatures and data structures for code-heavy docs
    - Exclude verbose descriptions and repeated concepts
    - _Requirements: 19.1, 19.2, 19.3, 19.4, 19.5_
  
  - [ ] 3.4 Create Instructions Compressor
    - Create `src/features/session/compressors/instructions-compressor.service.ts`
    - Implement `compressInstructions()` with 80-token target
    - Prioritize domain-specific guidance over general preferences
    - Preserve exact terminology, acronyms, company-specific keywords
    - Detect and exclude redundant guidance already in system prompt
    - Add user warning when truncation occurs
    - _Requirements: 20.1, 20.2, 20.3, 20.4, 20.5_
  
  - [ ] 3.5 Create Transcript Window Manager
    - Create `src/features/session/compressors/transcript-compressor.service.ts`
    - Implement `buildTranscriptWindow()` with 120-180 token active window (3-5 recent turns)
    - Implement `buildRollingSummary()` with 80-120 tokens for older turns
    - Extract topic, outcome, and decisions from older turns
    - Exclude verbatim speaker-separated format and raw interim text
    - _Requirements: 5.1, 5.2, 5.5_
  
  - [ ] 3.6 Create Code Context Injector
    - Create `src/features/session/compressors/code-context-injector.service.ts`
    - Implement `injectCodeContext()` with 200-token block limit
    - Truncate code blocks by preserving function signatures, removing implementation
    - Add language tag and line count metadata (5 tokens max)
    - Implement balanced brace/quote validation for truncated code
    - Only inject for code-related intents (EXPLAIN_CODE, DEBUG_CODE, OPTIMIZE_CODE)
    - _Requirements: 7.4, 17.1, 17.2, 17.3, 17.4, 17.5_

- [ ] 4. Create prompt validation and auditing
  - [ ] 4.1 Create Prompt Auditor Service
    - Create `src/shared/lib/prompt-auditor.service.ts`
    - Implement `auditPrompt()` with pre-flight validation checks
    - Add total token check (<3000 tokens hard limit)
    - Add per-section budget validation (system, runtime, active)
    - Add 90% budget threshold warning detection
    - _Requirements: 11.1, 11.2, 11.3_
  
  - [ ] 4.2 Implement parser safety validation
    - Create `ParserValidator` class
    - Detect unclosed code fences using regex patterns
    - Detect broken bullets and orphaned headers
    - Implement auto-repair for common markdown issues
    - Validate special character escaping (**QUESTION:**, **ANSWER:**, ===NEXT_QUESTION===)
    - _Requirements: 15.1, 15.2, 15.3, 15.4, 15.5_
  
  - [ ] 4.3 Add compression quality assessment
    - Implement `assessCompressionQuality()` function
    - Track resume facts preserved count
    - Track project count included
    - Track memory turns included
    - Track history entries included
    - Add quality score calculation (0-1 scale)
    - _Requirements: 11.5_
  
  - [ ] 4.4 Implement audit logging
    - Create `AuditLog` data model with structured fields
    - Log token breakdown by section (system, runtime, active)
    - Log compression entries with strategy details
    - Log tier and intent classification
    - Add audit log persistence (file or database)
    - Emit audit metrics for monitoring
    - _Requirements: 11.5_

- [ ] 5. Set up feature flags and configuration
  - [ ] 5.1 Add feature flag environment variables
    - Add `ENABLE_PROMPT_OPTIMIZATION` to `src/config/env.ts`
    - Add `PROMPT_OPT_ROLLOUT_PERCENT` for gradual rollout
    - Add `ENABLE_MEMORY_STORE` for independent memory store toggle
    - Add `ENABLE_COMPRESSION` for compression strategy toggle
    - Add `ENABLE_TIERING` for context tier selection toggle
    - Add `LOG_PROMPT_COMPARISONS` for side-by-side logging
    - _Requirements: 13.1, 13.2_
  
  - [ ] 5.2 Create prompt optimization configuration module
    - Create `src/config/prompt-optimization.config.ts`
    - Export `promptOptimizationConfig` object with all flags
    - Add runtime flag validation
    - Add default value handling
    - Document each flag with usage examples
    - _Requirements: 13.1_

- [ ] 6. Checkpoint - Validate Phase 1 foundation
  - Run all unit tests for new services
  - Verify Redis connection and reconnection logic
  - Test compression algorithms with sample data
  - Validate token counting accuracy
  - Ensure no impact on existing answer generation flow
  - Ensure all tests pass, ask the user if questions arise.

### Phase 2: Integration (Week 3-4)

- [ ] 7. Build Runtime Context Builder
  - [ ] 7.1 Create Runtime Context Builder Service
    - Create `src/features/session/runtime-context-builder.service.ts`
    - Implement `buildRuntimeContext()` main orchestration function
    - Add tier-based component selection logic
    - Enforce 800-token total budget with automatic compression
    - Create `RuntimeContext` data model
    - _Requirements: 1.1, 1.3_
  
  - [ ] 7.2 Integrate Resume Digest Compressor
    - Call `compressResumeDigest()` in runtime context builder
    - Apply tier-specific resume budget (0 for minimal, 180 for resume/full)
    - Pass existing project facts for deduplication
    - Handle compression failures with fallback strategies
    - _Requirements: 1.1, 2.1_
  
  - [ ] 7.3 Integrate Project Digest Compressor (modify existing CIE service)
    - Modify `extractRelevantProjectContext()` in `src/features/session/services/cie.service.ts`
    - Add `compressionLevel` parameter: 'none' | 'standard' | 'aggressive'
    - Implement tier-based project budget (0 for minimal, 250 for resume, 450 for full)
    - Add PRIMARY project prioritization logic
    - Remove architecture diagrams for non-project questions
    - _Requirements: 1.1, 2.4, 18.4, 18.5_
  
  - [ ] 7.4 Integrate Memory Store
    - Call `getFullMemoryContext()` from Memory Store Service
    - Format memory context with 180-token budget
    - Handle Redis connection failures with graceful degradation
    - Add in-memory fallback for session duration
    - _Requirements: 1.1, 6.1_
  
  - [ ] 7.5 Integrate History Compressor
    - Call `compressHistory()` in runtime context builder
    - Apply tier-specific history budget (80 for minimal, 180 for resume/full)
    - Pass session transcript data
    - Handle compression failures with truncation fallback
    - _Requirements: 1.1, 7.1_
  
  - [ ] 7.6 Add Runtime Context validation guard
    - Implement `RuntimeContextParser.validate()` method
    - Check for request-level artifacts (question, transcript, segmenter metadata)
    - Reject runtime context containing active-task data
    - Log validation failures with detailed diagnostics
    - _Requirements: 1.2, 1.5_

- [ ] 8. Refactor Active Task Builder
  - [ ] 8.1 Modify Active Task Builder in prompt.ts
    - Update `buildActiveTask()` in `src/shared/lib/prompt.ts`
    - Remove duplicate question representations (keep only cleaned current question)
    - Enforce 60-token question budget
    - Remove full segmenter metadata (keep only intent + isFollowUp)
    - Enforce 400-token total active task budget
    - _Requirements: 3.1, 3.2, 3.5, 8.1, 8.2_
  
  - [ ] 8.2 Implement Segmenter Output Filter
    - Create `filterSegmenterMetadata()` function
    - Extract only intent classification and isFollowUp boolean
    - Remove confidence scores, detection sources, fallback indicators
    - Remove turn IDs, cutoff timestamps, operation IDs, platform tags
    - Enforce 40-token metadata budget
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5_
  
  - [ ] 8.3 Implement Follow-Up Resolver
    - Create `resolveFollowUp()` function
    - Reference prior question by turn ID without repeating text
    - Inject only referenced prior turn (60-100 tokens)
    - Use Memory Store to retrieve prior turn context
    - Add follow-up anchor to active task (60-token budget)
    - _Requirements: 3.3, 3.4, 5.4, 8.3_
  
  - [ ] 8.4 Add project diagram budget reallocation
    - Detect when project diagram context is needed
    - Replace transcript excerpt budget (180 tokens) with architecture flow (260 tokens)
    - Inject project diagram from CIE service
    - Update active task total budget calculation
    - _Requirements: 8.4_

- [ ] 9. Implement Context Tier Selector
  - [ ] 9.1 Create Context Tier Selector (extend CIE service)
    - Add `selectContextTier()` function to `src/features/session/services/cie.service.ts`
    - Implement intent-to-tier mapping logic
    - Add confidence threshold fallback (<0.7 → resume tier)
    - Add keyword-based classification for low-confidence intents
    - Return tier with reasoning metadata
    - _Requirements: 10.1, 10.5_
  
  - [ ] 9.2 Implement tier classification rules
    - Map technical intents (EXPLAIN_CODE, DEBUG_CODE, OPTIMIZE_CODE, NEW_QUESTION) → minimal tier
    - Map experience intents (EXPERIENCE_QUESTION, BEHAVIORAL, FOLLOW_UP) → resume tier
    - Map scenario intents (SCENARIO_QUESTION, SYSTEM_DESIGN) → full tier
    - Add confidence validation (≥0.7 for technical → minimal)
    - Default to resume tier for ambiguous cases
    - _Requirements: 10.2, 10.3, 10.4_

- [ ] 10. Integrate with Context Orchestrator
  - [ ] 10.1 Modify Context Orchestrator Service
    - Update `buildAIContext()` in `src/features/session/services/context-orchestrator.service.ts`
    - Add tier selection call to Context Tier Selector
    - Pass tier to Runtime Context Builder
    - Add Token Budget Enforcer pre-assembly validation
    - Add Prompt Auditor post-assembly validation
    - _Requirements: 1.3, 9.5, 11.1_
  
  - [ ] 10.2 Add compression fallback logic
    - Implement `applyCompressionFallback()` function
    - Prioritize compression order: transcript (180→120), project (-30%), history (180→120), memory (180→120), resume (180→120)
    - Retry assembly after compression
    - Reject request if fallback fails to meet budget
    - Log compression fallback events with metrics
    - _Requirements: 1.4, 9.5_
  
  - [ ] 10.3 Modify OpenRouter request structure
    - Update message array structure in `src/features/session/session.service.ts`
    - Change from 1 system + 1 user message to 1 system + 2 user messages
    - First user message: runtime context (200-1110 tokens)
    - Second user message: active task (400 tokens)
    - Update streaming response handling
    - _Requirements: 16.1, 16.2, 16.3_

- [ ] 11. Add side-by-side comparison logging
  - [ ] 11.1 Implement legacy prompt builder preservation
    - Keep existing `buildAnswerRuntimeContext()` as `buildAnswerRuntimeContextLegacy()`
    - Ensure feature flag can toggle between old and new implementations
    - Add rollback capability to legacy path
    - _Requirements: 13.2, 13.3_
  
  - [ ] 11.2 Add comparison logging
    - Log old vs new prompt sizes side-by-side
    - Log compression ratio per section
    - Log tier classification with reasoning
    - Log token budget violations and resolutions
    - Calculate and log cost savings per request
    - _Requirements: 13.2, 14.1, 14.2_

- [ ] 12. Checkpoint - Validate Phase 2 integration
  - Run integration tests with real session data
  - Verify end-to-end prompt assembly pipeline
  - Test compression fallback triggering
  - Validate tier selection logic with sample questions
  - Verify Redis memory operations under concurrent load
  - Ensure all tests pass, ask the user if questions arise.

### Phase 3: Rollout & Monitoring (Week 5-6)

- [ ] 13. Implement performance monitoring
  - [ ] 13.1 Add Prometheus metrics
    - Create `src/shared/lib/metrics.ts` with Prometheus client
    - Add `prompt_tokens_total` histogram (labels: tier, section)
    - Add `prompt_tokens_reduction_percent` histogram
    - Add `prompt_budget_violations_total` counter (labels: section)
    - Add `compression_applied_total` counter (labels: section, strategy)
    - Add `compression_ratio` histogram (labels: section)
    - _Requirements: 14.1, 14.2_
  
  - [ ] 13.2 Add performance duration metrics
    - Add `prompt_assembly_duration_ms` histogram (labels: tier)
    - Add `compression_duration_ms` histogram (labels: section)
    - Add `memory_store_operation_duration_ms` histogram (labels: operation)
    - Add metric instrumentation to all services
    - _Requirements: 14.3_
  
  - [ ] 13.3 Add error and quality metrics
    - Add `parser_validation_failures_total` counter (labels: reason)
    - Add `memory_store_errors_total` counter (labels: operation)
    - Add `tier_selection_low_confidence_total` counter
    - Add `answer_quality_score` histogram
    - Add `followup_accuracy_score` histogram
    - _Requirements: 14.4, 14.5_
  
  - [ ] 13.4 Create metrics endpoint
    - Add `/metrics` endpoint to Express app
    - Expose Prometheus-compatible metrics
    - Add authentication for metrics endpoint
    - Document metrics in API reference
    - _Requirements: 14.1, 14.2, 14.3, 14.4, 14.5_

- [ ] 14. Set up alerting and dashboards
  - [ ] 14.1 Configure alerting rules
    - Alert on `prompt_budget_violations_total` > 1% of requests
    - Alert on `compression_failures_total` > 0.5% of requests
    - Alert on `answer_quality_score` p50 < 0.80
    - Alert on `memory_store_errors_total` > 5% of operations
    - Document alerting thresholds and runbooks
    - _Requirements: 14.1, 14.2, 14.4, 14.5_
  
  - [ ] 14.2 Create Grafana dashboard
    - Panel for prompt token distribution (before/after comparison)
    - Panel for tier usage distribution (minimal/resume/full)
    - Panel for compression ratios by section
    - Panel for cost savings over time
    - Panel for latency improvements (time-to-first-token)
    - _Requirements: 14.1, 14.2, 14.3_

- [ ] 15. Execute gradual rollout
  - [ ] 15.1 Enable 10% rollout
    - Set `ENABLE_PROMPT_OPTIMIZATION=true`
    - Set `PROMPT_OPT_ROLLOUT_PERCENT=10`
    - Enable side-by-side comparison logging
    - Monitor for 48 hours
    - Validate no regressions in answer quality
    - _Requirements: 13.1, 13.4_
  
  - [ ] 15.2 Scale to 25% rollout
    - Increase `PROMPT_OPT_ROLLOUT_PERCENT=25`
    - Monitor token reduction metrics (target: 60-75%)
    - Monitor cost reduction metrics (target: 60-75%)
    - Monitor latency improvements (target: 200-400ms)
    - Validate follow-up accuracy improvement (target: 15-25%)
    - _Requirements: 13.4, 14.1, 14.2, 14.3, 14.4_
  
  - [ ] 15.3 Scale to 50% rollout
    - Increase `PROMPT_OPT_ROLLOUT_PERCENT=50`
    - Continue monitoring all metrics
    - Collect manual quality review samples (100 answers)
    - Validate no answer quality regression
    - Test rollback procedure
    - _Requirements: 13.4, 14.1, 14.2, 14.3, 14.4, 14.5_
  
  - [ ] 15.4 Scale to 75% rollout
    - Increase `PROMPT_OPT_ROLLOUT_PERCENT=75`
    - Monitor error rate (target: <1%)
    - Validate Redis stability under increased load
    - Check compression failure rate
    - Verify tier distribution matches expectations
    - _Requirements: 13.4, 14.1, 14.2_
  
  - [ ] 15.5 Complete rollout to 100%
    - Set `PROMPT_OPT_ROLLOUT_PERCENT=100`
    - Disable side-by-side comparison logging
    - Archive legacy prompt builder code
    - Update API documentation with new token budgets
    - Announce completion to stakeholders
    - _Requirements: 13.4, 14.1, 14.2, 14.3, 14.4, 14.5_

- [ ] 16. Final validation and documentation
  - Run full regression test suite (100 sample sessions)
  - Validate 60-75% token reduction achieved
  - Validate 60-75% cost reduction achieved
  - Validate 200-400ms latency improvement achieved
  - Validate 15-25% follow-up accuracy improvement achieved
  - Document rollout results and lessons learned
  - Ensure all tests pass, ask the user if questions arise.

## Notes

### Test Task Guidelines

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Property-based tests validate universal correctness properties defined in design document
- Unit tests validate specific compression algorithms and edge cases
- Integration tests validate end-to-end prompt assembly pipeline
- Regression tests validate answer quality and follow-up accuracy improvements

### Task Execution Order

- **Phase 1 (Foundation)**: Build independent services without disrupting existing flow
- **Phase 2 (Integration)**: Connect new services to existing prompt builder with feature flags
- **Phase 3 (Rollout)**: Gradual rollout with monitoring and validation

### Requirements Coverage

Each task explicitly references requirements from `requirements.md` for traceability:
- Tasks 1.1-1.6, 7.4: Memory Store (Requirements 6.x)
- Tasks 2.1-2.3, 4.1-4.4: Token Budget Framework (Requirements 9.x, 11.x)
- Tasks 3.1-3.6: Compression Strategies (Requirements 2.x, 5.x, 7.x, 17.x, 19.x, 20.x)
- Tasks 7.1-7.6: Runtime Context (Requirements 1.x)
- Tasks 8.1-8.4: Active Task (Requirements 3.x, 4.x, 8.x)
- Tasks 9.1-9.2: Context Tier Selection (Requirements 10.x, 18.x)
- Tasks 13.1-13.4, 14.1-14.2: Performance Monitoring (Requirements 14.x)
- Tasks 15.1-15.5: Migration and Rollout (Requirements 13.x)

### Zero Database Schema Changes

- Phase 1 requires NO database migrations (Redis-only state)
- All session state persists in Redis with 2-hour TTL
- Memory structures use JSON serialization for flexibility
- Schema versioning (`memoryVersion: "v1"`) enables forward compatibility

### Rollback Strategy

- Feature flags enable instant rollback to legacy prompt builder
- Side-by-side logging during rollout enables comparison
- Rollback triggers: answer quality drop >10%, error rate >5%, follow-up accuracy drop >5%
- Legacy code preserved until 100% rollout validation complete

## Task Dependency Graph

```json
{
  "waves": [
    {
      "id": 0,
      "tasks": ["1.1", "2.1", "5.1"]
    },
    {
      "id": 1,
      "tasks": ["1.2", "1.3", "1.4", "1.5", "2.2", "3.1", "3.2", "3.3", "3.4", "5.2"]
    },
    {
      "id": 2,
      "tasks": ["1.6", "2.3", "3.5", "3.6", "4.1"]
    },
    {
      "id": 3,
      "tasks": ["4.2", "4.3", "4.4"]
    },
    {
      "id": 4,
      "tasks": ["7.1"]
    },
    {
      "id": 5,
      "tasks": ["7.2", "7.3", "7.4", "7.5", "9.1"]
    },
    {
      "id": 6,
      "tasks": ["7.6", "8.1", "8.2", "9.2"]
    },
    {
      "id": 7,
      "tasks": ["8.3", "8.4", "10.1"]
    },
    {
      "id": 8,
      "tasks": ["10.2", "10.3", "11.1"]
    },
    {
      "id": 9,
      "tasks": ["11.2"]
    },
    {
      "id": 10,
      "tasks": ["13.1", "13.2", "13.3"]
    },
    {
      "id": 11,
      "tasks": ["13.4", "14.1"]
    },
    {
      "id": 12,
      "tasks": ["14.2", "15.1"]
    },
    {
      "id": 13,
      "tasks": ["15.2"]
    },
    {
      "id": 14,
      "tasks": ["15.3"]
    },
    {
      "id": 15,
      "tasks": ["15.4"]
    },
    {
      "id": 16,
      "tasks": ["15.5"]
    }
  ]
}
```
