# Resume Module — Complete API Reference

**Base URL:** `https://test.backend.scribeshade.org/api`  
**Auth:** All endpoints require `Authorization: Bearer <clerk_jwt>` unless marked `PUBLIC`.  
**Content-Type:** `application/json` unless noted.  
**Last updated:** 2026-05-04

---

## Overview — Resume Module Endpoints

| # | Method | Path | Description | Credits |
|---|--------|------|-------------|---------|
| 1 | POST | `/resume/upload` | Upload & extract a PDF/DOCX resume | — |
| 2 | GET | `/resume/list` | List user's uploaded resumes | — |
| 3 | DELETE | `/resume/:id` | Delete an uploaded resume | — |
| 4 | GET | `/resume/all-templates` | List all builder templates | PUBLIC |
| 5 | POST | `/resume/create-template` | Create a new HTML template (admin) | — |
| 6 | POST | `/resume/builder/save` | Save / upsert a built resume draft | — |
| 7 | GET | `/resume/builder/list` | List all user's built resumes | — |
| 8 | GET | `/resume/builder/:id` | Get a single built resume by ID | — |
| 9 | DELETE | `/resume/builder/:id` | Delete a built resume | — |
| 10 | POST | `/resume/builder/generate` | Generate full resume HTML via AI | 1 credit |
| 11 | POST | `/resume/builder/enhance-section` | AI-enhance a single resume section | 0.5 credits |
| 12 | POST | `/resume/builder/tailor` | Tailor a resume to a job description | 1 credit |
| 13 | POST | `/resume/builder/export-pdf` | Export built resume to PDF (server-side) | — |
| 14 | POST | `/resume/ats-score` | Run ATS score against a resume | FREE |
| 15 | GET | `/resume/all-ats` | List resumes with ATS history | — |
| 16 | POST | `/resume/generate-cover-letter` | Generate cover letter from resume + JD | 1 credit |

---

## 1. POST `/resume/upload`

Upload a PDF/DOCX resume file. Validates it is a genuine CV via AI, extracts raw text, and stores it.

**Content-Type:** `multipart/form-data`

**Request fields:**

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `resume` | File | ✅ | `.pdf`, `.doc`, `.docx` |
| `userId` | string | ✅ | DB user UUID |

**Success `201`:**
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "filename": "tushar_vaghela_1714290900.pdf",
  "path": "uploads/resumes/tushar_vaghela_1714290900.pdf",
  "size": 143872,
  "resumeContext": "TUSHAR VAGHELA\nFrontend Engineer\n+919587308671 | ...",
  "userId": "db-user-uuid",
  "createdAt": "2026-05-04T10:00:00.000Z"
}
```

**Errors:**

| Status | Body |
|--------|------|
| `400` | `{ "error": "No file uploaded" }` |
| `400` | `{ "error": "Missing userId" }` |
| `400` | `{ "error": "Could not extract any text from the file" }` |
| `400` | `{ "error": "Please upload a valid resume. The uploaded file does not appear to be a resume/CV." }` |
| `401` | `{ "error": "Unauthorized" }` |

---

## 2. GET `/resume/list?userId=<id>`

List all resumes uploaded by a user.

**Query params:** `userId` (required)

**Success `200`:**
```json
[
  {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "filename": "tushar_vaghela.pdf",
    "size": 143872,
    "resumeContext": "TUSHAR VAGHELA\nFrontend Engineer...",
    "uploadedAt": "2026-05-04T10:00:00.000Z"
  }
]
```

**Errors:**

| Status | Body |
|--------|------|
| `400` | `{ "error": "Missing userId query parameter" }` |

---

## 3. DELETE `/resume/:id`

Delete an uploaded resume record and file.

**Path param:** `id` — resume UUID

**Success `200`:**
```json
{ "message": "Resume deleted successfully" }
```

**Errors:**

| Status | Body |
|--------|------|
| `404` | `{ "error": "Resume not found" }` |

---

## 4. GET `/resume/all-templates` — PUBLIC

List all available HTML resume templates.

**Success `200`:**
```json
[
  {
    "id": "template-uuid",
    "name": "Classic",
    "category": "Classic",
    "thumbnail": "https://cdn.scribeshade.com/templates/classic.png",
    "code": "<!DOCTYPE html><html>...</html>"
  },
  {
    "id": "template-uuid-2",
    "name": "Modern",
    "category": "Modern",
    "thumbnail": "https://cdn.scribeshade.com/templates/modern.png",
    "code": "<!DOCTYPE html><html>...</html>"
  }
]
```

> **Note:** Returns `[]` when no templates are stored. The frontend falls back to three built-in defaults (Classic / Modern / Minimal) in this case.

---

## 5. POST `/resume/create-template`

Create a new HTML template (admin only).

**Request:**
```json
{
  "name": "Executive",
  "category": "Executive",
  "thumbnail": "https://cdn.scribeshade.com/templates/executive.png",
  "code": "<!DOCTYPE html><html>...</html>"
}
```

**Fields:**

| Field | Type | Required |
|-------|------|----------|
| `name` | string | ✅ |
| `category` | string | ✅ |
| `thumbnail` | string (URL) | ✅ |
| `code` | string (full HTML) | ✅ |

**Success `201`:**
```json
{
  "id": "template-uuid",
  "name": "Executive",
  "category": "Executive",
  "thumbnail": "https://cdn.scribeshade.com/templates/executive.png",
  "code": "<!DOCTYPE html>...",
  "createdAt": "2026-05-04T10:00:00.000Z"
}
```

**Errors:**

| Status | Body |
|--------|------|
| `400` | `{ "error": "name, category, thumbnail, and code are required" }` |

---

## 6. POST `/resume/builder/save`

Save (create or update) a resume built in the editor. Called by the **Save** button and auto-save.

**Request:**
```json
{
  "userId": "db-user-uuid",
  "resumeId": "built-resume-uuid-or-null",
  "title": "Frontend – HMS",
  "templateId": "classic",
  "fields": {
    "name": "Tushar Vaghela",
    "role": "Frontend Engineer",
    "email": "tusharvaghela601@gmail.com",
    "phone": "+919587308671",
    "location": "Mumbai, India",
    "links": "github.com/tushar | linkedin.com/in/tushar",
    "summary": "Results-driven frontend engineer with 3 years experience...",
    "experience": "HMS | Frontend Engineer | Jan 2024 – Present\n• Built X\n• Reduced Y by 30%",
    "skillsLanguages": "TypeScript, JavaScript, Python",
    "skillsFrameworks": "React, Node.js, Tailwind CSS",
    "skillsDatabases": "PostgreSQL, Redis, MongoDB",
    "skillsTools": "Docker, AWS, GitHub Actions",
    "projects": "Zepto Clone\n• Built responsive e-commerce UI\n• Implemented real-time search",
    "education": "B.Tech Computer Science\nXYZ University\n2020 – 2024",
    "certifications": "AWS Solutions Architect – Associate (2024)",
    "publications": ""
  },
  "sections": [
    { "id": "personalInfo", "label": "Personal Info", "enabled": true, "required": true },
    { "id": "summary",      "label": "Summary",       "enabled": true, "required": true },
    { "id": "experience",   "label": "Work Experience","enabled": true, "required": true },
    { "id": "skills",       "label": "Skills",         "enabled": true, "required": true },
    { "id": "projects",     "label": "Projects",       "enabled": true, "required": false },
    { "id": "education",    "label": "Education",      "enabled": true, "required": true },
    { "id": "certifications","label": "Certifications","enabled": false,"required": false },
    { "id": "publications", "label": "Publications",   "enabled": false,"required": false }
  ],
  "jobDescription": "We are looking for a frontend engineer proficient in React...",
  "jobTitle": "Frontend Engineer",
  "company": "HMS"
}
```

**Fields:**

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `userId` | string | ✅ | |
| `resumeId` | string \| null | — | Pass `null` to create; pass existing UUID to update |
| `title` | string | ✅ | |
| `templateId` | string | ✅ | `"classic"` \| `"modern"` \| `"minimal"` \| any template UUID |
| `fields` | object | ✅ | See `ResumeFields` shape above |
| `sections` | array | ✅ | Section order + visibility |
| `jobDescription` | string | — | |
| `jobTitle` | string | — | |
| `company` | string | — | |

**Success `200` (update) / `201` (create):**
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

**Errors:**

| Status | Body |
|--------|------|
| `400` | `{ "error": "userId, title, templateId, fields and sections are required" }` |
| `401` | `{ "error": "Unauthorized" }` |
| `404` | `{ "error": "Resume not found" }` (when `resumeId` is passed but doesn't exist) |

---

## 7. GET `/resume/builder/list?userId=<id>`

List all built resumes for a user (dashboard / "My Resumes" page).

**Query params:** `userId` (required)

**Success `200`:**
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

---

## 8. GET `/resume/builder/:id`

Fetch a single built resume (used when re-opening the editor).

**Path param:** `id` — built resume UUID

**Success `200`:**
```json
{
  "id": "built-resume-uuid",
  "userId": "db-user-uuid",
  "title": "Frontend – HMS",
  "templateId": "classic",
  "fields": {
    "name": "Tushar Vaghela",
    "role": "Frontend Engineer",
    "email": "tusharvaghela601@gmail.com",
    "phone": "+919587308671",
    "location": "Mumbai, India",
    "links": "github.com/tushar",
    "summary": "...",
    "experience": "...",
    "skillsLanguages": "TypeScript, JavaScript",
    "skillsFrameworks": "React, Node.js",
    "skillsDatabases": "PostgreSQL",
    "skillsTools": "Docker",
    "projects": "...",
    "education": "...",
    "certifications": "",
    "publications": ""
  },
  "sections": [ "..." ],
  "jobTitle": "Frontend Engineer",
  "company": "HMS",
  "jobDescription": "...",
  "createdAt": "2026-05-04T10:00:00.000Z",
  "updatedAt": "2026-05-04T10:05:32.000Z"
}
```

**Errors:**

| Status | Body |
|--------|------|
| `404` | `{ "error": "Resume not found" }` |

---

## 9. DELETE `/resume/builder/:id`

Delete a built resume.

**Path param:** `id` — built resume UUID

**Success `200`:**
```json
{ "message": "Built resume deleted successfully" }
```

---

## 10. POST `/resume/builder/generate`

AI-generates a complete populated resume HTML using a template + fields + optional JD context. Costs **1 credit**.

**Request:**
```json
{
  "userId": "db-user-uuid",
  "templateId": "classic",
  "templateCode": "<!DOCTYPE html>...",
  "fields": {
    "name": "Tushar Vaghela",
    "role": "Frontend Engineer",
    "email": "tusharvaghela601@gmail.com",
    "phone": "+919587308671",
    "location": "Mumbai, India",
    "links": "github.com/tushar",
    "summary": "3 years experience in React...",
    "experience": "HMS | Frontend Eng | 2024–Present\n• Built X",
    "skillsLanguages": "TypeScript, JavaScript",
    "skillsFrameworks": "React, Tailwind CSS",
    "skillsDatabases": "PostgreSQL",
    "skillsTools": "Docker, AWS",
    "projects": "Zepto Clone\n• Responsive UI",
    "education": "B.Tech CS\nXYZ University\n2024",
    "certifications": "",
    "publications": ""
  },
  "jobDescription": "We are looking for a frontend engineer...",
  "jobTitle": "Frontend Engineer",
  "company": "HMS"
}
```

**Success `200`:**
```json
{
  "populatedHtml": "<!DOCTYPE html><html>... fully populated resume HTML ...</html>",
  "creditsUsed": 1,
  "creditsRemaining": 14
}
```

**Errors:**

| Status | Body |
|--------|------|
| `400` | `{ "error": "userId, templateCode, and fields are required" }` |
| `402` | `{ "error": "Insufficient credits. Required: 1, Available: 0" }` |

---

## 11. POST `/resume/builder/enhance-section`

AI-rewrites a single section of the resume. Costs **0.5 credits**.

**Request:**
```json
{
  "userId": "db-user-uuid",
  "sectionId": "summary",
  "currentText": "I am a frontend developer with experience in React.",
  "jobDescription": "We need a senior engineer who can scale our React platform...",
  "jobTitle": "Senior Frontend Engineer",
  "resumeContext": "Tushar Vaghela, Frontend Engineer, 3 years experience..."
}
```

**`sectionId` values:** `"summary"` | `"experience"` | `"skills"` | `"projects"` | `"education"` | `"certifications"` | `"publications"`

**Success `200`:**
```json
{
  "sectionId": "summary",
  "enhancedText": "Results-driven Frontend Engineer with 3+ years of expertise in React, TypeScript and performance-critical UIs. Demonstrated ability to reduce load time by 40%, drive 30% engagement uplift, and lead cross-functional teams in delivering production-grade web applications.",
  "creditsUsed": 0.5,
  "creditsRemaining": 13.5
}
```

**Errors:**

| Status | Body |
|--------|------|
| `400` | `{ "error": "userId, sectionId, and currentText are required" }` |
| `400` | `{ "error": "Invalid sectionId" }` |
| `402` | `{ "error": "Insufficient credits. Required: 0.5, Available: 0" }` |

---

## 12. POST `/resume/builder/tailor`

Tailors an entire resume to a specific job description by rewriting all relevant sections. Costs **1 credit**.

**Request:**
```json
{
  "userId": "db-user-uuid",
  "resumeId": "built-resume-uuid",
  "jobDescription": "We are hiring a Senior Frontend Engineer to lead our React platform team. Requirements: TypeScript, React 18, Node.js, system design, mentoring...",
  "jobTitle": "Senior Frontend Engineer",
  "company": "Stripe"
}
```

**Success `200`:**
```json
{
  "tailoredFields": {
    "summary": "Results-driven Frontend Engineer...",
    "experience": "HMS | Frontend Engineer | 2024–Present\n• Scaled React platform to 100K users...",
    "skillsLanguages": "TypeScript, JavaScript, Python",
    "skillsFrameworks": "React 18, Next.js, Node.js, Tailwind CSS",
    "skillsDatabases": "PostgreSQL, Redis",
    "skillsTools": "Docker, AWS, Vercel, GitHub Actions",
    "projects": "Stripe-style Payment UI\n• Built PCI-compliant payment flow..."
  },
  "keywordsMatched": ["TypeScript", "React 18", "Node.js", "system design"],
  "keywordsMissing": ["mentoring", "WebSockets"],
  "matchScore": 81,
  "creditsUsed": 1,
  "creditsRemaining": 12
}
```

**Errors:**

| Status | Body |
|--------|------|
| `400` | `{ "error": "userId, resumeId, and jobDescription are required" }` |
| `402` | `{ "error": "Insufficient credits" }` |
| `404` | `{ "error": "Resume not found" }` |

---

## 13. POST `/resume/builder/export-pdf`

Server-side PDF export of the populated resume HTML. Returns a PDF binary or a download URL.

**Request:**
```json
{
  "userId": "db-user-uuid",
  "resumeId": "built-resume-uuid",
  "populatedHtml": "<!DOCTYPE html><html>... fully populated ...</html>"
}
```

> Send either `resumeId` (server fetches and generates) **or** `populatedHtml` (client provides pre-rendered HTML).

**Success `200`:**
```json
{
  "downloadUrl": "https://cdn.scribeshade.com/exports/tushar_vaghela_20260504.pdf",
  "expiresAt": "2026-05-05T10:00:00.000Z"
}
```

> Alternatively the endpoint may stream the PDF directly with `Content-Type: application/pdf`.

**Errors:**

| Status | Body |
|--------|------|
| `400` | `{ "error": "resumeId or populatedHtml is required" }` |
| `404` | `{ "error": "Resume not found" }` |

---

## 14. POST `/resume/ats-score` — FREE

Run ATS analysis on an uploaded or built resume.

**Request:**
```json
{
  "resumeId": "resume-uuid",
  "jobDescription": "Optional: paste JD for keyword matching"
}
```

**Success `200`:**
```json
{
  "score": 78,
  "grade": "B+",
  "summary": "Strong technical profile. Improve quantified achievements.",
  "strengths": [
    "Strong backend and frontend skills",
    "Relevant project experience",
    "Education section well-structured"
  ],
  "weaknesses": [
    "Missing quantified achievements in experience",
    "No certifications listed"
  ],
  "missingKeywords": ["microservices", "CI/CD", "AWS"],
  "suggestions": [
    "Add measurable impact metrics (e.g. 'reduced load time by 40%')",
    "Include AWS or cloud certifications",
    "List CI/CD tools in skills section"
  ],
  "sectionScores": {
    "personalInfo": 100,
    "summary": 70,
    "experience": 65,
    "skills": 85,
    "projects": 80,
    "education": 90,
    "certifications": 0
  }
}
```

**Errors:**

| Status | Body |
|--------|------|
| `400` | `{ "error": "resumeId is required" }` |
| `404` | `{ "error": "Resume not found" }` |

---

## 15. GET `/resume/all-ats?userId=<id>`

List all resumes that have ATS analysis results.

**Query params:** `userId` (required)

**Success `200`:**
```json
[
  {
    "id": "resume-uuid",
    "filename": "tushar_vaghela.pdf",
    "atsScore": 78,
    "atsGrade": "B+",
    "analyzedAt": "2026-05-04T10:00:00.000Z"
  }
]
```

---

## 16. POST `/resume/generate-cover-letter`

Generate a cover letter from a resume and job details. Costs **1 credit**.

**Request:**
```json
{
  "resumeId": "resume-uuid-or-built-resume-uuid",
  "jobRole": "Senior Frontend Engineer",
  "company": "Stripe",
  "jobDescription": "We are hiring a Senior Frontend Engineer to lead...",
  "tone": "professional",
  "userName": "Tushar Vaghela",
  "userEmail": "tusharvaghela601@gmail.com"
}
```

**`tone` values:** `"professional"` | `"friendly"` | `"enthusiastic"` | `"formal"`

**Success `200`:**
```json
{
  "coverLetter": "Dear Hiring Manager,\n\nI am writing to express my strong interest in the Senior Frontend Engineer position at Stripe...\n\nSincerely,\nTushar Vaghela",
  "wordCount": 312,
  "creditsUsed": 1,
  "creditsRemaining": 11
}
```

**Errors:**

| Status | Body |
|--------|------|
| `400` | `{ "error": "resumeId, jobRole, company, and jobDescription are required" }` |
| `402` | `{ "error": "Insufficient credits" }` |
| `404` | `{ "error": "Resume not found" }` |

---

## Frontend Integration Notes

### Auto-save flow

```
User types → [2 s debounce] → show "Saving…" → POST /resume/builder/save → show "Saved ✓"
```

The `resumeId` in Redux state starts as `null` for new resumes. On first successful save, store the returned `id` and pass it on all subsequent saves.

### Template code in editor

After the wizard step selects a template, `config.templateCode` (full HTML string) is passed to the editor via `location.state.config`. The editor hydrates it client-side using `populateTemplate()`. Server generation (`/resume/builder/generate`) is only called when the user clicks **Generate Resume** in the wizard or **Regenerate** in the editor.

### Credits deduction

All credit-costing endpoints deduct credits server-side atomically. The frontend should:
1. Refresh `GET /credits/balance` after any credit-costing call
2. Show the `creditsRemaining` value from the response immediately (optimistic update)
3. Disable AI buttons when `balance < requiredCredits`

### Error handling

Always check for `402 Insufficient Credits` before showing AI action results. Display an `<OutOfCreditsDialog>` on 402.

---

## Data Shapes Quick Reference

### `ResumeFields` object

```typescript
interface ResumeFields {
  name: string;             // Personal Info
  role: string;
  email: string;
  phone: string;
  location: string;
  links: string;
  summary: string;          // Summary section
  experience: string;       // Multi-line text block
  skillsLanguages: string;  // Skills (4 sub-fields)
  skillsFrameworks: string;
  skillsDatabases: string;
  skillsTools: string;
  projects: string;         // Multi-line text, blocks separated by \n\n
  education: string;        // Multi-line text, blocks separated by \n\n
  certifications: string;
  publications: string;
}
```

### `SectionDef` object

```typescript
interface SectionDef {
  id: "personalInfo" | "summary" | "experience" | "skills"
    | "projects" | "education" | "certifications" | "publications";
  label: string;
  required: boolean;
  enabled: boolean;
}
```

### Template HTML conventions

Templates use `data-field` and `data-list` attributes:

```html
<!-- Single field -->
<span data-field="name">Your Name</span>
<span data-field="email">email@example.com</span>

<!-- Repeated list -->
<div data-list="projects">
  <div class="proj-item">
    <div data-field="title">Project Title</div>
    <ul data-list="points">
      <li data-field="point">Bullet point</li>
    </ul>
  </div>
</div>
```

Supported `data-field` values: `name`, `role`, `email`, `phone`, `links`, `summary`, `languages`, `frameworks`, `database`, `tools`  
Supported `data-list` values: `projects`, `education`, `points`
