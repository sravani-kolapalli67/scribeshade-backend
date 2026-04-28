# ScribeShade Backend API Reference

Last updated: 2026-04-28
Document version: v1.2.0

Base URL:
- Local: `http://localhost:3200/api`
- Production: `https://<your-domain>/api`

Content types:
- JSON APIs: `application/json`
- Upload APIs: `multipart/form-data`
- Streaming APIs: `text/plain; charset=utf-8` (chunked)

Auth:
- Clerk middleware is applied globally.
- Endpoints that require explicit auth checks use `requireAuth` / `getCurrentUserId` and return `401` when missing/invalid token.
- Send `Authorization: Bearer <clerk_jwt>` for protected endpoints.

---

## Standard Error Shapes

Most endpoints return one of these:

```json
{ "error": "message" }
```

```json
{ "success": false, "error": "Internal server error" }
```

Validation errors from Zod-based flows (if thrown):

```json
{
  "error": "Validation Error",
  "details": {
    "formErrors": [],
    "fieldErrors": {}
  }
}
```

Auth errors from guarded routes:

```json
{ "error": "Unauthorized: Authentication required" }
```

```json
{ "error": "Unauthorized: Invalid or expired token" }
```

---

## Health

### GET /health
Health check.

Success `200`:
```json
{
  "status": "ok",
  "timestamp": "2026-04-28T10:00:00.000Z"
}
```

---

## Auth APIs

### GET /auth/me
Returns current user (syncs from Clerk to DB if missing).

Headers:
- `Authorization: Bearer <token>`

Success `200`:
```json
{
  "id": "db-user-uuid",
  "clerkId": "user_xxx",
  "email": "john@company.com",
  "name": "John Doe",
  "createdAt": "2026-04-01T10:00:00.000Z",
  "updatedAt": "2026-04-01T10:00:00.000Z"
}
```

Error examples:
- `401`
```json
{ "error": "Unauthorized: Authentication required" }
```
- `500`
```json
{ "error": "Internal Server Error" }
```

### POST /auth/webhook
Clerk webhook endpoint.

Headers (from Clerk):
- `svix-id`
- `svix-timestamp`
- `svix-signature`

Body: raw webhook payload

Success `200`:
```json
{ "received": true, "type": "user.created" }
```

Error examples:
- `500`
```json
{ "error": "Invalid webhook signature" }
```

---

## Credits APIs

### GET /credits/plans?currency=INR|USD|GBP
Public endpoint. Returns default purchase plans for interview sessions.

Query params:
- `currency` optional (`INR` default, supported: `INR`, `USD`, `GBP`)

Success `200`:
```json
{
  "success": true,
  "feature": "INTERVIEW_SESSION",
  "data": [
    {
      "code": "quick_5",
      "name": "Quick 5",
      "credits": "5",
      "currency": "INR",
      "amountMajor": "99.00",
      "amountMinor": 9900,
      "feature": "INTERVIEW_SESSION"
    },
    {
      "code": "starter_10",
      "name": "Starter",
      "credits": "10",
      "currency": "INR",
      "amountMajor": "149.00",
      "amountMinor": 14900,
      "feature": "INTERVIEW_SESSION"
    }
  ]
}
```

### GET /credits/brackets
Public endpoint. Returns active credit brackets.

Success `200`:
```json
{
  "success": true,
  "data": [
    {
      "id": "cfg-30",
      "bracketMinutes": 30,
      "creditsFull": "0.50",
      "creditsHalf": "0.25",
      "freeZoneMinutes": 5,
      "graceZoneMinutes": 5,
      "isActive": true,
      "updatedAt": "2026-04-28T10:00:00.000Z"
    },
    {
      "id": "cfg-60",
      "bracketMinutes": 60,
      "creditsFull": "1.00",
      "creditsHalf": "0.50",
      "freeZoneMinutes": 5,
      "graceZoneMinutes": 5,
      "isActive": true,
      "updatedAt": "2026-04-28T10:00:00.000Z"
    }
  ]
}
```

Error examples:
- `500`
```json
{ "error": "Internal Server Error" }
```

### GET /credits/balance
Authenticated. Returns current user balance.

Headers:
- `Authorization: Bearer <token>`

Success `200`:
```json
{
  "success": true,
  "data": {
    "userId": "db-user-uuid",
    "purchasedCredits": "5.00",
    "earnedCredits": "0.00",
    "heldCredits": "1.00",
    "totalAvailable": "4.00"
  }
}
```

Error examples:
- `401`
```json
{ "error": "Unauthorized: Authentication required" }
```

### POST /credits/purchase/order
Authenticated. Creates Razorpay order and stores a pending credit purchase.

Headers:
- `Authorization: Bearer <token>`

Request:
```json
{
  "packCode": "quick_5",
  "currency": "INR"
}
```

Success `201`:
```json
{
  "success": true,
  "data": {
    "orderId": "order_PxYz123",
    "keyId": "rzp_test_xxxxx",
    "amountMinor": 9900,
    "amountMajor": "99.00",
    "currency": "INR",
    "plan": {
      "code": "quick_5",
      "name": "Quick 5",
      "credits": "5",
      "currency": "INR",
      "amountMajor": "99.00",
      "amountMinor": 9900,
      "feature": "INTERVIEW_SESSION"
    }
  }
}
```

Error examples:
- `400`
```json
{ "error": "packCode is required" }
```
- `400`
```json
{ "error": "Invalid packCode" }
```
- `500`
```json
{ "error": "Razorpay is not configured" }
```

### POST /credits/purchase/verify
Authenticated. Verifies Razorpay signature and confirms purchase credits.

Headers:
- `Authorization: Bearer <token>`

Request:
```json
{
  "razorpay_order_id": "order_PxYz123",
  "razorpay_payment_id": "pay_PxYz123",
  "razorpay_signature": "f2db..."
}
```

Success `200`:
```json
{
  "success": true,
  "data": {
    "alreadyConfirmed": false,
    "purchaseId": "purchase-uuid",
    "creditsAdded": "5",
    "currency": "INR",
    "packName": "Quick 5"
  }
}
```

Error examples:
- `400`
```json
{ "error": "razorpay_order_id, razorpay_payment_id and razorpay_signature are required" }
```
- `400`
```json
{ "error": "INVALID_PAYMENT_SIGNATURE" }
```
- `404`
```json
{ "error": "Purchase order not found" }
```
- `403`
```json
{ "error": "Purchase does not belong to this user" }
```
- `404`
```json
{ "error": "User not found" }
```

### GET /credits/ledger?page=1&limit=20
Authenticated. Paginated ledger entries.

Query params:
- `page` default `1`
- `limit` default `20`, max `100`

Success `200`:
```json
{
  "success": true,
  "data": [
    {
      "id": "ledger-uuid",
      "userId": "db-user-uuid",
      "sessionId": "session-uuid",
      "type": "DEBIT",
      "amount": "0.50",
      "reason": "FULL_BRACKET",
      "createdAt": "2026-04-28T11:10:00.000Z"
    }
  ],
  "pagination": {
    "total": 12,
    "page": 1,
    "limit": 20,
    "pages": 1
  }
}
```

Error examples:
- `401`
```json
{ "error": "Unauthorized: Authentication required" }
```

### GET /credits/purchases
Authenticated. Purchase history.

Success `200`:
```json
{
  "success": true,
  "data": [
    {
      "id": "purchase-uuid",
      "userId": "db-user-uuid",
      "amountPaid": "499.00",
      "creditsAdded": "5.00",
      "currency": "INR",
      "status": "CONFIRMED",
      "createdAt": "2026-04-01T10:00:00.000Z"
    }
  ]
}
```

Error examples:
- `401`
```json
{ "error": "Unauthorized: Authentication required" }
```

---

## Session APIs

### POST /session/create-session
Creates a new session (starts as `PRE_CHECK`). Supports `multipart/form-data` or JSON body.

Example request (JSON):
```json
{
  "userId": "db-user-uuid",
  "companyName": "Google",
  "jobDescription": "SDE-2 interview",
  "resumeId": "resume-uuid",
  "documentId": "document-uuid",
  "language": "JavaScript",
  "simpleLanguage": true,
  "autoGenerateAI": true,
  "saveTranscript": true,
  "jobInputMode": "manual",
  "instructions": "Focus on system design",
  "extraContext": "I have 5 years experience",
  "free": false
}
```

Success `201`:
```json
{
  "success": true,
  "sessionId": "session-uuid",
  "data": {
    "id": "session-uuid",
    "status": "PRE_CHECK"
  }
}
```

Error examples:
- `400`
```json
{ "error": "userId is required" }
```
- `500`
```json
{ "success": false, "error": "Internal server error" }
```

### GET /session/list?userId=<id>&search=<text>&from_date=<iso>&to_date=<iso>
Lists user sessions with optional filters.

Success `200`:
```json
[
  {
    "id": "session-uuid",
    "companyName": "Google",
    "status": "COMPLETED",
    "createdAt": "2026-04-28T11:00:00.000Z",
    "feedback": null
  }
]
```

Error examples:
- `400`
```json
{ "error": "userId is required" }
```

### GET /session/:id
Get session by ID.

Success `200`:
```json
{
  "id": "session-uuid",
  "status": "ACTIVE",
  "creditsHeld": "1.00",
  "maxAllowedMinutes": 60,
  "feedback": null
}
```

Error examples:
- `404`
```json
{ "error": "Session not found" }
```

### DELETE /session/:id
Deletes a session. If session is `PRE_CHECK` with hold, hold is released.

Success `200`:
```json
{
  "id": "session-uuid",
  "status": "PRE_CHECK"
}
```

Error examples:
- `500`
```json
{ "error": "Internal server error" }
```

### POST /session/:id/activate
Activates session and places hold (paid sessions only).

Success `200`:
```json
{
  "success": true,
  "sessionId": "session-uuid",
  "startedAt": "2026-04-28T11:00:00.000Z",
  "creditsHeld": "1.00",
  "maxAllowedMinutes": 60,
  "timer": 0
}
```

Error examples:
- `402`
```json
{ "error": "INSUFFICIENT_CREDITS" }
```
- `404`
```json
{ "error": "Session not found" }
```
- `409`
```json
{ "error": "Cannot activate session in status COMPLETED" }
```

### POST /session/:id/heartbeat
Called every ~60s while active.

Request:
```json
{ "elapsedMinutes": 59 }
```

Success `200` examples:
```json
{ "action": "NONE", "remainingMinutes": 40 }
```

```json
{ "action": "CREDIT_WARNING", "remainingMinutes": 1 }
```

```json
{ "action": "CREDIT_EXHAUSTED" }
```

Notes:
- If session is not found / not ACTIVE, returns `{ "action": "NONE" }`.

### POST /session/:id/deactivate
Moves active session to `COMPLETING` (or immediate `COMPLETED` for free sessions).

Request:
```json
{
  "aiUsage": 4,
  "transcript": "candidate said ..."
}
```

Success `200`:
```json
{
  "success": true,
  "sessionId": "session-uuid",
  "status": "COMPLETING"
}
```

Idempotency:
- Calling deactivate again for already `COMPLETING` session returns success and does not duplicate deduction transition.

Error examples:
- `409`
```json
{ "error": "Cannot deactivate session in status PRE_CHECK" }
```

### POST /session/:id/analyze-screen
Uploads screenshot and streams AI answer tokens.

Body (`multipart/form-data`):
- `screenshot`: image file (required)
- `aiModel`: optional string (human-readable model names are normalized)

Success `200`:
- Streamed `text/plain` chunks.

Error examples:
- `400`
```json
{ "error": "No screenshot provided" }
```
- `500`
```json
{ "error": "Failed to analyze screen" }
```

### POST /session/:id/ai-answer
Streams AI answer from transcript.

Request:
```json
{
  "transcript": "user question transcript",
  "isCustomQuery": false,
  "aiModel": "Gemini 2.0 Flash"
}
```

Success `200`:
- Streamed `text/plain` chunks.

Error examples:
- `400`
```json
{ "error": "No transcript provided" }
```
- `500`
```json
{ "error": "Internal server error" }
```

### POST /session/:id/save-message
Appends message in session history.

Request:
```json
{
  "role": "candidate",
  "question": "Tell me about yourself",
  "answer": "I am ...",
  "time": "00:01:12"
}
```

Success `200`:
```json
{
  "success": true,
  "messages": [
    {
      "role": "candidate",
      "question": "Tell me about yourself",
      "answer": "I am ...",
      "time": "00:01:12"
    }
  ]
}
```

Error examples:
- `400`
```json
{ "error": "role and question are required" }
```

### GET /session/:id/analytics?force=true|false
Returns existing analytics or generates if missing/forced.

Success `200`:
```json
{
  "id": "feedback-uuid",
  "sessionId": "session-uuid",
  "score": 82,
  "confidence": 78,
  "strengths": ["Clear communication"],
  "improvements": ["More concise answers"]
}
```

Error examples:
- `400`
```json
{ "error": "id is required" }
```
- `500`
```json
{ "error": "Internal server error" }
```

### POST /session/:id/analytics
Forces analytics generation (optional transcript in body).

Request:
```json
{
  "transcript": "full transcript text"
}
```

Success `200`:
```json
{
  "success": true,
  "data": {
    "sessionId": "session-uuid",
    "score": 84
  }
}
```

---

## Resume APIs

### POST /resume/upload
Uploads resume file and validates resume content via AI.

Body (`multipart/form-data`):
- `resume`: file (`.pdf`, `.doc`, `.docx`) required
- `userId`: required

Success `201`:
```json
{
  "id": "resume-uuid",
  "filename": "john_1714290900.pdf",
  "path": "uploads/resumes/john_1714290900.pdf",
  "size": 120034,
  "resumeContext": "Extracted text ...",
  "userId": "db-user-uuid"
}
```

Error examples:
- `400`
```json
{ "error": "No file uploaded" }
```
- `400`
```json
{ "error": "Missing userId" }
```
- `400`
```json
{ "error": "Could not extract any text from the file" }
```
- `400`
```json
{ "error": "Please upload a valid resume. The uploaded file does not appear to be a resume/CV." }
```

### GET /resume/list?userId=<id>
Lists resumes for user.

Success `200`:
```json
[
  {
    "id": "resume-uuid",
    "filename": "resume.pdf",
    "uploadedAt": "2026-04-28T10:00:00.000Z"
  }
]
```

Error examples:
- `400`
```json
{ "error": "Missing userId query parameter" }
```

### DELETE /resume/:id
Deletes resume.

Success `200`:
```json
{ "message": "Resume deleted successfully" }
```

Error examples:
- `404`
```json
{ "error": "Resume not found" }
```

### POST /resume/ats-score
Runs ATS scoring for a resume.

Request:
```json
{ "resumeId": "resume-uuid" }
```

Success `200` (example):
```json
{
  "score": 78,
  "summary": "Good overall profile",
  "strengths": ["Strong backend experience"],
  "weaknesses": ["Missing quantified achievements"],
  "missingKeywords": ["microservices"],
  "suggestions": ["Add impact metrics"]
}
```

Error examples:
- `400`
```json
{ "error": "resumeId is required" }
```

### GET /resume/all-ats?userId=<id>
Lists resumes that have ATS analysis.

Success `200`: array of resumes with ATS data.

Error examples:
- `400`
```json
{ "error": "Missing userId query parameter" }
```

### POST /resume/generate-cover-letter
Generates cover letter from resume + job data.

Request:
```json
{
  "resumeId": "resume-uuid",
  "jobRole": "Backend Engineer",
  "company": "Google",
  "jobDescription": "...",
  "tone": "professional"
}
```

Success `200`:
```json
{ "coverLetter": "Dear Hiring Manager, ..." }
```

Error examples:
- `400`
```json
{ "error": "resumeId is required" }
```

### POST /resume/create-template
Creates a resume template.

Request:
```json
{
  "category": "software-engineering",
  "thumbnail": "https://cdn.example.com/template.png",
  "code": "<html>...</html>"
}
```

Success `201`:
```json
{
  "id": "template-uuid",
  "category": "software-engineering",
  "thumbnail": "https://cdn.example.com/template.png",
  "code": "<html>...</html>"
}
```

Error examples:
- `400`
```json
{ "error": "category, thumbnail, and code are required" }
```

### GET /resume/all-templates
Lists all templates.

Success `200`: array of templates.

---

## Document APIs

### POST /document/upload
Uploads generic document.

Body (`multipart/form-data`):
- `document`: file (`.pdf`, `.doc`, `.docx`) required
- `userId`: required

Success `201`:
```json
{
  "id": "document-uuid",
  "filename": "jd_1714290900.pdf",
  "path": "uploads/documents/jd_1714290900.pdf",
  "size": 80334,
  "userId": "db-user-uuid"
}
```

Error examples:
- `400`
```json
{ "error": "No file uploaded" }
```
- `400`
```json
{ "error": "Missing userId" }
```

### GET /document/list?userId=<id>
Lists documents for a user.

Success `200`: array of documents.

Error examples:
- `400`
```json
{ "error": "Missing userId query parameter" }
```

### DELETE /document/:id
Deletes document.

Success `200`:
```json
{ "message": "Document deleted successfully" }
```

---

## QA APIs

### POST /qa
Creates a QA record.

Request:
```json
{
  "companyId": "company-uuid",
  "sessionId": "session-uuid",
  "ques": "Explain event loop",
  "answer": "...",
  "difficulty": "Medium",
  "industry": "Full_Stack",
  "language": "JavaScript",
  "isShared": true
}
```

Success `201`:
```json
{
  "success": true,
  "data": {
    "id": "qa-uuid",
    "ques": "Explain event loop"
  }
}
```

Error examples:
- `400`
```json
{ "error": "companyId and ques are required" }
```

### GET /qa/shared
Lists public QA entries.

Success `200`: array

### GET /qa/session/:sessionId
Lists QAs by session.

Success `200`: array

### GET /qa/company/:companyId
Lists QAs by company.

Success `200`: array

### GET /qa/user/:userId
Lists QAs by user.

Success `200`: array

### GET /qa/:id
Gets one QA record.

Success `200`: object

Error examples:
- `404`
```json
{ "error": "QA not found" }
```

### PATCH /qa/:id
Updates QA.

Request:
```json
{
  "answer": "Updated answer",
  "difficulty": "Hard",
  "isShared": false
}
```

Success `200`:
```json
{
  "success": true,
  "data": {
    "id": "qa-uuid",
    "answer": "Updated answer"
  }
}
```

### DELETE /qa/:id
Deletes QA.

Success `200`:
```json
{ "success": true }
```

---

## Company APIs

### GET /company
Lists all companies.

Success `200`:
```json
[
  {
    "id": "company-uuid",
    "name": "Google",
    "slug": "google"
  }
]
```

### GET /company/:identifier
Fetches company by UUID or slug.

Success `200`:
```json
{
  "id": "company-uuid",
  "name": "Google",
  "slug": "google"
}
```

Error examples:
- `404`
```json
{ "error": "Company not found" }
```

---

## Projects APIs

### POST /projects/generate
Streams AI-generated project suggestions from resume context.

Body:
- `multipart/form-data` supported with optional `resume` file
- Or JSON with `resumeId` / `resumeText`

Required:
- `userId`
- At least one of: `resumeId`, `resumeText`, or uploaded `resume` file

Example request (JSON):
```json
{
  "userId": "db-user-uuid",
  "resumeId": "resume-uuid",
  "position": "Backend Engineer",
  "jobDescription": "..."
}
```

Example request (multipart):
- `resume`: file
- `userId`: `db-user-uuid`
- `position`: `Backend Engineer`

Success `200`:
- Streamed plain-text chunks
- Each project JSON chunk is delimited by: `|||PROJECT_END|||`

Error examples:
- `400`
```json
{ "error": "userId is required" }
```
- `400`
```json
{ "error": "Either resumeId, resumeText, or a valid resume file is required" }
```

### GET /projects/user/:userId
Lists generated projects for user.

Success `200`: array

Error examples:
- `400`
```json
{ "error": "userId is required" }
```

### GET /projects/:id
Gets a project by ID.

Success `200`: object

Error examples:
- `400`
```json
{ "error": "Project ID is required" }
```
- `404`
```json
{ "error": "Project not found" }
```

---

## Session Status and Credit Flow (Frontend Integration Notes)

Session status lifecycle used by APIs:
- `PRE_CHECK` -> `ACTIVE` -> `COMPLETING` -> `COMPLETED`
- Alternative terminal states: `CREDIT_EXHAUSTED`, `FORCE_ENDED`, `ABANDONED`

Recommended client flow:
1. `POST /session/create-session`
2. `POST /session/:id/activate`
3. Start timer + call `POST /session/:id/heartbeat` every 60s
4. If warning, show `remainingMinutes`
5. On user end, call `POST /session/:id/deactivate`
6. Poll `GET /session/:id` until status becomes `COMPLETED`
7. Fetch credits with `GET /credits/balance` and `GET /credits/ledger`

---

## Version History

| Version | Date | Summary |
|---|---|---|
| v1.2.0 | 2026-04-28 | Added interview-session credit pack APIs and Razorpay purchase order + verification flow. |
| v1.1.0 | 2026-04-28 | Added complete endpoint coverage and standardized request/response and error examples across all mounted APIs. |

Versioning rules:
- `MAJOR`: breaking API contract change.
- `MINOR`: new endpoint or backward-compatible response expansion.
- `PATCH`: documentation-only clarification/correction.

---

## Notes on Non-Exposed Routes

`src/features/user/user.routes.ts` exists in codebase but is not mounted in `src/routes/index.ts`, so those endpoints are not reachable under `/api`.
