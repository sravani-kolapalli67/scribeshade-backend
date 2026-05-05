# AI Project Generation — Feature Rollout Plan

## Overview

| Field | Details |
|-------|---------|
| Feature | AI Project Generation Engine |
| Priority | Medium |
| Version | v1.0 |
| Inputs | Resume skills, Job Description, Role type |
| Outputs | Full project narrative, Diagram block, 30-sec summary |

---

## Roles & Responsibilities

| Role | Responsibility |
|------|---------------|
| Product Manager | Define scope, acceptance criteria, prioritization |
| Backend Developer | AI prompt engineering, API endpoint, caching logic |
| Frontend Developer | Tree node UI, editor integration, expand/collapse nodes |
| AI/LLM Engineer | Model selection, prompt tuning, hallucination guard |
| QA Engineer | Test edge cases, skill mismatch, credibility warnings |
| UI/UX Designer | Tree node wireframes, STAR layout, 30-sec summary card |

---

## Phase 1 — Foundation (Week 1–2)

### Backend Developer
- [ ] Create `/api/ai/project-generation` POST endpoint
- [ ] Define request schema:
  ```json
  {
    "resume_skills": ["React", "Node.js", "PostgreSQL"],
    "jd_text": "...",
    "role_type": "Full Stack Developer",
    "experience_level": "mid"
  }
  ```
- [ ] Integrate with OpenRouter → Gemini 1.5 Pro
- [ ] Implement skill extraction parser from resume `parsed_data` JSON
- [ ] Log to `credit_usage` table (4 credits per generation)

### AI/LLM Engineer
- [ ] Design master prompt template covering:
  - STAR format (Situation, Task, Action, Result)
  - Specific tech stack injection
  - Measurable outcomes (performance %, scale numbers)
  - Human-like, non-generic language
- [ ] Add hallucination guard — detect unrealistic claims
- [ ] Add skill mismatch detection — limit scope to existing stack
- [ ] Test prompt with 5+ role types (Frontend, Backend, DevOps, Data, Full Stack)

### UI/UX Designer
- [ ] Wireframe the Project Generation modal (3 input fields)
- [ ] Design tree node component (expand/collapse)
- [ ] Design STAR story card layout
- [ ] Design 30-second summary card
- [ ] Design credibility warning banner

---

## Phase 2 — Core Feature Build (Week 3–4)

### Backend Developer
- [ ] Build predefined project category engine (FR-PROJ-06):
  ```
  Categories: Web App, API Service, Data Pipeline,
  Mobile App, DevOps/Infrastructure, ML Model, CLI Tool
  ```
- [ ] Implement output schema:
  ```json
  {
    "project_title": "...",
    "narrative": "...",
    "star_story": {
      "situation": "...",
      "task": "...",
      "action": "...",
      "result": "..."
    },
    "architecture": {
      "frontend": "...",
      "backend": "...",
      "database": "...",
      "infrastructure": "..."
    },
    "ascii_diagram": "...",
    "thirty_sec_summary": "...",
    "memory_hooks": ["...", "..."],
    "credibility_score": 0-100
  }
  ```
- [ ] Store generated project in `resumes.parsed_data` under `projects[]`

### Frontend Developer
- [ ] Build Project Generation trigger button inside Resume Editor
- [ ] Build input modal (resume skills auto-filled, JD + role inputs)
- [ ] Build **Tree Node View** component:
  ```
  Project Name
  ├── Frontend → React, Tailwind
  ├── Backend  → Node.js, Express
  ├── Database → PostgreSQL
  └── Infra    → Docker, Vercel
  ```
- [ ] Implement expand/collapse per node (FR-PROJ-10)
- [ ] Render ASCII diagram in monospace block
- [ ] Build STAR story card (4 labeled sections)
- [ ] Build 30-second summary card with copy button

### AI/LLM Engineer
- [ ] Fine-tune prompt for ASCII diagram generation:
  ```
  [Frontend: React] → [Backend: Express API] → [DB: PostgreSQL]
                                ↓
                       [Cache: Redis]
  ```
- [ ] Implement memory hooks generator (short memorable phrases per architecture decision)
- [ ] Add FR-PROJ-07 logic — generate projects partially independent of resume/JD
  (use role-type defaults when inputs are sparse)

---

## Phase 3 — Exception Handling & Guards (Week 5)

### Backend Developer
- [ ] **Skill Mismatch Handler:**
  - Compare requested tech stack against `metadata_index.skills`
  - If mismatch > 40% → auto-limit project scope to known skills
  - Return `scope_limited: true` flag in response
- [ ] **Credibility Warning System:**
  - Detect unrealistic claims (e.g., "handled 10M users" for fresher)
  - Return `credibility_warning: true` + `warning_message` in response
- [ ] Add input validation — minimum 2 skills required to generate

### Frontend Developer
- [ ] Show **Credibility Warning Banner** (yellow) when `credibility_warning: true`:
  > ⚠️ "Some outcomes may seem ambitious for your experience level. Review before adding."
- [ ] Show **Scope Limited Notice** (blue) when `scope_limited: true`:
  > ℹ️ "Project scope adjusted to match your current skill set."
- [ ] Disable generate button with tooltip if fewer than 2 skills detected

### QA Engineer
- [ ] Write test cases for:
  - Fresher with minimal skills → scope limiting
  - Senior with full stack → full project generation
  - Empty JD input → role-type defaults kick in
  - Unrealistic outcome detection (e.g., "reduced latency by 1000%")
  - Tree node expand/collapse functionality
  - Credit deduction (4 credits) accuracy

---

## Phase 4 — Integration & Polish (Week 6)

### Frontend Developer
- [ ] Integrate generated project into Resume Editor with **Apply / Discard** buttons
- [ ] Add project to left panel Section Navigator after apply
- [ ] Lock generated `project_name` and `project_dates` fields post-apply (locked field rule)
- [ ] Add "Regenerate" option (costs 4 more credits, not cached)

### Backend Developer
- [ ] Add predefined categories dropdown API:
  `GET /api/project-categories?role_type=fullstack`
- [ ] Implement rate limiting — max 5 generations per session

### AI/LLM Engineer
- [ ] A/B test two prompt variants for naturalness
- [ ] Evaluate output across 10 role types
- [ ] Document final prompt template in internal wiki

### Product Manager
- [ ] Define acceptance criteria sign-off checklist
- [ ] Conduct internal demo with stakeholders
- [ ] Collect beta user feedback (5 testers minimum)

---

## API Contract

### Request
```http
POST /api/ai/project-generation
Authorization: Bearer <token>
Content-Type: application/json

{
  "resume_id": "uuid",
  "role_type": "Full Stack Developer",
  "jd_text": "optional JD paste",
  "experience_level": "mid"
}
```

### Response
```json
{
  "project_title": "Real-Time Order Tracking Dashboard",
  "narrative": "Built a full-stack order tracking system...",
  "star_story": {
    "situation": "E-commerce client needed real-time visibility...",
    "task": "Design and build a tracking dashboard from scratch...",
    "action": "Developed using React frontend, Node.js API, PostgreSQL...",
    "result": "Reduced support tickets by 35% within 2 months..."
  },
  "architecture": {
    "frontend": "React, Tailwind CSS",
    "backend": "Node.js, Express",
    "database": "PostgreSQL",
    "infrastructure": "Docker, Vercel"
  },
  "ascii_diagram": "[React UI] → [Express API] → [PostgreSQL]\n                    ↓\n              [Redis Cache]",
  "thirty_sec_summary": "Built a real-time order dashboard using React and Node.js...",
  "memory_hooks": ["REST over WebSocket for simplicity", "Redis as the speed layer"],
  "credibility_score": 82,
  "credibility_warning": false,
  "scope_limited": false,
  "credits_consumed": 4
}
```

---

## Exception Handling Matrix

| Exception | Trigger | System Response | UI Display |
|-----------|---------|-----------------|------------|
| Skill Mismatch | >40% tech stack not in resume | Limit to known skills, `scope_limited: true` | Blue info banner |
| Unrealistic Claims | Outcome % too high for experience | `credibility_warning: true` + message | Yellow warning banner |
| Insufficient Skills | <2 skills detected | Block generation | Disabled button + tooltip |
| Empty JD & Role | Both inputs missing | Use role-type category defaults | Silent fallback |
| AI Model Failure | OpenRouter timeout/error | Retry once, then 503 response | Toast error message |

---

## Functional Requirements Checklist

| FR ID | Requirement | Phase | Status |
|-------|------------|-------|--------|
| FR-PROJ-01 | Generate realistic projects aligned with skills | Phase 1 | 🔲 |
| FR-PROJ-02 | Include architecture breakdown | Phase 2 | 🔲 |
| FR-PROJ-03 | Include STAR format | Phase 2 | 🔲 |
| FR-PROJ-04 | Generate ASCII diagrams | Phase 2 | 🔲 |
| FR-PROJ-05 | Generate memory hooks | Phase 2 | 🔲 |
| FR-PROJ-06 | Predefined project categories by industry role | Phase 2 | 🔲 |
| FR-PROJ-07 | Projects not fully dependent on resume/JD | Phase 2 | 🔲 |
| FR-PROJ-08 | Tree node structure for project components | Phase 2 | 🔲 |
| FR-PROJ-09 | Tree displays Frontend→Backend→DB→Infra layers | Phase 2 | 🔲 |
| FR-PROJ-10 | Expand/collapse nodes | Phase 2 | 🔲 |

---

## Timeline Summary

| Phase | Duration | Owner |
|-------|----------|-------|
| Phase 1 — Foundation | Week 1–2 | Backend + AI/LLM Engineer |
| Phase 2 — Core Build | Week 3–4 | All Roles |
| Phase 3 — Guards & Edge Cases | Week 5 | Backend + Frontend + QA |
| Phase 4 — Integration & Polish | Week 6 | All Roles |
| **Total** | **6 Weeks** | |
```