# ScribeShade Session Architecture

## Overview

The ScribeShade session system is a real-time interview assistant that captures audio, transcribes it, detects questions, and generates AI-powered answers. The system spans both frontend (Tauri + React) and backend (Express + TypeScript) with real-time communication via SSE.

## Tech Stack

### Frontend
- **Framework**: React 19 + TypeScript + Vite
- **Desktop Shell**: Tauri v2
- **State Management**: Redux Toolkit
- **Styling**: Tailwind CSS v4 + shadcn/ui
- **Speech Recognition**: Deepgram SDK (via Tauri plugins)
- **Audio Capture**: Tauri system audio capture + microphone
- **Real-time Events**: SSE (Server-Sent Events)

### Backend
- **Server**: Express 5 + TypeScript
- **Database**: PostgreSQL + Prisma ORM
- **AI**: OpenRouter SDK (multi-model support)
- **Job Queue**: BullMQ + Redis
- **Speech**: Deepgram SDK
- **Auth**: Clerk (@clerk/express)
- **Real-time**: SSE (custom SSEManager)

## Architecture Layers

```
┌─────────────────────────────────────────────────────────────────┐
│                        Frontend (Tauri)                          │
├─────────────────────────────────────────────────────────────────┤
│  FloatingApp.tsx → useFloatingSession → useAIChat              │
│       ↓                    ↓                    ↓                │
│  Audio Capture      Transcript Handling    AI Answer Request    │
│  (Tauri events)     (Redux + Local State)  (POST /ai-answer)    │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│                      Backend (Express)                           │
├─────────────────────────────────────────────────────────────────┤
│  session.router → session.service → AI Layer → OpenRouter       │
│       ↓                  ↓               ↓           ↓            │
│  Auth Middleware  Question Detection  Policy   Stream Response   │
│  (Clerk)          (answer-quality)   (answer-policy)            │
│                       ↓                                           │
│  Memory/Context Layer (Prisma + History)                          │
└─────────────────────────────────────────────────────────────────┘
```

## Key Files and Responsibilities

### Frontend

| File | Purpose |
|------|---------|
| `src/pages/Sessions/ActiveSession/FloatingApp.tsx` | Main floating overlay UI component (~1500 lines) |
| `src/features/session/hooks/useFloatingSession.ts` | Core session logic hook (~2600 lines) |
| `src/hooks/useAIChat.ts` | AI chat hook for custom queries (~1800 lines) |
| `src/hooks/useDeepgram.ts` | Deepgram speech recognition for mic audio |
| `src/hooks/useNativeTabTranscription.ts` | Native tab audio transcription |
| `src/store/slices/sessionsSlice.ts` | Redux state for sessions |
| `src/lib/intent-detector.ts` | Intent detection for filler phrases |
| `src/types/ai-answer.ts` | TypeScript types for AI answer payloads |

### Backend

| File | Purpose |
|------|---------|
| `src/features/session/session.service.ts` | Core session service (~2000 lines) |
| `src/features/session/session.controller.ts` | HTTP route handlers |
| `src/features/session/session.router.ts` | Route definitions |
| `src/features/session/answer-quality.ts` | Question detection, follow-up resolution (~624 lines) |
| `src/features/session/answer-policy.ts` | Answer intent classification, policy generation (~248 lines) |
| `src/features/session/ai-session-decision.ts` | AI-based session state decision (~378 lines) |
| `src/features/session/cie.service.ts` | Complexity-aware context engine |
| `src/shared/lib/prompt.ts` | System/user prompt construction (~660 lines) |
| `src/shared/lib/sse.ts` | SSE manager for real-time events |
| `src/shared/lib/prisma.ts` | Prisma client singleton |
| `prisma/schema.prisma` | Database schema |

## Question Detection Layer

### Frontend Detection (`useFloatingSession.ts`)

**Location**: Lines 1990-2109

**Flow**:
1. User clicks "AI Answer" button
2. Apply 600ms semantic debounce (`ACTIVE_QUESTION_DEBOUNCE_MS`)
3. Capture snapshot of messages and interim transcript
4. Call `detectActiveQuestion()` with:
   - `liveInterimText`: Current interim transcript from tab audio
   - `allMessages`: Filtered Interviewer/User messages
   - `cutoffTimestamp`: Time of last AI answer (prevents re-answering)
   - `selectedAnswerQuestion`: Last answered question (for follow-up detection)
   - `selectedAnswerId`: Last answered message ID

**Detection Logic** (`detectActiveQuestion`):
- Prioritizes live interim text over historical messages
- Uses cutoff timestamp to avoid re-answering old questions
- Fallback to recent N messages if no interim text available
- Follow-up detection via `referencedHistoryTurnId`

### Backend Detection (`answer-quality.ts`)

**Location**: Lines 156-175

**Regex Patterns**:
```typescript
const CODE_REF_RE = /\b(this code|the code|your code|same query|the same query|same code|...)\b/i;
const OPTIMIZE_FOLLOWUP_RE = /\b(optimi[sz]e|what if (?:the|this|that|same)\b.*\b(?:query|code|logic)|...)\b/i;
const DEBUG_FOLLOWUP_RE = /\b(debug|fix|bug|error|issue|failing)\b/i;
const SCENARIO_FOLLOWUP_RE = /\b(scenario|suppose|imagine|case where|incident|outage|...)\b/i;
const EXPLICIT_EXPERIENCE_RE = /\b(your experience|your project|years? of experience|...)\b/i;
```

**Classification** (`classifyConversationIntent`):
- Returns one of: `EXPLAIN_CODE`, `DEBUG_CODE`, `OPTIMIZE_CODE`, `SCENARIO_QUESTION`, `EXPERIENCE_QUESTION`, `FOLLOW_UP`, `CONTINUE_PREVIOUS`, `NEW_QUESTION`, `UNKNOWN`
- Order of checks: `CODE_REF_RE` → `DEBUG_FOLLOWUP_RE` → `OPTIMIZE_FOLLOWUP_RE` → `EXPLICIT_EXPERIENCE_RE` → `SCENARIO_FOLLOWUP_RE` → `FOLLOWUP_RE` → `NEW_QUESTION`

### AI-Enhanced Detection (`ai-session-decision.ts`)

**Location**: Lines 144-203

**Flow**:
1. Backend calls `decideAISessionState()` with OpenRouter
2. AI model analyzes question + recent history
3. Returns structured decision with:
   - `intent`: e.g., `OPTIMIZE_CODE`, `EXPLAIN_CODE`, `NEW_QUESTION`
   - `isFollowUp`: Boolean flag
   - `targetAnswerId`: Which previous answer to reference
   - `requiresPreviousCode`: Whether code context is needed
   - `contextToUse`: `previous_code`, `previous_answer`, or `none`
   - `confidence`: 0-1 score

**Fallback**: If AI call fails or confidence < threshold, uses deterministic regex-based classification from `answer-quality.ts`

## Memory/Context Layer

### Frontend Memory

**Redux State** (`sessionsSlice.ts`):
- `messages`: Array of interview transcript messages
- `aiChat`: Array of AI-generated answers
- `currentResponseIndex`: Index of currently displayed AI answer
- `isAnswering`: Boolean flag for AI generation state

**Local State** (`useFloatingSession.ts`):
- `messagesRef.current`: Ref to latest messages (bypasses React re-renders)
- `lastAnswerTimestampRef.current`: Timestamp of last successful AI answer
- `answeredQuestionsHistoryRef.current`: History of answered questions for dedup
- `operationRegistryRef.current`: Registry for preventing duplicate operations

**Context Enrichment** (Lines 2204-2218):
```typescript
const recentAiAnswersForContext = [...aiChat]
  .filter((m) => m.sender === "AI" && m.text?.trim())
  .slice(-2);
const contextPreamble = recentAiAnswersForContext
  .map((m, i) => {
    const q = m.question?.trim() || "";
    const a = m.text?.trim() ?? "";
    return q
      ? `[Prior answer ${i + 1}]\nQ: ${q}\nA: ${a.slice(0, 600)}...`
      : `[Prior answer ${i + 1}]\n${a.slice(0, 600)}...`;
  })
  .join("\n\n");
```

### Backend Memory

**Database Schema** (`prisma/schema.prisma`):
```prisma
model Session {
  id              String   @id @default(uuid())
  messages        Json
  transcript      Json
  jobDescription  String?
  language        String?
  simpleLanguage  Boolean  @default(false)
  extraContext    String?
  resumeId        String?
  documentId      String?
  projectIds      String[]
  userId          String
  companyId       String?
  // ... other fields
}
```

**Message Structure**:
```typescript
{
  messageId: string,
  role: "INTERVIEWER" | "AI_ASSISTANT" | "USER",
  question: string,
  answer: string,
  timestamp: string,
  time: string,
  snapshotId?: string
}
```

**History Extraction** (`answer-quality.ts`, Lines 374-395):
```typescript
export function toAnswerHistory(messagesRaw: unknown): AnswerHistoryEntry[] {
  return raw
    .filter((m) => m && m.role === "AI_ASSISTANT" && typeof m.answer === "string")
    .map((m, idx) => ({
      id: String(m.messageId || m.id || `ai-${idx}`),
      question: String(m.question || ""),
      answer: String(m.answer || ""),
      timestamp: new Date(m.timestamp || Date.now()).getTime(),
      codeBlocks: extractCodeBlocksFromText(answer),
      topic: deriveTopicFromText(`${question} ${answer}`),
      orderIndex: idx,
    }))
    .sort((a, b) => a.timestamp - b.timestamp);
}
```

**Follow-up Target Resolution** (`answer-quality.ts`, Lines 397-565):
- Uses regex patterns to detect explicit follow-up references
- Scores history entries by topic overlap, recency, code presence
- Returns:
  - `target`: The matched `AnswerHistoryEntry`
  - `source`: `"selected_answer"`, `"topic_match"`, `"latest_code"`, `"immediate_previous"`, or `"none"`
  - `targetConfidence`: 0-1 score
  - `reasonForNoTarget`: Explanation if no target found

## AI Answer Generation Flow

### Frontend Request (`useFloatingSession.ts`, Lines 2259-2294)

**Payload Construction**:
```typescript
const payload: AIAnswerRequestPayload = {
  requestId: opRequestId,
  sessionId: info.sessionId,
  transcript: enrichedTranscript,  // Includes Q&A preamble
  currentQuestion: effectiveCurrentQuestion,
  recentTranscriptWindow,
  speakerSeparatedTranscript,
  previousAiAnswer: latestAiAnswer,  // Always preserved
  previousCodeBlocks: extractCodeBlocks(latestAiAnswer),
  selectedAnswerId: selectedAiMessage?.id,
  selectedAnswerQuestion: selectedAnswerQuestion,
  selectedAnswerText: selectedAnswerText,
  selectedAnswerCodeBlocks: selectedAnswerCodeBlocks,
  selectedAnswerTopic: selectedAnswerTopic,
  activeQuestionDetection: {
    activeQuestion: question,
    cleanedQuestion: effectiveCurrentQuestion,
    isFollowUp: effectiveDetection.isFollowUp,
    topicChanged: effectiveDetection.topicChanged,
    confidenceScore: effectiveDetection.confidenceScore,
    referencedHistoryTurnId: effectiveDetection.referencedHistoryTurnId,
  },
  answerMode: "auto",
  sourcePlatform: "tauri",
};
```

### Backend Processing (`session.service.ts`, Lines 1143-1572)

**Step 1: Session Lookup** (Lines 1152-1174)
- Fetch session with all context fields
- Return 404 if not found

**Step 2: Context Building** (Lines 1176-1243)
- If regenerate: Use snapshot context
- Otherwise: Call `buildOptimizedContext()` which:
  - Fetches resume, document, projects from DB
  - Builds RAG context via embeddings
  - Calculates complexity tier (`simple_atomic`, `simple_contextual`, `followup`, `scenario_based`)

**Step 3: Question Detection** (Lines 1254-1268)
```typescript
const guard = guardCurrentQuestion({
  resolvedQuestion: originalResolvedQuestion,
  recentTranscriptWindow: liveContextMetadata?.recentTranscriptWindow,
});
const history = toAnswerHistory((session as any).messages);
const conversationIntent = classifyConversationIntent(guard.resolvedCurrentQuestion);
const followup = resolveFollowupTarget({
  question: guard.resolvedCurrentQuestion,
  history,
  selectedAnswerId: liveContextMetadata?.selectedAnswerId,
  selectedAnswerQuestion: liveContextMetadata?.selectedAnswerQuestion,
  selectedAnswerText: liveContextMetadata?.selectedAnswerText,
  selectedAnswerCodeBlocks: liveContextMetadata?.selectedAnswerCodeBlocks,
  selectedAnswerTopic: liveContextMetadata?.selectedAnswerTopic,
});
```

**Step 4: AI Decision** (Lines 1269-1300)
```typescript
const aiDecisionResult = await decideAISessionState({
  ai,
  model: targetModel,
  provider: latencyOptimizedProvider,
  fallback: fallbackAISessionDecision({ currentQuestion, conversationIntent, followup }),
  input: {
    currentQuestion: guard.resolvedCurrentQuestion,
    recentTranscriptWindow: liveContextMetadata?.recentTranscriptWindow,
    speakerSeparatedTranscript: liveContextMetadata?.speakerSeparatedTranscript,
    activeQuestionDetection: detection,
    previousAiAnswer: liveContextMetadata?.previousAiAnswer,
    previousCodeBlocks: liveContextMetadata?.previousCodeBlocks,
    selectedAnswerId: liveContextMetadata?.selectedAnswerId,
    selectedAnswerQuestion: liveContextMetadata?.selectedAnswerQuestion,
    selectedAnswerText: liveContextMetadata?.selectedAnswerText,
    selectedAnswerTopic: liveContextMetadata?.selectedAnswerTopic,
    answerHistory: toDecisionContextTargets(history),
    deterministic: {
      conversationIntent,
      isExplicitFollowupReference: followup.isExplicitFollowupReference,
      fallbackTargetId: followup.target?.id || null,
      fallbackTargetHasCode: !!followup.target?.codeBlocks?.length,
      fallbackTargetTopic: followup.target?.topic || null,
      reasonForNoTarget: followup.reasonForNoTarget,
    },
  },
});
```

**Step 5: Context Binding** (Lines 1301-1403)
- Determine if follow-up context should be used
- Resolve target answer (AI decision or fallback)
- Build effective metadata with preserved `previousAiAnswer`/`previousCodeBlocks`
- Select code context from target if code follow-up

**Step 6: Policy Construction** (Lines 1406-1467)
```typescript
const systemPrompt = buildSystemMessage(contextForCall);
const baseUserMessage = buildUserMessage(
  guard.resolvedCurrentQuestion,
  isCustomQuery,
  isRegenerate,
  contextForCall,
);
const policy = buildRequestScopedPolicy({
  question: guard.resolvedCurrentQuestion,
  metadata: effectiveMetadata,
  cieComplexity: contextForCall?.complexity,
  aiDecision,
});
const codeFollowupConstraint = (followup.isExplicitFollowupReference || aiDecision.requiresPreviousCode)
  && selectedCodeContext.codeBlocks.length > 0
  ? "\n- Answer ONLY using the selected prior answer/code as the follow-up target."
  : "";
const selectedAnswerExcerptBlock = followup.isExplicitFollowupReference && selectedTargetForRequest?.answer
  ? `\nFOLLOW-UP ANSWER CONTEXT:\nSelected prior answer excerpt:\n${selectedTargetForRequest.answer.slice(0, 800)}`
  : "";
const userMessage = `${policy.policyBlock}${codeFollowupConstraint}\n${policy.codeContextBlock}${selectedAnswerExcerptBlock}${noCodeFollowupGuidance}\n\n${baseUserMessage}`;
```

**Step 7: AI Call** (Lines 1529-1552)
```typescript
const result = ai.callModel({
  model: targetModel,
  maxOutputTokens: resolveAnswerMaxOutputTokens({
    complexity: contextForCall?.complexity,
    question: guard.resolvedCurrentQuestion,
    isRegenerate,
    hasProjects: !!contextForCall?.hasSelectedProjects,
  }),
  provider: latencyOptimizedProvider,
  store: false,
  sessionId: id,
  input: [
    { role: "system", type: "message", content: systemPrompt },
    { role: "user", type: "message", content: userMessage },
  ],
});
```

**Step 8: Stream Processing** (Lines 1554-1560)
- Return generator via `processAIStream()`
- Stream chunks to frontend via SSE

### Frontend Response Handling

**Stream Consumption** (`useAIChat.ts`):
- Read stream chunks
- Accumulate answer text
- Update UI in real-time
- Save final answer to backend via `/save-message`

## Complexity-Aware Context Engine (CIE)

**Location**: `src/features/session/cie.service.ts`

**Tiers**:
1. **simple_atomic**: ~20 tokens wrapper for very simple questions
2. **simple_contextual**: ~30 tokens wrapper with context reminder
3. **followup**: ~120 tokens with follow-up handling
4. **scenario_based**: Full verbose prompt for complex scenarios

**Detection**:
- Analyzes question length, complexity, and context
- Returns tier string used in prompt construction

## Answer Policy Layer

**Location**: `src/features/session/answer-policy.ts`

**Intents**:
- `concept_explanation`: Theory/concept questions
- `behavioral_project_experience`: Experience/project questions
- `code_generation`: Code writing requests
- `code_explanation_followup`: Explain existing code
- `code_debug_followup`: Debug existing code
- `code_optimization_followup`: Optimize existing code
- `system_design`: Architecture questions
- `scenario_based`: Scenario-based questions
- `general_followup`: Generic follow-ups

**Policy Rules**:
- Suppresses experience for concept explanations unless explicitly asked
- Injects code context for code follow-ups
- Enforces specific answer shapes (bullets, sections)
- Controls code generation vs theory-only modes

## Real-Time Events (SSE)

**Location**: `src/shared/lib/sse.ts`

**SSEManager**:
- Maps session IDs to Sets of Response objects
- Broadcasts events to all connected clients
- Event types:
  - `transcript`: New transcript chunk
  - `ai_answer_chunk`: AI streaming response
  - `ai_answer_complete`: AI answer finished
  - `session_state`: Session state changes

**Frontend SSE Hook** (`useSessionSSE.ts`):
- Connects to `/session/:id/events`
- Handles event types
- Updates Redux state

## Audio Capture Layer

### Mic Audio (`useDeepgram.ts`)
- Uses Deepgram SDK
- Captures microphone audio
- Streams to Deepgram for transcription
- Returns interim and final transcripts

### Tab Audio (`useNativeTabTranscription.ts`)
- Uses Tauri system audio capture
- Captures tab audio (interviewer audio)
- Streams to Deepgram via Tauri backend
- Returns interim and final transcripts

### Interim Commit Timers

**Mic** (`STT_INTERIM_FALLBACK_MS = 600ms`):
- If no final transcript received within 600ms, commit interim as final

**System/Tab** (`SYSTEM_STT_INTERIM_FALLBACK_MS = 300ms`):
- Faster commit for system audio (300ms)

## Credit System

**Hold on Creation**:
- Credits held from `totalAvailable` to `heldCredits` when session created

**Deduction on Completion**:
- BullMQ job `credit-deduction` runs after session completes
- Final deduction based on AI usage tokens
- Releases hold from `heldCredits`

**Hold Expiry**:
- BullMQ job `hold-expiry` runs 10 minutes after creation
- Cleans up sessions stuck in `PRE_CHECK` state

## Session State Machine

```
PRE_CHECK → ACTIVE ↔ PAUSED → COMPLETING → COMPLETED
           ↓
         CREDIT_EXHAUSTED → COMPLETED
           ↓
         ABANDONED / FORCE_ENDED / AUTO_ENDED
```

**Transitions**:
- `PRE_CHECK`: Initial state, credits held
- `ACTIVE`: Recording in progress
- `PAUSED`: Recording paused
- `COMPLETING`: Finalizing session
- `COMPLETED`: Session finished, credits deducted
- `CREDIT_EXHAUSTED`: Credits ran out during session
- `ABANDONED`: User abandoned session
- `FORCE_ENDED`: Admin force-ended
- `AUTO_ENDED`: System auto-ended due to inactivity

## Data Flow Diagram

```
┌─────────────┐
│   User      │
│ (Interview) │
└──────┬──────┘
       │ speaks
       ↓
┌─────────────────────────────────────────────────────────────┐
│ Tauri Audio Capture (Mic + Tab)                              │
│ - Deepgram SDK for mic                                       │
│ - Native tab audio capture                                   │
└──────┬──────────────────────────────────────────────────────┘
       │ interim/final transcripts
       ↓
┌─────────────────────────────────────────────────────────────┐
│ useFloatingSession (Frontend)                                │
│ - Update Redux messages                                     │
│ - Update local state refs                                   │
│ - Apply interim commit timers                                │
└──────┬──────────────────────────────────────────────────────┘
       │ user clicks "AI Answer"
       ↓
┌─────────────────────────────────────────────────────────────┐
│ Question Detection (Frontend)                                │
│ - detectActiveQuestion()                                     │
│ - 600ms semantic debounce                                   │
│ - Capture snapshot of messages + interim                    │
└──────┬──────────────────────────────────────────────────────┘
       │ POST /api/session/:id/ai-answer
       ↓
┌─────────────────────────────────────────────────────────────┐
│ session.service (Backend)                                    │
│ - Clerk auth middleware                                      │
│ - Fetch session from DB                                      │
│ - buildOptimizedContext() (resume, docs, projects, RAG)     │
└──────┬──────────────────────────────────────────────────────┘
       │
       ↓
┌─────────────────────────────────────────────────────────────┐
│ Question Detection (Backend)                                 │
│ - guardCurrentQuestion()                                     │
│ - classifyConversationIntent() (regex)                       │
│ - resolveFollowupTarget() (history matching)                │
│ - decideAISessionState() (AI model)                          │
└──────┬──────────────────────────────────────────────────────┘
       │
       ↓
┌─────────────────────────────────────────────────────────────┐
│ Context Binding                                              │
│ - Determine if follow-up context needed                      │
│ - Resolve target answer from history                         │
│ - Preserve previousAiAnswer/previousCodeBlocks               │
│ - Select code context if code follow-up                      │
└──────┬──────────────────────────────────────────────────────┘
       │
       ↓
┌─────────────────────────────────────────────────────────────┐
│ Policy Construction                                           │
│ - buildSystemMessage() (system prompt)                      │
│ - buildUserMessage() (user prompt + complexity tier)        │
│ - buildRequestScopedPolicy() (answer intent + rules)        │
│ - Inject code context if needed                              │
└──────┬──────────────────────────────────────────────────────┘
       │
       ↓
┌─────────────────────────────────────────────────────────────┐
│ AI Call (OpenRouter)                                         │
│ - Call model with system + user prompts                      │
│ - Stream response chunks                                     │
└──────┬──────────────────────────────────────────────────────┘
       │ SSE stream
       ↓
┌─────────────────────────────────────────────────────────────┐
│ Frontend Stream Handling                                      │
│ - Accumulate chunks                                          │
│ - Update UI in real-time                                     │
│ - Extract code blocks for next context                       │
└──────┬──────────────────────────────────────────────────────┘
       │
       ↓
┌─────────────────────────────────────────────────────────────┐
│ Save to Backend                                               │
│ - POST /api/session/:id/save-message                        │
│ - Append to session.messages array                           │
│ - Append to session.transcript array (if enabled)            │
└─────────────────────────────────────────────────────────────┘
```

## Key Constants

### Frontend
- `ACTIVE_QUESTION_DEBOUNCE_MS = 600`: Debounce before AI answer
- `STT_INTERIM_FALLBACK_MS = 600`: Mic interim commit timeout
- `SYSTEM_STT_INTERIM_FALLBACK_MS = 300`: System audio interim commit timeout
- `FIRST_ANSWER_WINDOW_MS = 120000`: Window for first answer without cutoff

### Backend
- `AI_DECISION_CONFIDENCE_THRESHOLD = 0.62`: Minimum AI confidence to use decision
- `ACTIVE_QUESTION_CONFIDENCE_THRESHOLD = 0.58`: Minimum detection confidence
- `HIGH_CONFIDENCE_THRESHOLD = 1.5`: High confidence for follow-up matching

## Testing

### Unit Tests
- `answer-quality.test.ts`: Question detection, follow-up resolution
- `answer-policy.test.ts`: Answer intent classification
- `ai-session-decision.test.ts`: AI decision normalization
- `cie.service.test.ts`: Complexity engine tests

### Integration Tests
- `test-session-integration.ts`: Full session flow with real API calls
- Test bypass mechanism for auth (development only)

## Known Issues and Edge Cases

1. **Weak Follow-up Detection**: Vague deictic references ("that", "this") may not resolve correctly
2. **Topic Change Detection**: May incorrectly flag follow-ups as topic changes
3. **Code Context Loss**: If regex patterns miss code references, context may be stripped (mitigated by always preserving `previousAiAnswer`)
4. **SSE Connection Drops**: Frontend should reconnect on disconnect
5. **Race Conditions**: Multiple rapid AI Answer clicks are now allowed (dedup via operation registry)

## Recent Improvements

1. **Faster Interim Commit**: Reduced timers from 1500ms/700ms to 600ms/300ms
2. **Code Reference Detection**: Added "same query", "same code" patterns to regex
3. **Context Preservation**: Always preserve `previousAiAnswer`/`previousCodeBlocks` regardless of follow-up classification
4. **Transcript Enrichment**: Prepend last 2 AI Q&A pairs to transcript for guaranteed context
5. **Keyword Highlighting**: Added colored background + higher contrast text for inline code
