# ScribeShade Backend API Reference

Last updated: 2026-05-04
Document version: v1.7.0

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

### POST /auth/tauri-ticket
Creates a short-lived Clerk sign-in token for Tauri desktop clients that cannot complete the standard browser OAuth flow.

Headers:
- `Authorization: Bearer <token>`

Auth: Required (`requireAuth`)

Success `200`:
```json
{ "ticket": "<clerk_sign_in_token>" }
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

## Policy APIs

### GET /policy
Public endpoint. Returns the latest privacy policy and terms and conditions.

Success `200`:
```json
{
  "success": true,
  "data": {
    "id": "policy-uuid",
    "privacyPolicy": "Privacy policy text...",
    "termsAndConditions": "Terms and conditions text...",
    "updatedAt": "2026-04-30T11:30:00.000Z"
  }
}
```

### POST /policy
Creates or updates the privacy policy and terms and conditions.

Request:
```json
{
  "privacyPolicy": "Updated privacy policy...",
  "termsAndConditions": "Updated T&C..."
}
```

Success `201`:
```json
{
  "success": true,
  "data": {
    "id": "policy-uuid",
    "privacyPolicy": "...",
    "termsAndConditions": "...",
    "updatedAt": "2026-04-30T11:35:00.000Z"
  }
}
```

Error examples:
- `400`:
```json
{
  "success": false,
  "error": "Both privacyPolicy and termsAndConditions are required"
}
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

### GET /session/:id/events
Opens a Server-Sent Events (SSE) stream for real-time session lifecycle notifications.

Headers:
- `Accept: text/event-stream`

Success: Connection is held open, `Content-Type: text/event-stream`. Events are pushed as they occur.

Initial response:
```
: connected
```

Event format:
```
event: <name>
data: {"..."}

```

Known event names emitted by the server: `session_status_changed`, `credit_warning`, `credit_exhausted`.

Note: No Auth guard on this endpoint — session ID in the path acts as a capability token.

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
  "grade": "B+",
  "summary": "Good overall profile",
  "strengths": ["Strong backend experience"],
  "weaknesses": ["Missing quantified achievements"],
  "missingKeywords": ["microservices"],
  "suggestions": ["Add impact metrics"],
  "sectionScores": {
    "experience": 80,
    "skills": 75,
    "education": 70
  }
}
```

`grade` values: `A+` (95–100), `A` (90–94), `B+` (85–89), `B` (80–84), `C+` (75–79), `C` (70–74), `D` (60–69), `F` (<60).

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
Generates a cover letter from resume content + job data.

Request:
```json
{
  "resumeId": "resume-uuid",
  "jobRole": "Backend Engineer",
  "company": "Google",
  "jobDescription": "...",
  "tone": "professional",
  "userName": "John Doe",
  "userEmail": "john@example.com"
}
```

`tone` — optional, default `"professional"`. `userName` and `userEmail` are optional and are included in the AI prompt when provided.

Success `200`:
```json
{
  "coverLetter": "Dear Hiring Manager, ...",
  "wordCount": 245
}
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
  "name": "Modern",
  "category": "software-engineering",
  "thumbnail": "https://cdn.example.com/template.png",
  "code": "<html>...</html>"
}
```

All four fields are required.

Success `201`:
```json
{
  "id": "template-uuid",
  "name": "Modern",
  "category": "software-engineering",
  "thumbnail": "https://cdn.example.com/template.png",
  "code": "<html>...</html>",
  "createdAt": "2026-05-05T10:00:00.000Z"
}
```

Error examples:
- `400`
```json
{ "error": "name, category, thumbnail, and code are required" }
```

### GET /resume/all-templates
Lists all templates. Three default templates are seeded: **Classic**, **Modern**, **Minimal**.

Success `200`: array of templates, each with `id`, `name`, `category`, `thumbnail`, `code`, `createdAt`.

### POST /resume/builder/save
Creates a new built resume draft or updates an existing one. Requires auth.

Headers: `Authorization: Bearer <token>`

Request:
```json
{
  "userId": "db-user-uuid",
  "resumeId": null,
  "title": "Frontend – HMS",
  "templateId": "classic",
  "fields": {
    "name": "Tushar Vaghela",
    "role": "Frontend Engineer",
    "email": "tusharvaghela601@gmail.com",
    "phone": "+919587308671",
    "location": "Mumbai, India",
    "links": "github.com/tushar",
    "summary": "3 years experience in React...",
    "experience": "HMS | Frontend Eng | 2024–Present",
    "skillsLanguages": "TypeScript, JavaScript",
    "skillsFrameworks": "React, Tailwind CSS",
    "skillsDatabases": "PostgreSQL",
    "skillsTools": "Docker, AWS",
    "projects": "Zepto Clone\n• Responsive UI",
    "education": "B.Tech CS\nXYZ University\n2024",
    "certifications": "",
    "publications": ""
  },
  "sections": [
    { "id": "personalInfo", "label": "Personal Info", "enabled": true, "required": true }
  ],
  "jobDescription": "We are looking for a frontend engineer...",
  "jobTitle": "Frontend Engineer",
  "company": "HMS"
}
```

Pass `"resumeId": null` to create; pass an existing UUID to update.
Required fields: `userId`, `title`, `templateId`, `fields`, `sections`.

Success `201` (create) / `200` (update):
```json
{
  "id": "built-resume-uuid",
  "userId": "db-user-uuid",
  "title": "Frontend – HMS",
  "templateId": "classic",
  "fields": { "...": "..." },
  "sections": [ "..." ],
  "jobTitle": "Frontend Engineer",
  "company": "HMS",
  "createdAt": "2026-05-04T10:00:00.000Z",
  "updatedAt": "2026-05-04T10:05:32.000Z"
}
```

Error examples:
- `400`
```json
{ "error": "userId, title, templateId, fields and sections are required" }
```
- `404`
```json
{ "error": "Resume not found" }
```

### GET /resume/builder/list?userId=<id>
Lists all built resumes for a user. Requires auth.

Headers: `Authorization: Bearer <token>`

Success `200`:
```json
[
  {
    "id": "built-resume-uuid",
    "title": "Frontend – HMS",
    "templateId": "classic",
    "jobTitle": "Frontend Engineer",
    "company": "HMS",
    "createdAt": "2026-05-04T10:00:00.000Z",
    "updatedAt": "2026-05-04T10:05:32.000Z"
  }
]
```

Error examples:
- `400`
```json
{ "error": "userId query parameter is required" }
```

### GET /resume/builder/:id
Returns a single built resume including all fields and sections. Requires auth.

Headers: `Authorization: Bearer <token>`

Success `200`:
```json
{
  "id": "built-resume-uuid",
  "userId": "db-user-uuid",
  "title": "Frontend – HMS",
  "templateId": "classic",
  "fields": { "name": "Tushar Vaghela", "...": "..." },
  "sections": [ "..." ],
  "jobTitle": "Frontend Engineer",
  "company": "HMS",
  "jobDescription": "...",
  "createdAt": "2026-05-04T10:00:00.000Z",
  "updatedAt": "2026-05-04T10:05:32.000Z"
}
```

Error examples:
- `404`
```json
{ "error": "Resume not found" }
```

### DELETE /resume/builder/:id
Deletes a built resume. Requires auth.

Headers: `Authorization: Bearer <token>`

Success `200`:
```json
{ "message": "Built resume deleted successfully" }
```

Error examples:
- `404`
```json
{ "error": "Resume not found" }
```

### POST /resume/builder/generate
AI-populates a resume template with user fields and optional JD context. Costs **1 credit**. Requires auth.

Headers: `Authorization: Bearer <token>`

Request:
```json
{
  "userId": "db-user-uuid",
  "templateCode": "<!DOCTYPE html>...",
  "fields": { "name": "Tushar Vaghela", "...": "..." },
  "jobDescription": "We are looking for a frontend engineer...",
  "jobTitle": "Frontend Engineer",
  "company": "HMS"
}
```

Required: `userId`, `templateCode`, `fields`.

Success `200`:
```json
{
  "populatedHtml": "<!DOCTYPE html>... fully populated HTML ...",
  "creditsUsed": 1,
  "creditsRemaining": 14
}
```

Error examples:
- `400`
```json
{ "error": "userId, templateCode, and fields are required" }
```
- `402`
```json
{ "error": "Insufficient credits. Required: 1, Available: 0" }
```

### POST /resume/builder/enhance-section
AI-rewrites a single resume section to be more impactful. Costs **0.5 credits**. Requires auth.

Headers: `Authorization: Bearer <token>`

Request:
```json
{
  "userId": "db-user-uuid",
  "sectionId": "summary",
  "currentText": "I am a frontend developer with experience in React.",
  "jobDescription": "We need a senior engineer...",
  "jobTitle": "Senior Frontend Engineer",
  "resumeContext": "Tushar Vaghela, Frontend Engineer, 3 years..."
}
```

Valid `sectionId` values: `summary` | `experience` | `skills` | `projects` | `education` | `certifications` | `publications`

Required: `userId`, `sectionId`, `currentText`.

Success `200`:
```json
{
  "sectionId": "summary",
  "enhancedText": "Results-driven Frontend Engineer with 3+ years...",
  "creditsUsed": 0.5,
  "creditsRemaining": 13.5
}
```

Error examples:
- `400`
```json
{ "error": "userId, sectionId, and currentText are required" }
```
- `400`
```json
{ "error": "Invalid sectionId" }
```
- `402`
```json
{ "error": "Insufficient credits. Required: 0.5, Available: 0" }
```

### POST /resume/builder/tailor
AI-tailors all resume sections to a target job description. Costs **1 credit**. Requires auth.

Headers: `Authorization: Bearer <token>`

Request:
```json
{
  "userId": "db-user-uuid",
  "resumeId": "built-resume-uuid",
  "jobDescription": "We are hiring a Senior Frontend Engineer...",
  "jobTitle": "Senior Frontend Engineer",
  "company": "Stripe"
}
```

Required: `userId`, `resumeId`, `jobDescription`.

Success `200`:
```json
{
  "tailoredFields": {
    "summary": "Results-driven Frontend Engineer...",
    "experience": "HMS | Frontend Engineer | 2024–Present\n...",
    "skillsLanguages": "TypeScript, JavaScript",
    "skillsFrameworks": "React 18, Next.js, Node.js",
    "skillsDatabases": "PostgreSQL, Redis",
    "skillsTools": "Docker, AWS, Vercel",
    "projects": "Stripe-style Payment UI\n..."
  },
  "keywordsMatched": ["TypeScript", "React 18", "Node.js"],
  "keywordsMissing": ["mentoring", "WebSockets"],
  "matchScore": 81,
  "creditsUsed": 1,
  "creditsRemaining": 12
}
```

Error examples:
- `400`
```json
{ "error": "userId, resumeId, and jobDescription are required" }
```
- `402`
```json
{ "error": "Insufficient credits. Required: 1, Available: 0" }
```
- `404`
```json
{ "error": "Resume not found" }
```

### POST /resume/builder/export-pdf
Saves the populated resume HTML to disk and returns a static download URL. Requires auth.

Headers: `Authorization: Bearer <token>`

Request:
```json
{
  "userId": "db-user-uuid",
  "resumeId": "built-resume-uuid",
  "populatedHtml": "<!DOCTYPE html>... fully populated ..."
}
```

Send either `resumeId` (server fetches from DB) **or** `populatedHtml` (client provides rendered HTML).

Success `200`:
```json
{
  "downloadUrl": "/uploads/exports/resume_export_1714290900000.html",
  "expiresAt": "2026-05-05T10:00:00.000Z"
}
```

> Note: The export serves an HTML file. PDF rendering can be done client-side via `window.print()`. A puppeteer-based PDF endpoint can be added when `puppeteer` is installed.

Error examples:
- `400`
```json
{ "error": "resumeId or populatedHtml is required" }
```
- `404`
```json
{ "error": "Resume not found" }
```

---

## Session Notes APIs

### POST /session-notes/:sessionId/generate
AI-generates a structured summary and coaching notes for a completed session. Notes are stored and returned.

No request body required.

Success `201`:
```json
{
  "success": true,
  "data": {
    "id": "notes-uuid",
    "sessionId": "session-uuid",
    "content": "Session summary and coaching notes...",
    "createdAt": "2026-05-04T10:00:00.000Z"
  }
}
```

Error examples:
- `400`
```json
{ "error": "sessionId is required" }
```
- `404`
```json
{ "error": "Session not found" }
```
- `500`
```json
{ "success": false, "error": "Internal server error" }
```

### GET /session-notes/:sessionId
Retrieves the stored notes/summary for a session. Returns `null` data if notes have not been generated yet.

Success `200`:
```json
{
  "success": true,
  "data": {
    "id": "notes-uuid",
    "sessionId": "session-uuid",
    "content": "Session summary and coaching notes...",
    "createdAt": "2026-05-04T10:00:00.000Z"
  }
}
```

Error examples:
- `400`
```json
{ "error": "sessionId is required" }
```

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

## AI APIs

### POST /ai/project-generation
Generates a single structured AI project response aligned to resume skills, JD, and role type.

Headers:
- `Authorization: Bearer <clerk_jwt>`

Auth:
- Required (`requireAuth`)

Request body (`application/json`):
```json
{
  "resume_id": "resume-uuid",
  "role_type": "Full Stack Developer",
  "jd_text": "optional JD paste",
  "experience_level": "mid",
  "resume_skills": ["React", "Node.js", "PostgreSQL"],
  "session_key": "optional-client-session-key"
}
```

Notes:
- At least 2 known skills must be available (from `resume_skills` and/or resume `parsedData`/`metadataIndex`).
- Max 5 generations per session window (rolling 60 minutes) for the same user/session key.
- Consumes 4 credits and writes usage entry to `CreditUsage`.
- When `resume_id` is provided, generated output is also appended to `Resume.parsedData.projects[]`.

Success `200`:
```json
{
  "success": true,
  "data": {
    "project_title": "Real-Time Order Tracking Dashboard",
    "narrative": "Built a full-stack order tracking system...",
    "star_story": {
      "situation": "E-commerce team lacked shipment visibility",
      "task": "Design and ship tracking dashboard",
      "action": "Implemented React UI + Express API + PostgreSQL",
      "result": "Reduced support tickets by 35%"
    },
    "architecture": {
      "frontend": "React, Tailwind CSS",
      "backend": "Node.js, Express",
      "database": "PostgreSQL",
      "infrastructure": "Docker, Vercel"
    },
    "ascii_diagram": "[React UI] -> [Express API] -> [PostgreSQL]",
    "thirty_sec_summary": "Built a real-time order dashboard...",
    "memory_hooks": ["REST for simplicity", "Redis as speed layer"],
    "credibility_score": 82,
    "credibility_warning": false,
    "scope_limited": false,
    "credits_consumed": 4
  }
}
```

Error examples:
- `400`
```json
{ "error": "At least 2 skills are required to generate a project" }
```
- `401`
```json
{ "error": "Unauthorized: Authentication required" }
```
- `402`
```json
{ "error": "INSUFFICIENT_CREDITS" }
```
- `429`
```json
{ "error": "Rate limit exceeded: max 5 generations per session window" }
```
- `503`
```json
{ "error": "AI model temporarily unavailable" }
```

### GET /project-categories?role_type=fullstack
Returns predefined project categories by role type.

Auth:
- Public

Success `200`:
```json
{
  "success": true,
  "data": {
    "role_type": "fullstack",
    "categories": ["Web App", "API Service", "DevOps/Infrastructure"]
  }
}
```

Error examples:
- `500`
```json
{ "error": "Internal Server Error" }
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
| v1.7.0 | 2026-05-04 | Added 4 previously undocumented endpoints: `POST /auth/tauri-ticket` (Tauri desktop sign-in token), `GET /session/:id/events` (SSE real-time stream), `POST /session-notes/:sessionId/generate` (AI session notes generation), `GET /session-notes/:sessionId` (retrieve notes). Added **Session Notes APIs** section. |
| v1.6.0 | 2026-05-05 | Updated `POST /resume/ats-score` response to include `grade` (letter grade A+–F) and `sectionScores` (per-section numeric scores). Updated `POST /resume/generate-cover-letter` response to include `wordCount`; request now accepts optional `userName` and `userEmail`. Updated `POST /resume/create-template` to require `name` field; `GET /resume/all-templates` now returns `name`. Three default templates (Classic, Modern, Minimal) seeded via `pnpm seed:templates`. |
| v1.5.0 | 2026-05-04 | Added 8 Resume Builder endpoints: `POST /resume/builder/save`, `GET /resume/builder/list`, `GET /resume/builder/:id`, `DELETE /resume/builder/:id`, `POST /resume/builder/generate` (1cr), `POST /resume/builder/enhance-section` (0.5cr), `POST /resume/builder/tailor` (1cr), `POST /resume/builder/export-pdf`. Added `BuiltResume` Prisma model and migration. |
| v1.4.0 | 2026-05-04 | Added AI project generation API (`POST /ai/project-generation`) with auth, credit deduction + usage logging, scope/credibility guards, plus categories API (`GET /project-categories`). |
| v1.2.0 | 2026-04-28 | Added interview-session credit pack APIs and Razorpay purchase order + verification flow. |
| v1.1.0 | 2026-04-28 | Added complete endpoint coverage and standardized request/response and error examples across all mounted APIs. |

Versioning rules:
- `MAJOR`: breaking API contract change.
- `MINOR`: new endpoint or backward-compatible response expansion.
- `PATCH`: documentation-only clarification/correction.

---

## Notes on Non-Exposed Routes

`src/features/user/user.routes.ts` exists in codebase but is not mounted in `src/routes/index.ts`, so those endpoints are not reachable under `/api`.
