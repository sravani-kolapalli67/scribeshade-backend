Below is a proper PRD for changing the current **ScribeShade Question Bank** into a privacy-safe, role/company/technology-based interview intelligence module.

ScribeShade already has an Interview Intelligence / Q&A concept for searchable company questions and community answers, so this PRD upgrades that existing module instead of creating a separate product area. 

---

# PRD: ScribeShade Question Bank 2.0

## Privacy-Safe Interview Question Intelligence by Company, Role, Technology, and Session Patterns

## 1. Product Goal

Upgrade the current Question Bank from a simple list of user questions / company questions into an **aggregated interview intelligence system**.

Users should be able to discover:

* What questions are being asked for a company.
* What questions are being asked for a job role.
* What technologies are commonly tested.
* How complex the questions are.
* What type of questions appear in real sessions.
* Which topics are repeated across multiple interviews.
* Which questions are valid interview questions versus noise.

The system must protect other users’ session privacy. Users should never see raw sessions, raw transcripts, user identities, emails, resumes, personal answers, private notes, or company-sensitive context.

---

## 2. Current Problem

From the screenshots, the current module has two main views:

1. **All Questions**

   * Shows company names and available question count.
   * Example: Luxoft, Kiser, HNS, etc.

2. **User Questions**

   * Shows individual question rows.
   * Columns include title, industry, language, created date, difficulty.

This is too flat.

The current experience does not clearly answer:

* Which job role were these questions asked for?
* Were the questions from real interview sessions?
* Which technologies were involved?
* Are these questions repeated across users?
* Is the question valid or just transcript noise?
* What was the question complexity?
* What kind of interview round was it?
* Are these questions safe to show publicly?
* Are analytics based on questions only or full private sessions?

---

## 3. Target Experience

The new flow should be:

```text
Question Bank
  ├── Explore
  │     ├── Companies
  │     ├── Job Roles
  │     ├── Technologies
  │     └── Industries
  │
  ├── Company / Role / Technology Detail
  │     ├── Available Sessions Summary
  │     ├── Question List
  │     ├── Topic Analytics
  │     ├── Complexity Analytics
  │     ├── Technology Distribution
  │     └── Interview Pattern Insights
  │
  └── My Questions
        ├── My Saved Questions
        ├── Questions From My Sessions
        └── My Public / Private Contributions
```

Example user journey:

```text
User opens Question Bank
→ searches "Databricks"
→ sees companies, roles, and technologies matching Databricks
→ clicks "Data Engineer - Databricks"
→ sees anonymized valid questions from real sessions
→ sees complexity distribution, topics, technologies, and question types
→ opens a question
→ sees cleaned question, expected answer guide, tags, difficulty, and source confidence
```

---

# 4. Core Requirements

## 4.1 Replace “All Questions” With Explore View

Current “All Questions” should become an intelligence discovery page.

### New Explore page sections

```text
Search bar:
Search by company, role, technology, keyword, topic

Primary tabs:
- Companies
- Job Roles
- Technologies
- Industries
- Recent Trends
```

### Company card / row should show:

```text
Company Name
Available Roles
Total Valid Questions
Top Technologies
Question Complexity Mix
Last Updated
Minimum Privacy Threshold Status
```

Example:

```text
Luxoft
Roles: MERN Developer, Java Backend Engineer, QA Automation
Questions: 24
Top Tech: React, Node.js, MongoDB, System Design
Difficulty: 40% Easy, 45% Medium, 15% Hard
Last Updated: Jun 7, 2026
```

### Job role card / row should show:

```text
Role Name
Companies Seen In
Question Count
Top Technologies
Most Asked Topics
Difficulty Mix
```

Example:

```text
MERN Stack Developer
Companies: Luxoft, HMS, DXC
Questions: 68
Top Tech: React, Node.js, Express, MongoDB
Common Topics: API design, hooks, authentication, deployment
```

### Technology card / row should show:

```text
Technology Name
Related Roles
Related Companies
Question Count
Common Question Types
Difficulty Mix
```

Example:

```text
Databricks
Roles: Data Engineer, PySpark Developer
Companies: Kiser, HNS
Questions: 31
Common Types: Scenario, SQL, Pipeline Design, Optimization
```

---

# 5. Question Source Model

Questions should come from real interview sessions, but only after privacy-safe processing.

## 5.1 Sources

A question can be generated from:

```text
1. User-created manual question
2. AI-detected question from live session transcript
3. AI-extracted question from session notes
4. Admin-imported question
5. Public contributed question
```

## 5.2 Session-derived questions

For session-derived questions, the system must never expose:

```text
- User identity
- Candidate name
- Email
- Phone number
- Resume details
- Personal project names unless explicitly public
- Raw transcript
- Full session notes
- Interviewer name
- Meeting URL
- Exact timestamps
- Private company comments
- Private answer content
- Screen contents
- Documents uploaded by user
```

Only this should be shown:

```text
- Cleaned interview question
- Normalized company name
- Normalized job role
- Industry
- Technologies
- Question type
- Difficulty
- Complexity reason
- Topic tags
- Frequency count
- Aggregated analytics
```

---

# 6. Privacy and Security Requirements

This is the most important part.

## 6.1 Minimum aggregation threshold

Do not show a public company-role-technology group unless it passes a privacy threshold.

Recommended rule:

```text
A question group can become public only if:
- At least 3 different users have contributed similar questions
OR
- At least 5 valid questions exist for the same company-role group
OR
- Admin manually approves the group
```

This prevents one user’s private interview from being exposed directly.

## 6.2 No raw session access

Public Question Bank must never query or return full sessions.

Frontend should never receive:

```text
sessionId
userId
transcriptId
rawTranscript
answerText
sessionNotes
resumeId
documentId
screenCaptureId
```

Use public-safe IDs only:

```text
questionClusterId
companySlug
roleSlug
technologySlug
```

## 6.3 Anonymization layer

Before a question becomes visible, run it through a sanitizer.

Remove or generalize:

```text
"Based on your project at HMS..." 
→ "Based on a previous project..."

"You mentioned ScribeShade uses Clerk..."
→ "In a web application using authentication..."

"Your resume says 2.6 years..."
→ Remove completely

"What did you build at Hiddenmindsolutions?"
→ Reject from public pool or convert only if safe:
   "How would you explain a project you worked on?"
```

## 6.4 Public-safe question fields

Public API should only return:

```ts
type PublicQuestion = {
  id: string;
  title: string;
  normalizedQuestion: string;
  company?: {
    name: string;
    slug: string;
  };
  role?: {
    name: string;
    slug: string;
  };
  industry?: string;
  technologies: string[];
  topics: string[];
  questionType: QuestionType;
  difficulty: "easy" | "medium" | "hard";
  complexityScore: number;
  frequencyCount: number;
  sourceCount: number;
  lastSeenAt: string;
  answerGuideAvailable: boolean;
};
```

Do not include private session fields.

## 6.5 User-owned questions

For “My Questions”, the user can see their own session-derived questions with more context, but still not raw transcript by default.

They can see:

```text
- Question
- Their saved answer
- Session date
- Company
- Role
- Tags
- Difficulty
- Whether public contribution is enabled
```

They should not automatically publish anything.

---

# 7. Noise Filtering

The system must remove non-useful transcript content.

## 7.1 Noise examples to remove

```text
Tell me about yourself.
Can you hear me?
Are you there?
Please turn on your camera.
Share your screen.
What is your notice period?
What is your expected salary?
Where are you located?
Are you comfortable relocating?
Can you confirm your email?
Let's wait for the panel.
Do you have any questions for us?
This interview is being recorded.
Please introduce yourself briefly.
```

Not all HR questions are useless, but they should not pollute technical intelligence.

## 7.2 Classification

Each detected question should be classified as:

```ts
type QuestionVisibilityClass =
  | "valid_interview_question"
  | "low_value_hr_question"
  | "privacy_sensitive_question"
  | "transcript_noise"
  | "duplicate"
  | "unsafe_to_publish";
```

Only `valid_interview_question` should appear in public Explore views.

## 7.3 Valid question examples

```text
Explain event loop in Node.js.
How would you design authentication in a MERN app?
What is the difference between useMemo and useCallback?
How do you optimize a slow MongoDB query?
Design an architecture for a real-time chat app.
How would you handle schema evolution in Databricks?
Explain partitioning in Spark.
Write a function to find the pivot index.
```

---

# 8. Question Types

Every valid question should have a type.

Recommended enum:

```ts
type QuestionType =
  | "coding"
  | "dsa"
  | "system_design"
  | "architecture"
  | "technical_concept"
  | "scenario_based"
  | "debugging"
  | "database"
  | "cloud_devops"
  | "behavioral"
  | "project_deep_dive"
  | "case_study"
  | "sql"
  | "frontend"
  | "backend"
  | "data_engineering"
  | "security"
  | "testing";
```

Important: `project_deep_dive` should be public only when generalized. Candidate-specific project questions should remain private.

---

# 9. Complexity and Analytics

## 9.1 Difficulty

Use:

```text
Easy
Medium
Hard
Expert
```

Difficulty should be based on:

```text
- Required depth
- Number of concepts involved
- Whether code/design is required
- Whether trade-offs are expected
- Whether production-scale thinking is needed
- Whether system design or optimization is involved
```

## 9.2 Complexity score

Store numeric complexity:

```text
0–25: Easy
26–55: Medium
56–80: Hard
81–100: Expert
```

## 9.3 Analytics shown to user

For each company / role / technology page, show:

```text
Total valid questions
Unique topics
Most asked technologies
Difficulty distribution
Question type distribution
Recent question trends
Most repeated questions
Round pattern estimate
```

Example:

```text
MERN Developer at Luxoft

Valid Questions: 24
Top Topics:
- React Hooks
- Node.js APIs
- MongoDB Aggregation
- Authentication
- System Design

Difficulty:
- Easy: 25%
- Medium: 55%
- Hard: 20%

Question Types:
- Technical Concept: 35%
- Coding: 25%
- Scenario: 20%
- System Design: 15%
- Debugging: 5%
```

## 9.4 Session-level analytics without exposing sessions

Do not show full session.

Show aggregated pattern only:

```text
Based on anonymized sessions, candidates commonly faced:
- 1 intro/HR round question
- 3–5 technical concept questions
- 1 coding question
- 1 architecture or system design question
```

Avoid:

```text
User X was asked this on Jun 7 at 8:31 PM.
```

---

# 10. Backend Data Model

## 10.1 New / updated tables

### `QuestionBankQuestion`

```ts
QuestionBankQuestion {
  id: string;
  normalizedQuestion: string;
  displayTitle: string;
  canonicalHash: string;

  companyId?: string;
  roleId?: string;
  industry?: string;

  questionType: QuestionType;
  difficulty: Difficulty;
  complexityScore: number;

  technologies: string[];
  topics: string[];

  visibility: "private" | "public_candidate" | "public_aggregated" | "admin_hidden";
  visibilityClass: QuestionVisibilityClass;

  sourceType: "manual" | "session_extracted" | "admin_imported" | "public_contribution";

  frequencyCount: number;
  sourceCount: number;
  contributorCount: number;

  lastSeenAt: Date;
  createdAt: Date;
  updatedAt: Date;
}
```

### `QuestionBankCompany`

```ts
QuestionBankCompany {
  id: string;
  name: string;
  slug: string;
  aliases: string[];
  industry?: string;
  normalizedName: string;
  createdAt: Date;
  updatedAt: Date;
}
```

### `QuestionBankRole`

```ts
QuestionBankRole {
  id: string;
  name: string;
  slug: string;
  normalizedName: string;
  seniority?: string;
  category?: string;
  createdAt: Date;
  updatedAt: Date;
}
```

### `QuestionBankTechnology`

```ts
QuestionBankTechnology {
  id: string;
  name: string;
  slug: string;
  aliases: string[];
  category: string;
}
```

### `QuestionBankCluster`

Used to group duplicate or similar questions.

```ts
QuestionBankCluster {
  id: string;
  canonicalQuestion: string;
  canonicalHash: string;
  embeddingVectorId?: string;

  companyId?: string;
  roleId?: string;

  technologies: string[];
  topics: string[];

  frequencyCount: number;
  contributorCount: number;
  sourceSessionCount: number;

  publicEligible: boolean;
  publicReason?: string;

  createdAt: Date;
  updatedAt: Date;
}
```

### `QuestionBankSource`

Private mapping table. Never exposed to frontend.

```ts
QuestionBankSource {
  id: string;
  questionId: string;
  clusterId?: string;

  sourceUserId?: string;
  sourceSessionId?: string;
  sourceTranscriptSegmentId?: string;

  extractionConfidence: number;
  sanitizerVersion: string;

  createdAt: Date;
}
```

Important: this table is backend-only.

---

# 11. API Requirements

## 11.1 Explore companies

```http
GET /api/question-bank/explore/companies
```

Query params:

```text
q
industry
technology
role
difficulty
minQuestions
sort
page
limit
```

Response:

```ts
{
  companies: Array<{
    id: string;
    name: string;
    slug: string;
    industry?: string;
    availableRoles: number;
    validQuestions: number;
    topTechnologies: string[];
    difficultyMix: {
      easy: number;
      medium: number;
      hard: number;
      expert: number;
    };
    lastUpdatedAt: string;
  }>;
  pagination: Pagination;
}
```

## 11.2 Explore roles

```http
GET /api/question-bank/explore/roles
```

## 11.3 Explore technologies

```http
GET /api/question-bank/explore/technologies
```

## 11.4 Company detail

```http
GET /api/question-bank/companies/:companySlug
```

Returns:

```ts
{
  company: PublicCompany;
  roles: PublicRoleSummary[];
  topTechnologies: string[];
  analytics: QuestionBankAnalytics;
}
```

## 11.5 Role questions

```http
GET /api/question-bank/questions
```

Query params:

```text
company
role
technology
industry
questionType
difficulty
q
page
limit
```

Response:

```ts
{
  questions: PublicQuestion[];
  analytics: QuestionBankAnalytics;
  pagination: Pagination;
}
```

## 11.6 Question detail

```http
GET /api/question-bank/questions/:questionId
```

Response:

```ts
{
  question: PublicQuestion;
  similarQuestions: PublicQuestion[];
  answerGuide?: {
    approach: string[];
    keyPoints: string[];
    commonMistakes: string[];
  };
}
```

Do not return source sessions.

## 11.7 My questions

```http
GET /api/question-bank/my/questions
```

Returns only the authenticated user’s own questions.

---

# 12. Frontend Requirements

## 12.1 Sidebar

Current sidebar can remain:

```text
Question Bank
  - Explore
  - Companies
  - Roles
  - Technologies
  - My Questions
```

Or simpler:

```text
Question Bank
  - Explore
  - My Questions
```

## 12.2 Explore page layout

Top filters:

```text
Search
Company
Job Role
Technology
Industry
Question Type
Difficulty
Date Range
```

View toggle:

```text
Cards / Table
```

Table columns for company view:

```text
Company
Roles
Questions
Top Technologies
Difficulty
Last Updated
```

Table columns for role view:

```text
Role
Companies
Questions
Top Technologies
Question Types
Difficulty
```

Table columns for technology view:

```text
Technology
Roles
Companies
Questions
Common Types
Difficulty
```

## 12.3 Detail page

Example route:

```text
/questions/company/luxoft
/questions/company/luxoft/role/mern-developer
/questions/technology/databricks
```

Page sections:

```text
Header
Analytics cards
Filters
Question list
Topic distribution
Difficulty distribution
Question type distribution
```

## 12.4 Question detail drawer

Clicking a question opens a drawer/modal.

Show:

```text
Question
Difficulty
Type
Topics
Technologies
How to answer
Key points
Common mistakes
Similar questions
```

Do not show:

```text
Source session
User
Raw transcript
Candidate answer
Private notes
```

---

# 13. Admin / Moderation Requirements

Admin needs a moderation queue.

## 13.1 Moderation states

```ts
type ModerationStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "needs_review"
  | "auto_approved";
```

## 13.2 Admin queue should show

```text
Extracted question
Original sanitized version
Detected company
Detected role
Detected technologies
Detected type
Difficulty
Privacy risk score
Duplicate cluster
Recommended action
```

## 13.3 Admin actions

```text
Approve
Reject
Merge duplicate
Edit normalized question
Change company
Change role
Change technology tags
Mark privacy sensitive
Hide cluster
```

---

# 14. AI Processing Pipeline

## 14.1 On session end

When a session ends:

```text
1. Extract candidate-safe interview questions from transcript.
2. Remove noise.
3. Classify question type.
4. Detect company, role, industry, technologies.
5. Score difficulty and complexity.
6. Sanitize private context.
7. Deduplicate against existing clusters.
8. Store private source mapping.
9. If privacy threshold passes, mark public_aggregated.
10. Otherwise keep private or pending.
```

## 14.2 AI extraction output contract

```ts
type ExtractedInterviewQuestion = {
  rawDetectedQuestion: string;
  normalizedQuestion: string;
  visibilityClass: QuestionVisibilityClass;
  privacyRisk: "low" | "medium" | "high";
  questionType: QuestionType;
  difficulty: Difficulty;
  complexityScore: number;
  technologies: string[];
  topics: string[];
  industry?: string;
  roleGuess?: string;
  companyGuess?: string;
  confidence: number;
  rejectReason?: string;
};
```

## 14.3 Hard reject rules

Reject from public pool if:

```text
- Contains candidate name
- Contains email, phone, address, LinkedIn, GitHub
- Mentions exact resume company/project in a personal way
- Contains salary, notice period, relocation, personal eligibility
- Contains interviewer identity
- Contains raw screen/document content
- Is not actually a question
- Is only meeting noise
```

---

# 15. Search Requirements

Search should support:

```text
Company name
Company alias
Job role
Technology
Topic
Question keyword
Question type
Industry
Difficulty
```

Examples:

```text
databricks
react
mern developer
luxoft node.js
system design ecommerce
mongodb aggregation
data engineer spark
```

Search ranking should prioritize:

```text
1. Exact company / role / technology match
2. High-frequency questions
3. Recently seen questions
4. Higher confidence extracted questions
5. Admin-approved questions
```

---

# 16. Edge Cases

## 16.1 Company has 0 valid questions

Show company but disable detail or show:

```text
No public-safe interview questions available yet.
```

Do not show raw session count if it reveals private activity.

## 16.2 Company name typo

Normalize aliases:

```text
HMS
Hiddenmindsolutions
Hidden Mind Solutions
Hiddenmind solution
```

All can map to one company.

## 16.3 Role name variation

Normalize:

```text
MERN Stack Developer
MERN Developer
Full Stack Developer - MERN
React Node Developer
```

But keep enough distinction where needed.

## 16.4 One user contributed all questions

Do not publish publicly unless admin-approved.

Reason:

```text
Privacy threshold not met.
```

## 16.5 Question contains user project

Example:

```text
Explain the ScribeShade architecture you built.
```

Public version should either be rejected or generalized:

```text
Explain the architecture of a real-time interview assistant application.
```

## 16.6 Same question asked across many companies

Allow global question cluster.

Example:

```text
What is the difference between useMemo and useCallback?
```

This can appear under React, Frontend, MERN, and multiple companies.

## 16.7 User deletes account

Their private source mappings must be deleted or anonymized.

Public aggregated questions can remain only if they no longer depend on that user for threshold.

## 16.8 User deletes session

Remove source mapping from that session.

Recompute:

```text
frequencyCount
sourceCount
contributorCount
public eligibility
analytics
```

## 16.9 Private company interview

If user marks session private or company sensitive, do not contribute to public question bank.

## 16.10 Low-confidence extraction

Keep in moderation queue. Do not publish.

## 16.11 Very rare question

Keep private or hidden until enough aggregation exists.

## 16.12 Question is behavioral

Behavioral questions can exist, but should be separated from technical intelligence.

Example:

```text
Tell me about a time you handled conflict.
```

Valid but not technical. Mark as `behavioral`.

## 16.13 Intro question

Usually noise for this module.

```text
Tell me about yourself.
```

Hide from public analytics unless you create a separate HR section.

---

# 17. Permissions

## Public authenticated user can:

```text
- Browse public aggregated question bank
- Search companies, roles, technologies
- View public-safe question detail
- View analytics
- View own questions
- Save/bookmark questions
```

## User cannot:

```text
- See another user’s session
- See another user’s transcript
- See another user’s answer
- See source user count below threshold
- Access private source IDs
```

## Admin can:

```text
- Review extracted questions
- Approve/reject
- Merge clusters
- Hide unsafe questions
- Manage company/role/technology taxonomy
```

---

# 18. Implementation Plan

## Phase 1: Data model and backend safety

* Add question bank tables.
* Add public DTOs.
* Add backend-only source mapping.
* Add privacy-safe query layer.
* Ensure public APIs never return session/user/transcript IDs.

## Phase 2: Session extraction pipeline

* On session end, extract questions.
* Add noise filtering.
* Add classification.
* Add difficulty scoring.
* Add sanitizer.
* Add deduplication hash.

## Phase 3: Explore UI

* Replace current All Questions table with Explore.
* Add tabs for Companies, Roles, Technologies.
* Add search and filters.
* Add analytics cards.

## Phase 4: Detail pages

* Company detail page.
* Role detail page.
* Technology detail page.
* Question drawer.

## Phase 5: My Questions

* Show user-owned questions.
* Let user mark question private/public contribution.
* Let user save/bookmark public questions.

## Phase 6: Admin moderation

* Add moderation queue.
* Add approval/rejection flow.
* Add cluster merge.
* Add privacy risk review.

---

# 19. Acceptance Criteria

## Functional

* User can search by company, role, technology, and keyword.
* User can open a company and see available roles.
* User can open a role and see valid questions.
* User can filter by difficulty, type, technology, and industry.
* User can see analytics based only on valid questions.
* User can open a question and see an answer guide.
* User can view their own questions separately.

## Privacy

* Public APIs never expose another user’s session ID, transcript, answer, resume, email, or documents.
* Questions from one user are not publicly visible unless aggregation/admin approval allows it.
* Candidate-specific project/resume questions are rejected or generalized.
* Deleted sessions are removed from source mappings and analytics.
* Private sessions never contribute to public question bank.

## Quality

* Noise questions are removed.
* Duplicate questions are clustered.
* Company and role names are normalized.
* Technologies are tagged consistently.
* Analytics are based only on valid public-safe questions.

---

# 20. Serious Product Notes

The main risk is not UI. The main risk is **privacy leakage**.

Do not build this by simply showing questions extracted from other users’ sessions. That would be dangerous. The correct architecture is:

```text
Private Session Data
      ↓
Question Extraction
      ↓
Sanitization
      ↓
Noise Filtering
      ↓
Deduplication / Clustering
      ↓
Aggregation Threshold
      ↓
Public Question Bank
```

The public Question Bank should behave like anonymized market intelligence, not like a shared transcript viewer.

Also, do not call them “secret session questions” in the UI. Internally you can think of them that way, but externally use safer language:

```text
Real Interview Questions
Anonymized Interview Questions
Community Interview Insights
Role-Based Question Trends
Company Interview Patterns
```

Recommended final module naming:

```text
Question Bank
  - Explore
  - Companies
  - Roles
  - Technologies
  - My Questions
```

This gives users the value you want while keeping other users’ interview data protected.
