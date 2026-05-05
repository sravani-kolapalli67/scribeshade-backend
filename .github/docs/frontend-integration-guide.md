# ScribeShade Backend — Frontend Integration Guide

> **Base URL:** `http://localhost:3200/api` (dev) / `https://your-domain/api` (prod)  
> **Auth:** Clerk JWT via `Authorization: Bearer <token>` header (handled automatically by Clerk SDK)  
> **Content-Type:** `application/json` for all JSON bodies

---

## Table of Contents

1. [Session Lifecycle — Overview](#1-session-lifecycle--overview)
2. [Credit System — Concepts](#2-credit-system--concepts)
3. [Session APIs](#3-session-apis)
4. [Credits APIs](#4-credits-apis)
5. [Session Status State Machine](#5-session-status-state-machine)
6. [Complete Frontend Integration Flow](#6-complete-frontend-integration-flow)
7. [Heartbeat Loop Implementation](#7-heartbeat-loop-implementation)
8. [UI Handling Per Status](#8-ui-handling-per-status)
9. [Error Reference](#9-error-reference)
10. [Breaking Changes from Previous Version](#10-breaking-changes-from-previous-version)

---

## 1. Session Lifecycle — Overview

```
CREATE SESSION  →  ACTIVATE  →  [heartbeat loop]  →  DEACTIVATE
(PRE_CHECK)         (ACTIVE)                          (COMPLETING → COMPLETED)
                                    ↓ credits low
                              CREDIT_WARNING
                                    ↓ credits exhausted
                            CREDIT_EXHAUSTED → (worker finalises)
```

Every session now has a `status` field (replaces the old `isActive` boolean).  
**Free sessions** (`free: true`) skip the credit hold and complete synchronously on deactivate.  
**Paid sessions** place a credit hold on activate, and a background job finalises deduction after deactivate.

---

## 2. Credit System — Concepts

| Concept | Description |
|---|---|
| **Bracket** | A time tier (e.g. 30 min, 60 min) with a full-price and half-price credit cost |
| **Hold** | Credits reserved at session activation — deducted from `totalAvailable` immediately |
| **Free Zone** | First N minutes of a session (default 5) — no credits charged |
| **Grace Zone** | Last N minutes before bracket boundary (default 5) — still charged at half rate |
| **Deduction Reason** | `FREE_ZONE` / `HALF_BRACKET` / `FULL_BRACKET` / `EXHAUSTED` / `FORCE_ENDED` |

All credit values are returned as **decimal strings** (e.g. `"1.00"`, `"0.50"`) — never parse as float; display as-is or use a decimal library.

---

## 3. Session APIs

### 3.1 Create Session

```
POST /api/session/create-session
Content-Type: application/json   (or multipart/form-data)
```

**Request Body:**

| Field | Type | Required | Notes |
|---|---|---|---|
| `userId` | string | ✅ | Internal DB user UUID |
| `companyName` | string | ✅ | Company auto-created if not found |
| `jobDescription` | string | — | Job description text |
| `resumeId` | string | — | UUID of uploaded resume |
| `DocumentId` | string | — | UUID of uploaded document |
| `language` | string | — | e.g. `"JavaScript"`, `"Python"` |
| `simpleLanguage` | boolean | — | Default `true` |
| `autoGenerateAI` | boolean | — | Auto-trigger AI answer |
| `saveTranscript` | boolean | — | Save transcript at end |
| `instructions` | string | — | Extra instructions (appended to extraContext) |
| `extraContext` | string | — | Additional context |
| `jobInputMode` | string | — | `"manual"` or `"upload"` |
| `free` | boolean | — | `true` = skip credit system entirely |

**Response `201`:**

```json
{
  "success": true,
  "sessionId": "uuid",
  "data": { /* full Session object */ }
}
```

> ⚠️ After creating, the session is in `PRE_CHECK` status. You must call **Activate** before starting.

---

### 3.2 Activate Session

```
POST /api/session/:id/activate
```

No request body needed.

**Response `200` — Paid session:**

```json
{
  "success": true,
  "sessionId": "uuid",
  "startedAt": "2026-04-28T10:00:00.000Z",
  "creditsHeld": "1.00",
  "maxAllowedMinutes": 60,
  "timer": 0
}
```

**Response `200` — Free session:**

```json
{
  "success": true,
  "sessionId": "uuid",
  "startedAt": "2026-04-28T10:00:00.000Z",
  "creditsHeld": "0",
  "maxAllowedMinutes": null,
  "timer": 0
}
```

**What happens server-side:**
- For paid sessions: credits are held, `totalAvailable` decreases, `maxAllowedMinutes` is set
- Session moves `PRE_CHECK → ACTIVE`
- Calling activate on an already-`ACTIVE` session is **idempotent** (returns same 200)

**Error responses:**

| Status | Meaning |
|---|---|
| `402` | Insufficient credits (`INSUFFICIENT_CREDITS`) |
| `404` | Session not found |
| `409` | Session is not in `PRE_CHECK` status (already activated, completed, etc.) |

> **Store `maxAllowedMinutes` from this response** — you need it to drive the heartbeat timer.

---

### 3.3 Session Heartbeat

```
POST /api/session/:id/heartbeat
Content-Type: application/json
```

**Request Body:**

```json
{ "elapsedMinutes": 5 }
```

Call this **every 60 seconds** while the session is ACTIVE. Pass the actual elapsed wall-clock minutes since `startedAt`.

**Response `200`:**

```json
{ "action": "NONE", "remainingMinutes": 55 }
```

```json
{ "action": "CREDIT_WARNING", "remainingMinutes": 1 }
```

```json
{ "action": "CREDIT_EXHAUSTED" }
```

| `action` | What to do in UI |
|---|---|
| `NONE` | Continue, update remaining time display |
| `CREDIT_WARNING` | Show warning banner — "Less than 1 minute of credit remaining" |
| `CREDIT_EXHAUSTED` | Session was force-closed server-side. Stop UI, show "Session ended: credits exhausted" |

> If the session ID doesn't exist or is not ACTIVE, the response is `{ "action": "NONE" }` (no error).

---

### 3.4 Deactivate Session

```
POST /api/session/:id/deactivate
Content-Type: application/json
```

**Request Body (all optional):**

```json
{
  "aiUsage": 3,
  "transcript": "..."
}
```

| Field | Type | Notes |
|---|---|---|
| `aiUsage` | number | Number of AI requests made during session |
| `transcript` | string | Full session transcript (triggers background analytics) |

**Response `200`:**

```json
{
  "success": true,
  "sessionId": "uuid",
  "status": "COMPLETING"
}
```

For **free sessions**, the status will be `"COMPLETED"` immediately (no async job).

**What happens server-side:**
- Session moves `ACTIVE → COMPLETING`
- For paid sessions: a BullMQ job is queued to finalise credit deduction → session becomes `COMPLETED`
- Calling deactivate again while `COMPLETING` is **idempotent** (returns the same 200, no extra job queued)
- If `transcript` is provided, session analytics are generated in the background

> After calling deactivate, **poll `GET /api/session/:id`** until `status === "COMPLETED"` before showing the results/feedback screen.

---

### 3.5 Get Session

```
GET /api/session/:id
```

**Response `200`:** Full session object including:

```json
{
  "id": "uuid",
  "status": "COMPLETED",
  "creditsHeld": "0.00",
  "creditsDeducted": "0.00",
  "deductionReason": "FREE_ZONE",
  "maxAllowedMinutes": 60,
  "startedAt": "...",
  "endedAt": "...",
  "feedback": { /* SessionFeedback or null */ }
}
```

---

### 3.6 List Sessions

```
GET /api/session/list?userId=<uuid>&search=Google&from_date=2026-01-01&to_date=2026-04-28
```

| Query | Type | Notes |
|---|---|---|
| `userId` | string | Required |
| `search` | string | Filters by `companyName` (case-insensitive) |
| `from_date` | string | ISO date string |
| `to_date` | string | ISO date string (inclusive, to 23:59:59) |

---

### 3.7 Delete Session

```
DELETE /api/session/:id
```

**What happens server-side:**  
If the session is still in `PRE_CHECK` with a hold (e.g. user created + activated then immediately deleted), the held credits are **automatically released** back to `totalAvailable`.

**Response `200`:** Full deleted session object.

---

### 3.8 Analyze Screen (Screenshot → AI Stream)

```
POST /api/session/:id/analyze-screen
Content-Type: multipart/form-data
```

| Field | Type | Notes |
|---|---|---|
| `screenshot` | file | PNG/JPEG screenshot |
| `aiModel` | string | Human-readable model name (see table below) |

**Accepted `aiModel` values:**

| Frontend sends | OpenRouter model used |
|---|---|
| `Gemini 2.0 Flash` | `google/gemini-2.0-flash-001` |
| `Gemini 2.0 Flash Exp` | `google/gemini-2.0-flash-exp:free` |
| `Gemini 1.5 Flash` | `google/gemini-flash-1.5` |
| `Gemini 1.5 Pro` | `google/gemini-pro-1.5` |
| `GPT-4o` | `openai/gpt-4o` |
| `GPT-4o Mini` | `openai/gpt-4o-mini` |
| `Claude 3.5 Sonnet` | `anthropic/claude-3.5-sonnet` |
| `Claude 3 Haiku` | `anthropic/claude-3-haiku` |

> Model name matching is **case-insensitive**. Unknown strings are passed through as-is.

**Response:** `text/plain` chunked stream. Read with `ReadableStream` / `EventSource`.

---

## 4. Credits APIs

### 4.1 Get Brackets (Public)

```
GET /api/credits/brackets
```

No auth required.

**Response `200`:**

```json
{
  "success": true,
  "data": [
    {
      "id": "uuid",
      "bracketMinutes": 30,
      "creditsFull": "0.50",
      "creditsHalf": "0.25",
      "freeZoneMinutes": 5,
      "graceZoneMinutes": 5,
      "isActive": true
    },
    {
      "id": "uuid",
      "bracketMinutes": 60,
      "creditsFull": "1.00",
      "creditsHalf": "0.50",
      "freeZoneMinutes": 5,
      "graceZoneMinutes": 5,
      "isActive": true
    }
  ]
}
```

Use this to display the pricing tiers on a "Buy Credits" or "How it works" page.

---

### 4.2 Get Balance

```
GET /api/credits/balance
Authorization: Bearer <clerk-token>
```

**Response `200`:**

```json
{
  "success": true,
  "data": {
    "userId": "uuid",
    "purchasedCredits": "5.00",
    "earnedCredits": "0.00",
    "heldCredits": "1.00",
    "totalAvailable": "4.00"
  }
}
```

| Field | Meaning |
|---|---|
| `purchasedCredits` | Total ever purchased |
| `earnedCredits` | Bonus/referral credits |
| `heldCredits` | Currently locked by an active session |
| `totalAvailable` | **Spendable balance** — show this as the user's current balance |

> Display `totalAvailable` as the user's usable balance. `heldCredits` represents an in-progress session reservation.

---

### 4.3 Get Ledger

```
GET /api/credits/ledger?page=1&limit=20
Authorization: Bearer <clerk-token>
```

**Query params:** `page` (default 1), `limit` (default 20, max 100)

**Response `200`:**

```json
{
  "success": true,
  "data": [
    {
      "id": "uuid",
      "userId": "uuid",
      "sessionId": "uuid",
      "type": "DEBIT",
      "amount": "0.00",
      "reason": "FREE_ZONE",
      "createdAt": "2026-04-28T10:05:00.000Z"
    }
  ],
  "pagination": {
    "total": 42,
    "page": 1,
    "limit": 20,
    "pages": 3
  }
}
```

| `type` | Meaning |
|---|---|
| `DEBIT` | Credits spent on a session |
| `PURCHASE` | Credits added via purchase |
| `REFUND` | Credits returned |
| `EARN` | Bonus credits awarded |

| `reason` (for DEBIT) | Meaning |
|---|---|
| `FREE_ZONE` | Session ended within free zone — 0 credits charged |
| `HALF_BRACKET` | Session ended in grace zone — half rate charged |
| `FULL_BRACKET` | Session used full bracket — full rate charged |
| `EXHAUSTED` | Credits ran out mid-session |
| `FORCE_ENDED` | Session was force-closed by admin/watchdog |

---

### 4.4 Get Purchases

```
GET /api/credits/purchases
Authorization: Bearer <clerk-token>
```

**Response `200`:**

```json
{
  "success": true,
  "data": [
    {
      "id": "uuid",
      "userId": "uuid",
      "amount": "5.00",
      "credits": "5.00",
      "status": "CONFIRMED",
      "createdAt": "2026-04-01T00:00:00.000Z"
    }
  ]
}
```

---

## 5. Session Status State Machine

```
PRE_CHECK
    │
    ├─[activate]──────────────────────────────────► ACTIVE
    │                                                  │
    │                                      [heartbeat] │ [deactivate]
    │                                                  │
    │                                    CREDIT_EXHAUSTED   COMPLETING
    │                                           │              │
    │                                      [BullMQ job]   [BullMQ job]
    │                                           │              │
    │                                           └──────────────► COMPLETED
    │
    ├─[delete]──────────────────────────────────► (deleted, hold released)
    │
    └─[watchdog]────────────────────────────────► ABANDONED
```

**Status descriptions:**

| Status | Meaning | UI Action |
|---|---|---|
| `PRE_CHECK` | Created, not started | Show "Start Session" button |
| `ACTIVE` | Running — heartbeat required | Show timer, AI controls |
| `PAUSED` | Paused (reserved for future) | Show "Resume" button |
| `COMPLETING` | Deactivated, job pending | Show "Processing..." spinner |
| `COMPLETED` | Fully closed, credits deducted | Show results/feedback |
| `CREDIT_EXHAUSTED` | Ran out of credits mid-session | Show "Credits exhausted" notice |
| `FORCE_ENDED` | Closed by admin/system | Show "Session ended" notice |
| `ABANDONED` | PRE_CHECK session timed out | Treat as expired |

---

## 6. Complete Frontend Integration Flow

### Step 1 — Before Starting (show pricing)

```js
// Fetch active brackets to show "this session will cost X credits"
const { data: brackets } = await GET('/api/credits/brackets');

// Fetch user's current balance
const { data: balance } = await GET('/api/credits/balance');  // authenticated

// Display: balance.totalAvailable credits available
// Display: brackets[0] = 30 min for 0.50 credits, brackets[1] = 60 min for 1.00 credits
```

### Step 2 — Create Session

```js
const { sessionId } = await POST('/api/session/create-session', {
  userId,
  companyName: 'Google',
  jobDescription: '...',
  resumeId: '...',
  free: false,   // paid session
});
// session is now PRE_CHECK
```

### Step 3 — Activate Session

```js
const result = await POST(`/api/session/${sessionId}/activate`);

if (result.error === 'INSUFFICIENT_CREDITS') {
  // redirect to buy credits page
  return;
}

const { maxAllowedMinutes, creditsHeld, startedAt } = result;
// Store maxAllowedMinutes — needed for heartbeat
// Show: creditsHeld credits reserved, timer starts
```

### Step 4 — Heartbeat Loop

```js
const startTime = Date.now();
const heartbeatInterval = setInterval(async () => {
  const elapsedMinutes = (Date.now() - startTime) / 60000;

  const result = await POST(`/api/session/${sessionId}/heartbeat`, {
    elapsedMinutes: Math.floor(elapsedMinutes),
  });

  if (result.action === 'CREDIT_WARNING') {
    showWarning(`Only ${result.remainingMinutes} minute(s) of credit left!`);
  }

  if (result.action === 'CREDIT_EXHAUSTED') {
    clearInterval(heartbeatInterval);
    showError('Session ended — credits exhausted');
    navigateTo(`/session/${sessionId}/results`);
  }
}, 60_000); // every 60 seconds
```

### Step 5 — Deactivate Session

```js
clearInterval(heartbeatInterval);

await POST(`/api/session/${sessionId}/deactivate`, {
  aiUsage: aiRequestCount,
  transcript: transcriptText,  // optional
});
// session is now COMPLETING (or COMPLETED for free sessions)
```

### Step 6 — Wait for Completion, Show Results

```js
// Poll until COMPLETED (BullMQ job usually finishes in < 5 seconds)
let session;
do {
  await sleep(2000);
  session = await GET(`/api/session/${sessionId}`);
} while (session.status === 'COMPLETING');

// session.deductionReason tells you what was charged
// session.creditsDeducted = "0.00" for FREE_ZONE, etc.
navigateTo(`/session/${sessionId}/feedback`);
```

---

## 7. Heartbeat Loop Implementation

```typescript
class SessionHeartbeat {
  private interval: ReturnType<typeof setInterval> | null = null;
  private startTime: number = 0;

  start(sessionId: string, maxAllowedMinutes: number | null) {
    this.startTime = Date.now();

    this.interval = setInterval(async () => {
      const elapsed = Math.floor((Date.now() - this.startTime) / 60000);

      try {
        const res = await fetch(`/api/session/${sessionId}/heartbeat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ elapsedMinutes: elapsed }),
        });
        const data = await res.json();

        if (data.action === 'CREDIT_WARNING') {
          this.onWarning(data.remainingMinutes);
        } else if (data.action === 'CREDIT_EXHAUSTED') {
          this.stop();
          this.onExhausted();
        }
      } catch (e) {
        console.error('Heartbeat failed', e);
        // Do NOT stop on network failure — retry next tick
      }
    }, 60_000);
  }

  stop() {
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
  }

  onWarning(remaining: number) { /* override */ }
  onExhausted() { /* override */ }
}
```

---

## 8. UI Handling Per Status

| Status | Suggested UI |
|---|---|
| `PRE_CHECK` | "Start Session" CTA, show estimated cost from brackets |
| `ACTIVE` | Running timer, AI controls enabled, remaining-minutes badge if `maxAllowedMinutes` set |
| `COMPLETING` | Disabled controls, "Finalising session..." spinner — poll every 2s |
| `COMPLETED` | Show `deductionReason` + `creditsDeducted`, feedback tab, "Start New Session" CTA |
| `CREDIT_EXHAUSTED` | Red banner "Session ended — credits ran out", show deduction info, "Buy Credits" CTA |
| `FORCE_ENDED` | Yellow banner "Session was closed by the system" |
| `ABANDONED` | Grey tag "Expired" |

### Remaining time display

```js
// After activate
const remaining = maxAllowedMinutes - elapsedMinutes;
// Show "47 min remaining" badge
// When remaining <= 5, show yellow warning
// When remaining <= 1, show red warning (matches CREDIT_WARNING threshold)
```

### Balance display

```js
// Refresh balance after:
// 1. Activate (balance decreased by hold)
// 2. Session reaches COMPLETED (balance updated after deduction)
// 3. User purchases credits

const { data } = await GET('/api/credits/balance');
display(`${data.totalAvailable} credits available`);
if (Number(data.heldCredits) > 0) {
  display(`(${data.heldCredits} held by active session)`);
}
```

---

## 9. Error Reference

| Status | Error message | Meaning | Action |
|---|---|---|---|
| `400` | `userId is required` | Missing userId in create | Fix request |
| `401` | `Authentication required` | Missing/invalid Clerk token | Redirect to login |
| `402` | `INSUFFICIENT_CREDITS` | Not enough credits to activate | Redirect to buy credits |
| `404` | `Session not found` | Wrong session ID | Show 404 UI |
| `404` | `User not found` | Clerk user not in DB | Re-sync user record |
| `409` | `Cannot activate session in status X` | Session already activated/completed | Refresh session status and handle accordingly |
| `409` | `Cannot deactivate session in status X` | Session not ACTIVE/PAUSED | Refresh session status |
| `500` | `No active credit brackets configured` | Admin config issue | Contact support |

All errors return:
```json
{ "error": "message" }
```

---

## 10. Breaking Changes from Previous Version

| What changed | Before | After |
|---|---|---|
| **Session active flag** | `isActive: boolean` | `status: SessionStatus` (see state machine) |
| **Activate response** | `{ success, sessionId }` | Now includes `creditsHeld`, `maxAllowedMinutes` |
| **Deactivate response** | `{ success, sessionId }` | Now includes `status` (`"COMPLETING"` or `"COMPLETED"`) |
| **Deactivate is async** (paid) | Session immediately COMPLETED | Session goes `COMPLETING` → background job → `COMPLETED`. **Poll until COMPLETED before showing results.** |
| **Deactivate idempotent** | Second call returned 409 | Second call while `COMPLETING` returns 200 (safe to retry) |
| **Delete releases hold** | Credits could be stuck | `DELETE /session/:id` on a `PRE_CHECK` session with a hold now auto-releases credits |
| **Heartbeat endpoint** | Did not exist | `POST /session/:id/heartbeat` — **required** for paid sessions |
| **New credit endpoints** | Did not exist | `GET /api/credits/balance`, `/brackets`, `/ledger`, `/purchases` |
| **`free` field on session** | Not present | `free: true` skips entire credit system — heartbeat still safe to call but returns `NONE` |
| **Model name normalisation** | Frontend had to send exact OpenRouter slug | Frontend can send human-readable names (e.g. `"Gemini 2.0 Flash"`) |
