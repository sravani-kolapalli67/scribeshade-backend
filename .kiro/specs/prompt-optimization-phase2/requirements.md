# Requirements Document

## Introduction

This document specifies the requirements for refactoring ScribeShade's AI answer-generation pipeline to achieve Parakeet-level prompt efficiency. The current system suffers from excessive prompt sizes (4,000-10,000 tokens) due to runtime-context and active-task duplication, causing high API costs, increased latency, and degraded answer quality. The refactored system will target 1,500-3,000 tokens while improving answer quality, context retention, and follow-up accuracy.

## Glossary

- **Runtime_Context**: Persistent session-level data (resume digest, project digest, memory, history) that remains constant across multiple answer requests within a session
- **Active_Task**: Request-specific data (current question, transcript window, intent, evidence) that changes with each answer request
- **System_Prompt**: Static behavioral instructions defining AI personality, formatting rules, and hallucination guards
- **Segmenter**: Frontend component that detects questions and classifies intents from transcript
- **Token_Budget**: Maximum allowed tokens for a specific prompt section
- **Answer_Model**: The AI model (via OpenRouter) that generates interview answers
- **Memory_Store**: Redis-based storage for compressed conversation history and session state
- **Compression_Strategy**: Technique for reducing token usage (summarization, pruning, rolling windows)
- **Prompt_Audit**: Automated validation checking token budgets and structural compliance
- **CIE**: Complexity-aware context engine for determining context depth

## Requirements

### Requirement 1: Runtime Context Architecture

**User Story:** As a developer, I want runtime context to contain only persistent session-level data, so that request-level artifacts do not pollute the context and cause duplication.

#### Acceptance Criteria

1. THE Runtime_Context_Builder SHALL include only resume digest, project digest, memory summary, history summary, document summary, and special instructions
2. THE Runtime_Context_Builder SHALL exclude current question, transcript excerpts, segmenter metadata, active intent IDs, and question evidence
3. THE Runtime_Context_Builder SHALL enforce a total token budget of 800 tokens for runtime context
4. WHEN runtime context exceeds 800 tokens, THE Compression_Engine SHALL apply tier-appropriate compression
5. THE Runtime_Context_Parser SHALL validate that no request-level artifacts exist in runtime context before sending to Answer_Model

### Requirement 2: Resume Digest Compression

**User Story:** As a system architect, I want resume data to exist in only one location (resume digest), so that duplication is eliminated and token usage is minimized.

#### Acceptance Criteria

1. THE Resume_Digest_Generator SHALL create a compressed summary of 120-180 tokens containing key experience, skills, and achievements
2. THE Resume_Digest_Generator SHALL exclude verbose job descriptions, full project narratives, and redundant skill listings
3. THE Resume_Digest_Generator SHALL preserve exact company names, role titles, tools, frameworks, and measurable outcomes
4. WHEN a question is project-related, THE Context_Tier_Selector SHALL allow project digest budget to increase to 450 tokens
5. THE Resume_Digest_Generator SHALL NOT duplicate experience facts that already exist in project digest

### Requirement 3: Question Deduplication

**User Story:** As a developer, I want the current question to appear exactly once in the active task, so that token waste from multiple question representations is eliminated.

#### Acceptance Criteria

1. THE Active_Task_Builder SHALL include the cleaned current question exactly once under a single **QUESTION** section
2. THE Active_Task_Builder SHALL exclude question evidence, reconstructed question, and authoritative question sections
3. THE Segmenter_Output_Filter SHALL remove question text from segmenter metadata before passing to Answer_Model
4. WHEN follow-up context is needed, THE Follow_Up_Resolver SHALL reference prior question by ID, not by repeating question text
5. THE Active_Task_Builder SHALL enforce a 60-token budget for the current question section

### Requirement 4: Segmenter Metadata Sanitization

**User Story:** As a system architect, I want segmenter metadata to be filtered before reaching the answer model, so that confidence scores, fallback sources, and internal IDs do not consume tokens.

#### Acceptance Criteria

1. THE Segmenter_Output_Filter SHALL extract only intent classification and isFollowUp boolean from segmenter output
2. THE Segmenter_Output_Filter SHALL remove confidence scores, detection sources, fallback indicators, and internal turn IDs
3. THE Segmenter_Output_Filter SHALL remove frontend-specific detection metadata (cutoff timestamps, operation IDs, platform tags)
4. THE Active_Task_Builder SHALL include only intent and isFollowUp fields from segmenter output
5. THE Segmenter_Output_Filter SHALL enforce a maximum 40-token budget for included metadata

### Requirement 5: Transcript Compression Strategy

**User Story:** As a developer, I want transcript data to use a rolling window with intent memory, so that only relevant conversation context is sent without full transcript duplication.

#### Acceptance Criteria

1. THE Transcript_Window_Manager SHALL maintain an active window of 3-5 most recent turns (120-180 tokens)
2. THE Transcript_Compressor SHALL create a rolling summary of older turns (80-120 tokens) storing topic, outcome, and decisions
3. THE Intent_Memory_Store SHALL preserve topic keywords and speaker role for each turn in Redis
4. WHEN a follow-up is detected, THE Follow_Up_Resolver SHALL inject only the referenced prior turn (60-100 tokens), not full transcript
5. THE Transcript_Window_Manager SHALL exclude verbatim speaker-separated transcript and raw interim text

### Requirement 6: Memory Architecture

**User Story:** As a developer, I want conversation memory to be stored in Redis with structured compression, so that session state persists efficiently without database bloat.

#### Acceptance Criteria

1. THE Memory_Store SHALL persist topic memory, intent memory, answer memory, and follow-up memory as separate Redis keys
2. THE Memory_Store SHALL use a session-scoped key pattern `memory:{sessionId}:{type}` with 2-hour TTL
3. THE Topic_Memory_Compressor SHALL store topic keywords (max 30 tokens) for last 10 turns
4. THE Answer_Memory_Compressor SHALL store answer summaries (max 60 tokens per answer) for last 5 answers
5. THE Follow_Up_Memory_Store SHALL link child questions to parent answers using turn IDs without duplicating content

### Requirement 7: History Summary Compression

**User Story:** As a developer, I want assistant answer history to be compacted into a summary, so that large answer histories do not consume excessive tokens.

#### Acceptance Criteria

1. THE History_Summary_Generator SHALL create a compressed history of last 3 Q&A pairs (max 180 tokens total)
2. THE History_Summary_Generator SHALL include question topic, answer approach, and code language (if present) for each entry
3. THE History_Summary_Generator SHALL exclude full answer text, markdown formatting, and code blocks from history
4. WHEN a code follow-up is detected, THE Code_Context_Injector SHALL inject only the referenced code block (max 200 tokens), not full answer
5. THE History_Summary_Generator SHALL prune entries older than 15 minutes from summary

### Requirement 8: Active Task Structure

**User Story:** As a developer, I want the active task to contain only request-specific data with strict token budgets, so that each request is lean and focused.

#### Acceptance Criteria

1. THE Active_Task_Builder SHALL include mode, intent, question, transcript excerpt, and request deltas
2. THE Active_Task_Builder SHALL enforce a total token budget of 400 tokens for active task
3. THE Active_Task_Builder SHALL allocate 60 tokens to question, 180 tokens to transcript excerpt, 60 tokens to follow-up anchor, 100 tokens to request deltas
4. WHEN project diagram context is needed, THE Active_Task_Builder SHALL inject architecture flow (max 260 tokens) replacing transcript excerpt budget
5. THE Active_Task_Builder SHALL exclude full segmenter output, detection confidence, and frontend operation metadata

### Requirement 9: Token Budget Framework

**User Story:** As a system architect, I want strict token budgets enforced for every prompt section, so that total prompt size stays under 3,000 tokens.

#### Acceptance Criteria

1. THE Token_Budget_Enforcer SHALL allocate 1200 tokens to system prompt (fixed, never expanded)
2. THE Token_Budget_Enforcer SHALL allocate 800 tokens to runtime context (resume 180, project 250-450, memory 180, history 180, document 120, instructions 80)
3. THE Token_Budget_Enforcer SHALL allocate 400 tokens to active task (question 60, transcript 180, follow-up 60, deltas 100)
4. THE Token_Budget_Enforcer SHALL allocate 600 tokens to answer model output budget flexibility and safety margin
5. WHEN total exceeds 2,400 tokens (before 600 margin), THE Token_Budget_Enforcer SHALL trigger compression or tier reduction

### Requirement 10: Context Tier Selector

**User Story:** As a developer, I want context tier selection based on question intent, so that simple technical questions receive minimal context and complex scenarios receive full context.

#### Acceptance Criteria

1. THE Context_Tier_Selector SHALL classify questions into minimal (800 tokens), resume (1200 tokens), or full (2000 tokens) tiers
2. WHEN intent is EXPLAIN_CODE, DEBUG_CODE, OPTIMIZE_CODE, or NEW_QUESTION (technical), THE Context_Tier_Selector SHALL select minimal tier
3. WHEN intent is EXPERIENCE_QUESTION, BEHAVIORAL, or FOLLOW_UP, THE Context_Tier_Selector SHALL select resume tier
4. WHEN intent is SCENARIO_QUESTION, SYSTEM_DESIGN, or complexity is scenario_based, THE Context_Tier_Selector SHALL select full tier
5. THE Context_Tier_Selector SHALL default to resume tier when intent confidence is below 0.7

### Requirement 11: Prompt Audit Framework

**User Story:** As a developer, I want automated prompt auditing before every AI call, so that token budget violations are caught before reaching the Answer_Model.

#### Acceptance Criteria

1. THE Prompt_Auditor SHALL validate total prompt tokens are under 3000 before calling Answer_Model
2. THE Prompt_Auditor SHALL validate each section (system, runtime, active) is under its allocated budget
3. THE Prompt_Auditor SHALL log warnings when any section exceeds 90% of budget
4. WHEN total exceeds 3000 tokens, THE Prompt_Auditor SHALL reject the request and trigger compression fallback
5. THE Prompt_Auditor SHALL emit structured audit logs containing section sizes, tier, intent, and compression applied

### Requirement 12: Validation Framework

**User Story:** As a QA engineer, I want automated tests that validate prompt token budgets and answer quality, so that regressions are caught before production.

#### Acceptance Criteria

1. THE Prompt_Validation_Suite SHALL include property-based tests generating random session contexts and validating token budgets
2. THE Prompt_Validation_Suite SHALL include regression tests comparing answer quality before and after compression
3. THE Prompt_Validation_Suite SHALL include integration tests validating Redis memory store operations
4. THE Prompt_Validation_Suite SHALL include unit tests for each compression strategy (resume, transcript, history, memory)
5. FOR ALL valid session contexts, THE Token_Budget_Property SHALL verify total prompt tokens remain under 3000

### Requirement 13: Migration Framework

**User Story:** As a developer, I want a phased migration plan with feature flags, so that the refactor can be deployed incrementally without breaking existing functionality.

#### Acceptance Criteria

1. THE Migration_Controller SHALL support feature flags for enabling compression, tiering, and memory store independently
2. THE Migration_Controller SHALL log side-by-side comparisons of old vs new prompt sizes during rollout
3. THE Migration_Controller SHALL support rollback to legacy prompt builder when feature flag is disabled
4. WHEN compression is enabled, THE Migration_Controller SHALL emit migration metrics (token reduction, latency delta, answer quality score)
5. THE Migration_Controller SHALL require zero database schema changes for Phase 1 deployment

### Requirement 14: Performance Impact Measurement

**User Story:** As a product manager, I want measurable improvements in token usage, cost, latency, and answer quality, so that the refactor ROI is quantified.

#### Acceptance Criteria

1. THE Performance_Monitor SHALL track average prompt tokens before (4000-10000) and after (1500-3000) refactor
2. THE Performance_Monitor SHALL track cost per answer (OpenRouter token pricing) showing 60-75% reduction
3. THE Performance_Monitor SHALL track time-to-first-token showing 200-400ms improvement from reduced prompt size
4. THE Performance_Monitor SHALL track follow-up accuracy (manual review of 100 samples) showing 15-25% improvement
5. THE Performance_Monitor SHALL track context retention score (ability to reference prior answers) showing no regression

### Requirement 15: Parser Compliance

**User Story:** As a developer, I want all compressed prompt sections to remain parser-safe, so that downstream markdown parsing does not break.

#### Acceptance Criteria

1. THE Compression_Engine SHALL preserve markdown structure (headers, bullets, code fences) during compression
2. THE Compression_Engine SHALL avoid truncating mid-sentence or mid-code-block
3. THE Compression_Engine SHALL escape special characters that could break parser delimiters (**QUESTION:**, **ANSWER:**, ===NEXT_QUESTION===)
4. THE Active_Task_Builder SHALL validate compressed output matches expected section headers before sending to Answer_Model
5. THE Parser_Validator SHALL reject compressed output containing stray markdown artifacts (unclosed code fences, broken bullets)

### Requirement 16: System Prompt Stability

**User Story:** As a system architect, I want the system prompt to remain unchanged, so that behavioral consistency is maintained while runtime context is optimized.

#### Acceptance Criteria

1. THE System_Prompt_Builder SHALL use the existing fixed prompt (identity, behavior, hallucination guard, markdown contract, voice rules)
2. THE System_Prompt_Builder SHALL NOT inject runtime context into system prompt
3. THE System_Prompt_Builder SHALL NOT expand system prompt beyond 1200 tokens
4. WHEN prompt caching is enabled, THE Cache_Controller SHALL cache system prompt with 2-hour TTL
5. THE System_Prompt_Validator SHALL verify system prompt hash matches baseline before deployment

### Requirement 17: Code Context Optimization

**User Story:** As a developer, I want code context to be injected only when needed and truncated appropriately, so that code follow-up questions do not cause token bloat.

#### Acceptance Criteria

1. WHEN a code follow-up is detected, THE Code_Context_Injector SHALL inject only the referenced code block (max 200 tokens)
2. THE Code_Context_Injector SHALL truncate code blocks longer than 200 tokens by preserving function signatures and removing implementation
3. THE Code_Context_Injector SHALL include language tag and line count metadata (5 tokens) with truncated blocks
4. THE Code_Context_Injector SHALL NOT inject code context when intent is not code-related (BEHAVIORAL, EXPERIENCE_QUESTION, NEW_QUESTION)
5. THE Code_Context_Validator SHALL verify code fences are properly closed after truncation

### Requirement 18: Project Digest Dynamic Budget

**User Story:** As a developer, I want project digest budget to scale based on question type, so that project questions get more context while technical questions remain lean.

#### Acceptance Criteria

1. WHEN intent is EXPERIENCE_QUESTION or question contains project keywords, THE Project_Budget_Allocator SHALL allocate 450 tokens to project digest
2. WHEN intent is technical (EXPLAIN_CODE, DEBUG_CODE, OPTIMIZE_CODE), THE Project_Budget_Allocator SHALL allocate 0 tokens to project digest
3. WHEN intent is BEHAVIORAL or SCENARIO_QUESTION, THE Project_Budget_Allocator SHALL allocate 250 tokens to project digest
4. THE Project_Digest_Compressor SHALL prioritize selected projects (PRIMARY label) over resume-backed projects
5. THE Project_Digest_Compressor SHALL include problem, role, tools, and impact for each project (max 90 tokens per project)

### Requirement 19: Document Summary Compression

**User Story:** As a developer, I want document summaries to be compressed to 120 tokens, so that supporting documents do not dominate runtime context.

#### Acceptance Criteria

1. THE Document_Summary_Generator SHALL compress uploaded documents to 120 tokens maximum
2. THE Document_Summary_Generator SHALL extract key concepts, terminology, and business context
3. THE Document_Summary_Generator SHALL exclude verbose descriptions, filler content, and repeated concepts
4. WHEN document is code-heavy (API docs, technical specs), THE Document_Summary_Generator SHALL prioritize function signatures and data structures
5. THE Document_Summary_Generator SHALL tag document type (technical, business, product) for context tier decisions

### Requirement 20: Special Instructions Budget

**User Story:** As a user, I want custom instructions to be honored within an 80-token budget, so that personalized guidance is preserved without causing bloat.

#### Acceptance Criteria

1. THE Instructions_Compressor SHALL enforce an 80-token budget for special instructions
2. WHEN user instructions exceed 80 tokens, THE Instructions_Compressor SHALL prioritize domain-specific guidance over general preferences
3. THE Instructions_Compressor SHALL preserve exact terminology, acronyms, and company-specific keywords
4. THE Instructions_Validator SHALL warn users when instructions are truncated during compression
5. THE Instructions_Compressor SHALL exclude redundant guidance already covered in system prompt (e.g., "be concise")
