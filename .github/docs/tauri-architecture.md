# ScribeShade Tauri Desktop App Architecture

## Overview

ScribeShade is a **desktop-first productivity application** built with Tauri v2, React, TypeScript, and Vite. Unlike traditional single-page web apps, it uses a **multi-window architecture** with three specialized windows that work together to provide real-time interview coaching, AI-powered assistance, and seamless user experience.

## Architecture Philosophy

- **No dashboard at startup**: The app does NOT load a full dashboard window on launch. Only the `mini` (floating screen) and `launcher` (widget) windows are initialized, both with `visible: false`. The dashboard window is created **lazily** only when the user explicitly needs it.
- **External URLs open in system browser**: All external navigation (dashboard links, billing, etc.) uses `@tauri-apps/plugin-opener` to open the system browser, never the webview.
- **Cross-platform compatibility**: All Rust code (`src-tauri/`) must compile on Windows, macOS, and Linux. Use `cfg(target_os)` for platform-specific code.
- **Runtime Tauri detection**: Use `isTauri()` from `src/lib/utils.ts` (`"__TAURI__" in window`) for runtime checks. Never use environment variables or user-agent sniffing.

---

## Window Architecture

The app has three windows defined in `tauri.conf.json`:

| Window Label | HTML Entry | Purpose | Visibility at Startup | Size | Always On Top |
|---|---|---|---|---|---|
| `mini` | `floating.html` → `FloatingApp.tsx` | Active session transcription overlay | `false` | 700×360 | Yes |
| `launcher` | `launcher.html` → `WidgetApp.tsx` | Always-visible floating widget | `false` | 460×260 | Yes |
| `main` | `index.html` → `App.tsx` | Full dashboard | **Not created at startup** | Dynamic | No |

### Window 1: Launcher Widget (`launcher`)

**File:** `src/pages/Launcher/WidgetApp.tsx`

**Purpose:** The launcher widget is a compact, always-on-top floating window that provides quick access to app features without requiring the full dashboard.

**Key Features:**
- **Session Creation UI**: Form to create new interview sessions with:
  - Company name
  - Job description
  - Language/tech stack selection
  - Resume selection
  - Document upload
  - AI model selection
  - Simple language mode toggle
  - Auto-generate response toggle
  - Save transcription toggle
- **Credits Display**: Shows current credit balance with real-time updates
- **Quick Actions**: 
  - Open main dashboard
  - Open billing
  - Open past sessions
  - Inspect app info
  - Settings (zoom, opacity, private mode)
- **Authentication**: Integrated with Clerk auth with persisted sessions
- **Auto-update Check**: Invokes `checkForUpdates()` on mount to check for app updates
- **Collapsible State**: Can collapse to a minimal icon when not in use
- **Draggable**: Users can reposition the widget on screen

**Technical Details:**
- Transparent window (`transparent: true`, `shadow: false`, `decorations: false`)
- Skip taskbar (`skipTaskbar: true`)
- Visible on all workspaces (`visibleOnAllWorkspaces: true`)
- Uses `useCursorPassthrough` hook for click-through behavior
- Uses `useOverlayShortcuts` for keyboard shortcuts
- Uses `useSafeZoom` for zoom level management
- Mounted to DOM via `createRoot` in `launcher.html`

**State Management:**
- Redux for global state (settings, session flow, menu state)
- Local storage for zoom, opacity, private mode settings
- Clerk auth for user authentication

---

### Window 2: Floating Screen (`mini`)

**File:** `src/pages/Sessions/ActiveSession/FloatingApp.tsx`

**Purpose:** The floating screen is a lightweight overlay window that displays AI-powered answers and chat during active interview sessions. It's designed to be unobtrusive while providing real-time coaching.

**Key Features:**
- **AI Chat Interface**: Streaming AI responses with markdown rendering
  - Code syntax highlighting with Prism.js
  - Copy-to-clipboard for code blocks
  - Keyword highlighting with color-coded categories
- **Real-time Transcription**: Displays live transcription from the interview
- **Model Selector**: Allows switching between different AI models (Claude, GPT, Gemini)
- **Action Buttons**:
  - AI Answer: Generate answer from transcript
  - Analyze Screen: Capture and analyze screenshot
  - Copy, Delete, Star, etc.
- **Session Controls**:
  - Exit session
  - Toggle fullscreen
  - Menu access
- **Language Support**: Multi-language support with language code mapping
- **Transparent Background**: Semi-transparent for overlay visibility
- **Draggable and Resizable**: Users can position and size the window

**Technical Details:**
- Transparent window (`transparent: true`, `decorations: false`)
- Always on top (`alwaysOnTop: true`)
- Skip taskbar (`skipTaskbar: true`)
- Visible on all workspaces (`visibleOnAllWorkspaces: true`)
- Accept first mouse (`acceptFirstMouse: true`) for instant interaction
- Uses `useCursorPassthrough` for click-through behavior
- Uses `useSafeZoom` for zoom management
- Uses `useFloatingSession` hook for session state management
- SSE (Server-Sent Events) for real-time updates

**Chat Features:**
- Streaming AI responses via `consumeSegmentedStream`
- Question/Answer segmentation with `===NEXT_QUESTION===` separator
- Preamble filtering to remove meta text
- Deduplication of recent questions (4-second window)
- Regenerate support for re-answering questions
- Custom query support for follow-up questions
- Markdown rendering with ReactMarkdown + remarkGfm

---

### Window 3: Main Dashboard (`main`)

**File:** `src/App.tsx` (mounted in `index.html`)

**Purpose:** The main dashboard is a full-featured web application that provides comprehensive session management, analytics, billing, and settings. It is created **lazily** only when needed.

**Creation Trigger:**
- Invoked via Tauri command `open_main_dashboard` from `src-tauri/src/lib.rs`
- Can be created with specific routes, show_create flag, or free session flag
- Can be created invisible (`visible: false`) for background processing

**Key Features:**
- **Full Session Management**: 
  - Create, view, manage interview sessions
  - Session analytics and insights
  - Transcript viewing and editing
  - Session notes generation
- **Resume Builder**: 
  - AI-powered resume editing
  - ATS scoring
  - Cover letter generation
  - Template management
- **Billing & Credits**:
  - Credit balance view
  - Purchase credits
  - View transaction history
  - Credit bracket management
- **Document Management**:
  - Upload supporting documents
  - View document content
  - Link documents to sessions
- **Analytics**:
  - Session performance analytics
  - Q&A history
  - Company-specific insights
- **Settings**:
  - Profile management
  - Preferences
  - Account settings

**Navigation Guard:**
- The `on_navigation` guard in `open_main_dashboard` intercepts all navigations
- External URLs are routed to `tauri-plugin-opener` to open in system browser
- This ensures the webview remains focused on app functionality, not external sites

**Deep Link Support:**
- Handles `scribeshade://` deep links via `tauri-plugin-deep-link`
- Can trigger specific app actions from external sources

---

## Session Lifecycle

### Session Creation Flow

1. **User Input (Launcher Widget)**:
   - User fills session creation form in WidgetApp.tsx
   - Selects company, job description, language, resume, documents
   - Configures AI settings (model, simple language, auto-generate, save transcription)
   - Clicks "Start Session"

2. **API Call**:
   - Frontend calls `POST /api/session/create-session`
   - Backend validates inputs and enforces single-session limit
   - Backend creates session in database with status `PRE_CHECK`
   - Backend holds credits (moves from `totalAvailable` to `heldCredits`)

3. **Credit Enforcement**:
   - `credit-deduction` BullMQ job monitors session heartbeat (every 60s)
   - If session exceeds `maxAllowedMinutes` or credits exhausted:
     - Session status changes to `CREDIT_EXHAUSTED`
     - Session transitions to `COMPLETED`
     - Final credit deduction occurs
   - `hold-expiry` job cleans up sessions stuck in `PRE_CHECK` after 10 minutes

4. **Window Transition**:
   - If in Tauri desktop app:
     - `mini` window is shown with the floating session UI
     - `launcher` window is hidden
     - Session becomes active
   - If in web browser:
     - User is redirected to `/sessions/:id` (ActiveSession page)

### Active Session Flow

**Desktop App Path:**
1. User starts session from launcher widget
2. `mini` window opens with FloatingApp.tsx
3. User can:
   - Enable screen sharing (via WebRTC `getDisplayMedia`)
   - Speak to transcribe (via Deepgram audio capture)
   - Click "AI Answer" to get AI-powered question answers
   - Click "Analyze Screen" to capture and analyze screenshot
   - View real-time transcription
   - Chat with AI for follow-up questions
4. Session runs until:
   - User clicks "End Session"
   - Credits exhausted
   - Max time exceeded
   - Browser closed

**Web Browser Path:**
1. User starts session from web dashboard
2. Navigates to `/sessions/:id` (ActiveSession/page.tsx)
3. Similar features available (screen share, AI answer, transcription)
4. Full-screen mode available for immersive experience

### Session States

| State | Description | Transitions |
|---|---|---|
| `PRE_CHECK` | Initial state after creation, credits held | → `ACTIVE` (on session start) → `COMPLETED` (timeout/hold expiry) |
| `ACTIVE` | Session is running, credits being consumed | → `PAUSED` (user pause) → `COMPLETING` (user end) → `CREDIT_EXHAUSTED` (credits run out) |
| `PAUSED` | Session paused, credits not consumed | → `ACTIVE` (resume) → `COMPLETED` (timeout) |
| `COMPLETING` | Session ending, finalizing | → `COMPLETED` (finalization complete) |
| `COMPLETED` | Session finished, credits deducted | Terminal state |
| `CREDIT_EXHAUSTED` | Session ended due to insufficient credits | → `COMPLETED` (final deduction) |
| `ABANDONED` | Session abandoned (user quit) | → `COMPLETED` (cleanup) |
| `FORCE_ENDED` | Session forcibly ended (admin) | → `COMPLETED` |

---

## AI Answer Generation

### Backend Implementation

**File:** `src/features/session/session.service.ts`

**Endpoint:** `POST /api/session/:id/ai-answer`

**Function:** `getAIAnswer(id, transcript, isCustomQuery, isRegenerate, aiModel)`

**Process:**
1. **Fetch Session Context**:
   - Retrieves session from database with company info
   - Builds full context via `getSessionFullContext(id, transcript)`:
     - Resume content
     - Document content
     - AI-generated projects
     - Recent conversation history (past Q&A)
     - Vector search results (RAG) from transcript chunks
     - Session settings (language, simple mode, instructions)

2. **Build Prompts**:
   - System prompt: `buildSystemMessage(context)` — includes behavioral rules, length budgets, formatting rules
   - User prompt: `buildUserMessage(transcript, isCustomQuery, isRegenerate, context)` — includes task instructions, scoping rules, follow-up detection

3. **Call AI Model**:
   - Uses OpenRouter SDK with model mapping (human-readable names to API slugs)
   - Supports multiple models: Claude, GPT, Gemini
   - Streaming response for real-time updates
   - `maxOutputTokens: 8000` for multi-question screenshots

4. **Process Stream**:
   - `processAIStream(result, session, id, source)`:
     - Parses streaming chunks
     - Saves Q&A pairs to database
     - Emits SSE events for real-time updates
     - Handles errors and rate limits (429 responses)

**Prompt Engineering:**
- **Prime Directive**: Interview-ready, concise, natural language (not essay-style)
- **Length Budgets**: Strict word/character limits per question type
- **Style Rules**: Direct answer first, no filler, conversational tone
- **Formatting**: `**QUESTION:**` / `**ANSWER:**` blocks, markdown lists for bullets
- **Multi-question Support**: `===NEXT_QUESTION===` separator for multiple distinct questions
- **Follow-up Detection**: Detects follow-up questions from conversation history
- **Project Context**: Uses AI-generated projects as primary experience source
- **Simple Language Mode**: Reduces jargon and vocabulary when enabled

### Frontend Implementation

**File:** `src/hooks/useAIChat.ts`

**Hook:** `useAIChat()`

**Functions:**
- `handleAiAnswer(sessionId, question, aiModel)`: Generate answer from transcript
- `handleAnalyzeScreen(sessionId, screenshotBlob, aiModel)`: Analyze screenshot
- `handleCustomQuery(sessionId, query, aiModel)`: Send custom follow-up question
- `handleRegenerate(sessionId, messageId, aiModel)`: Regenerate answer for specific message

**Stream Processing:**
- `consumeSegmentedStream(reader, messageId, setAiChat, baseTime, signal)`:
  - Parses streaming response chunks
  - Splits on `===NEXT_QUESTION===` separator
  - Creates new message cards for each question
  - Filters preamble/meta text before first question
  - Handles `===NO_NEW_QUESTION===` sentinel
  - Real-time UI updates via `setAiChat`

**Deduplication:**
- Recent question dedup (4-second window)
- Question history tracking (45-second window for applyQuestionGuardrail)
- Follow-up question detection
- Duplicate card suppression

**Error Handling:**
- AbortController for request cancellation
- Graceful degradation on errors
- Fallback messages for failed requests
- Clean up of empty cards

---

## Screen Capture & Analysis

### Screen Capture Implementation

**File:** `src/hooks/useScreenShare.ts`

**Hook:** `useScreenShare()`

**Process:**
1. **User Gesture Requirement**:
   - WKWebView (Tauri/macOS) requires `getDisplayMedia` to originate from direct user gesture (button click)
   - Cannot be called from `useEffect` automatically
   - Caller must invoke `startShare()` from onClick handler

2. **Stream Capture**:
   ```typescript
   const displayMediaOptions = {
     video: true,
     audio: true,  // Shows "Include audio" toggle in OS picker
   };
   const mediaStream = await navigator.mediaDevices.getDisplayMedia(displayMediaOptions);
   ```

3. **Focus Control**:
   - Uses `CaptureController` (if supported) to prevent automatic focus switching to shared tab
   - `setFocusBehavior("no-focus-change")` keeps focus on app window

4. **Video Attachment**:
   - Callback ref (`videoRef`) attaches stream to video element
   - Re-attaches on mount/remount (e.g., after fullscreen toggle)
   - Auto-plays stream with error handling

5. **Screenshot Capture**:
   - `captureScreenshot()` draws video frame to canvas
   - Converts to JPEG blob (quality: 0.95)
   - Returns blob for upload to backend

6. **Cleanup**:
   - Stops all media tracks on unmount
   - Prevents memory leaks

**File:** `src/pages/Sessions/ActiveSession/components/ScreenCapture.tsx`

**Component Features:**
- Displays live screen share video
- Shows placeholder when no stream
- Fullscreen toggle
- "Change Tab" button to re-select screen
- Floating controls always visible
- "Include audio" hint for users

### Screen Analysis Implementation

**Backend Implementation**

**File:** `src/features/session/session.service.ts`

**Endpoint:** `POST /api/session/:id/analyze-screen`

**Function:** `analyzeScreen(id, file, aiModel)`

**Process:**
1. **Image Compression**:
   - Skips recompression if frontend already sent pre-compressed JPEG (≤ 600 KB)
   - Otherwise uses Sharp to:
     - Resize to max width 1024px
     - Compress to JPEG quality 65
     - Enforces size cap for LLM vision API

2. **Parallel Context Fetching**:
   ```typescript
   const [compressed, session, context] = await Promise.all([
     compressPromise,
     prisma.session.findUnique({ where: { id }, include: { company: true } }),
     getSessionFullContext(id),
   ]);
   ```
   - Reduces latency by 200-400ms compared to sequential fetching

3. **AI Vision API Call**:
   - Uses OpenRouter with vision-enabled models
   - Builds system prompt via `buildSystemMessage(context)`
   - Builds user prompt via `buildScreenAnalysisMessage(context)`
   - Sends image as base64-encoded JPEG
   - `maxOutputTokens: 8000` for multi-question screenshots

4. **Stream Processing**:
   - Same `processAIStream` as text-based answers
   - Handles segmentation with `===NEXT_QUESTION===`
   - Saves Q&A pairs to database
   - Emits SSE events

**Prompt Engineering for Screen Analysis:**
- **Task**: Identify EVERY interview question visible on screen
- **Count First**: Count visible questions before answering
- **Match Order**: Answer in on-screen order (top to bottom, left to right)
- **Multi-question Mode**: One `**QUESTION:**` / `**ANSWER:**` block per question, separated by `===NEXT_QUESTION===`
- **Per-question Depth**: Shorter answers in multi-question mode (1-2 sentences + 3-5 bullets)
- **Single-question Mode**: Full depth (6+ bullets, full code block)
- **Project Context**: Use AI-generated projects if question is about experience
- **No Meta Commentary**: Never output "due to length", "covering main ones", etc.

**Frontend Implementation**

**File:** `src/hooks/useAIChat.ts`

**Function:** `handleAnalyzeScreen(sessionId, screenshotBlob, aiModel)`

**Process:**
1. **Screenshot Capture**:
   - Calls `captureScreenshot()` from `useScreenShare` hook
   - Gets JPEG blob from video canvas

2. **FormData Upload**:
   ```typescript
   const formData = new FormData();
   formData.append("screenshot", screenshotBlob, "screenshot.jpg");
   if (aiModel) formData.append("aiModel", aiModel);
   ```

3. **Streaming Response**:
   - POST to `/api/session/:id/analyze-screen`
   - Uses `consumeSegmentedStream` for real-time card rendering
   - Same segmentation and preamble filtering as text answers

4. **Error Handling**:
   - Fallback message if no questions detected
   - Error message on API failure
   - Clean up of empty cards

---

## Real-time Events (SSE)

**Backend Implementation:**

**File:** `src/shared/lib/sse.ts`

**Class:** `SSEManager`

**Purpose:** Manages Server-Sent Events for real-time updates to clients

**Key Methods:**
- `addClient(sessionId, response)`: Register client for a session
- `removeClient(sessionId, response)`: Unregister client
- `emit(sessionId, event, data)`: Send event to all clients for a session
- `emitToAll(event, data)`: Send event to all connected clients

**Event Types:**
- `transcription`: New transcript chunk
- `ai-response`: AI answer chunk
- `session-status`: Session state change
- `credit-update`: Credit balance change

**Frontend Implementation:**

**File:** `src/hooks/useSessionEvents.ts`

**Hook:** `useSessionEvents(sessionId)`

**Process:**
- Opens EventSource connection to `/api/session/:id/events`
- Listens for SSE events
- Updates local state on event receipt
- Handles connection errors and reconnection
- Cleans up on unmount

---

## Rust Backend Commands (Tauri)

**File:** `src-tauri/src/lib.rs`

### Session Management Commands

```rust
#[tauri::command]
fn set_session_active(active: bool) {
    SESSION_ACTIVE.store(active, Ordering::SeqCst);
}
```
- Sets atomic flag indicating if a session is active
- Used by frontend to enable/disable session-specific features

```rust
#[tauri::command]
async fn open_main_dashboard(
    app: AppHandle,
    route: Option<String>,
    show_create: Option<bool>,
    is_free: Option<bool>,
    visible: Option<bool>,
) -> Result<(), String>
```
- Lazily creates the main dashboard window
- Supports route navigation (e.g., `/sessions/:id`)
- Can open hidden for background processing
- Navigation guard redirects external URLs to system browser

### Window Management Commands

```rust
#[tauri::command]
async fn show_launcher_widget() -> Result<(), String>
```
- Shows the launcher widget window
- Used when user needs to create a new session

```rust
#[tauri::command]
async fn show_mini_window() -> Result<(), String>
```
- Shows the mini (floating screen) window
- Used when starting an active session

### Content Protection Commands

```rust
#[tauri::command]
fn toggle_content_protection(protected: bool) -> Result<(), String>
```
- Toggles screen capture protection across all windows
- When protected: window disappears from screenshots, screen-share, recording
- When unprotected: normal shareable window
- Used for private mode

### Cursor Passthrough Commands

```rust
#[tauri::command]
fn set_cursor_passthrough(enabled: bool) -> Result<(), String>
```
- Enables/disables click-through behavior for transparent windows
- When enabled: clicks pass through to underlying windows
- When disabled: clicks are captured by the app window

### Authentication Commands

```rust
#[tauri::command]
fn auth_get_persisted_session() -> Option<String>
```
- Retrieves persisted Clerk auth session from local storage

```rust
#[tauri::command]
fn auth_set_persisted_session(session: String)
```
- Saves Clerk auth session to local storage

```rust
#[tauri::command]
fn auth_clear_persisted_session()
```
- Clears persisted Clerk auth session

```rust
#[tauri::command]
fn auth_emit_state_changed()
```
- Emits event to notify frontend of auth state change

### Utility Commands

```rust
#[tauri::command]
fn get_cursor_position() -> Result<(i32, i32), String>
```
- Gets current cursor position on screen
- Used for window positioning

---

## Data Flow Diagrams

### Session Creation Flow

```
User (Launcher Widget)
    ↓
POST /api/session/create-session
    ↓
Backend (session.service.ts)
    ├─ Validate inputs
    ├─ Check single-session limit
    ├─ Hold credits (totalAvailable → heldCredits)
    ├─ Create session in DB (status: PRE_CHECK)
    └─ Return session ID
    ↓
Frontend
    ├─ If Tauri: invoke("show_mini_window")
    ├─ If Web: navigate to /sessions/:id
    └─ Start session heartbeat
```

### AI Answer Flow

```
User (FloatingApp / ActiveSession)
    ↓
POST /api/session/:id/ai-answer
    ├─ Body: { transcript, aiModel, isCustomQuery, isRegenerate }
    ↓
Backend (session.service.ts)
    ├─ Fetch session with company info
    ├─ Build context (resume, documents, projects, history, RAG)
    ├─ Build system prompt (behavioral rules, length budgets)
    ├─ Build user prompt (task, scoping, follow-up detection)
    ├─ Call OpenRouter AI model (streaming)
    └─ Process stream (parse chunks, save Q&A, emit SSE)
    ↓
Frontend (useAIChat)
    ├─ Consume segmented stream
    ├─ Split on ===NEXT_QUESTION===
    ├─ Create message cards for each question
    ├─ Filter preamble/meta text
    ├─ Update UI in real-time
    └─ Apply question guardrails (dedup, follow-up detection)
```

### Screen Analysis Flow

```
User (FloatingApp / ActiveSession)
    ↓
captureScreenshot() from useScreenShare
    ├─ Draw video frame to canvas
    └─ Convert to JPEG blob
    ↓
POST /api/session/:id/analyze-screen
    ├─ FormData: { screenshot: blob, aiModel }
    ↓
Backend (session.service.ts)
    ├─ Compress image (if needed) via Sharp
    ├─ Fetch session and context in parallel
    ├─ Build system and screen analysis prompts
    ├─ Call OpenRouter vision model (streaming)
    └─ Process stream (same as text answers)
    ↓
Frontend (useAIChat)
    ├─ Consume segmented stream
    ├─ Render question/answer cards
    └─ Update UI in real-time
```

---

## Configuration

### Environment Variables

**Backend** (`src/config/env.ts`):
- `DATABASE_URL`: PostgreSQL connection string
- `CLERK_PUBLISHABLE_KEY`: Clerk frontend key
- `CLERK_SECRET_KEY`: Clerk backend key
- `CLERK_WEBHOOK_SECRET`: Clerk webhook verification
- `OPENROUTER_API_KEY`: OpenRouter AI API key (required at runtime)
- `OPENROUTER_MODEL`: Default AI model
- `REDIS_URL`: Redis connection for BullMQ (default: redis://localhost:6379)
- `RAZORPAY_KEY_ID`: Razorpay payment key
- `RAZORPAY_KEY_SECRET`: Razorpay payment secret
- `CORS_ORIGINS`: Allowed CORS origins
- `VITE_BACKEND_URL`: Backend URL for frontend

**Frontend** (in `.env` or Vite env):
- `VITE_BACKEND_URL`: Backend API URL
- `VITE_FRONTEND_URL`: Frontend URL (for deep links)
- `VITE_CLERK_PUBLISHABLE_KEY`: Clerk frontend key
- `VITE_DEEPGRAM_API_KEY`: Deepgram transcription API key
- `VITE_RAZORPAY_KEY_ID`: Razorpay key
- `VITE_CLERK_SIGN_IN_URL`: Sign-in route
- `VITE_CLERK_SIGN_UP_URL`: Sign-up route
- `VITE_CLERK_AFTER_SIGN_IN_URL`: Post-sign-in route
- `VITE_CLERK_AFTER_SIGN_UP_URL`: Post-sign-up route
- `VITE_INACTIVITY_TIMEOUT_MS`: Inactivity timeout
- `VITE_INACTIVITY_WARNING_MS`: Inactivity warning

### Tauri Configuration

**File:** `src-tauri/tauri.conf.json`

**Key Settings:**
```json
{
  "version": "1.3.0",
  "identifier": "com.hiddenmindsolutions.scribeshade-frontend",
  "app": {
    "macOSPrivateApi": true,
    "windows": [
      {
        "label": "mini",
        "url": "floating.html",
        "transparent": true,
        "decorations": false,
        "visible": false,
        "alwaysOnTop": true,
        "skipTaskbar": true,
        "visibleOnAllWorkspaces": true,
        "acceptFirstMouse": true
      },
      {
        "label": "launcher",
        "url": "launcher.html",
        "transparent": true,
        "decorations": false,
        "visible": false,
        "alwaysOnTop": true,
        "skipTaskbar": true,
        "visibleOnAllWorkspaces": true
      }
    ]
  },
  "bundle": {
    "createUpdaterArtifacts": true,
    "targets": "all"
  },
  "plugins": {
    "updater": {
      "endpoints": ["https://test.backend.scribeshade.org/api/updates/latest.json"],
      "pubkey": "..."
    },
    "deep-link": {
      "desktop": {
        "schemes": ["scribeshade"]
      }
    }
  }
}
```

---

## Key Files Reference

### Frontend

**Tauri Windows & Components:**
- `src-tauri/tauri.conf.json`: Tauri configuration
- `src-tauri/src/lib.rs`: Rust commands and app setup
- `src/pages/Launcher/WidgetApp.tsx`: Launcher widget
- `src/pages/Sessions/ActiveSession/FloatingApp.tsx`: Floating screen overlay
- `src/App.tsx`: Main dashboard (mounted in index.html)

**Hooks:**
- `src/hooks/useScreenShare.ts`: Screen capture and sharing
- `src/hooks/useAIChat.ts`: AI chat streaming and processing
- `src/hooks/useSessionEvents.ts`: SSE event handling
- `src/hooks/useDeepgram.ts`: Deepgram transcription
- `src/hooks/useNativeTabTranscription.ts`: Native tab transcription
- `src/hooks/useSessionHeartbeat.ts`: Session heartbeat monitoring
- `src/hooks/useSessionResources.ts`: Session resource management

**Session Components:**
- `src/pages/Sessions/ActiveSession/page.tsx`: Main session page
- `src/pages/Sessions/ActiveSession/components/ScreenCapture.tsx`: Screen capture UI
- `src/pages/Sessions/ActiveSession/components/AIChatPanel.tsx`: AI chat panel
- `src/pages/Sessions/ActiveSession/components/ChatHeader.tsx`: Chat header with model selector
- `src/pages/Sessions/ActiveSession/components/ChatMessageList.tsx`: Message list
- `src/pages/Sessions/ActiveSession/components/ChatInput.tsx`: Chat input
- `src/pages/Sessions/ActiveSession/components/ChatActionButtons.tsx`: Action buttons

**Launcher Components:**
- `src/features/launcher/components/SessionSelector.tsx`: Session selection
- `src/features/launcher/components/HeaderMenu.tsx`: Launcher menu
- `src/features/launcher/hooks/useCardPosition.tsx`: Card positioning
- `src/features/launcher/hooks/useCursorPassthrough.tsx`: Click-through behavior

### Backend

**Session:**
- `src/features/session/session.router.ts`: API routes
- `src/features/session/session.controller.ts`: Request handlers
- `src/features/session/session.service.ts`: Business logic
- `src/features/session/session.types.ts`: TypeScript types

**AI & Prompts:**
- `src/shared/lib/prompt.ts`: System and user prompt builders
- `src/shared/prompts/analytics.ts`: Analytics prompts
- `src/features/ai/ai.service.ts`: AI service
- `src/features/ai/ai.types.ts`: AI types

**Jobs:**
- `src/features/jobs/queue.ts`: BullMQ queue setup
- `src/features/jobs/session-watchdog.job.ts`: Session monitoring
- `src/features/jobs/credit-deduction.job.ts`: Credit deduction
- `src/features/jobs/hold-expiry.job.ts`: Hold cleanup

**SSE:**
- `src/shared/lib/sse.ts`: SSE manager for real-time events

---

## Best Practices

### Tauri-Specific

1. **Always use `isTauri()`** for runtime detection, never environment variables
2. **External URLs open in browser** via `@tauri-apps/plugin-opener`
3. **Cross-platform Rust** requires `cfg(target_os)` for platform-specific code
4. **Window visibility** is managed via Tauri commands, not CSS
5. **Deep links** use `scribeshade://` scheme
6. **Content protection** uses macOS private API for screen capture blocking

### Frontend

1. **Streaming responses** use Server-Sent Events or fetch streaming
2. **AbortController** for request cancellation
3. **Callback refs** for video element re-attachment
4. **Local storage** for user preferences (zoom, opacity, private mode)
5. **Redux** for global state, local state for component-specific data
6. **Deduplication** for AI questions to prevent duplicate cards

### Backend

1. **Parallel async operations** for performance (compression + context fetch)
2. **Streaming responses** for real-time AI updates
3. **Credit enforcement** via BullMQ jobs and heartbeat
4. **Error handling** with AppError middleware
5. **Type safety** with Prisma and TypeScript
6. **Prompt engineering** for consistent AI responses

---

## Troubleshooting

### Common Issues

**Updater not working:**
- Check if GitHub release has correct updater artifacts (`.app.tar.gz` for macOS)
- Verify platform keys in `latest.json`
- Check browser console for `[updater] check failed:` warnings

**Screen share not working:**
- Ensure `getDisplayMedia` is called from direct user gesture (button click)
- Check if "Include audio" toggle is enabled in OS picker
- Verify video element is properly attached via callback ref

**AI responses not streaming:**
- Check if backend is returning streaming headers
- Verify SSE connection is established
- Check for network errors in browser console

**Credits not deducting:**
- Verify BullMQ Redis connection
- Check if session heartbeat is firing
- Verify credit balance and bracket configuration

**Window not showing:**
- Check if window is created with `visible: false`
- Verify Tauri command is being called correctly
- Check for JavaScript errors in webview console
