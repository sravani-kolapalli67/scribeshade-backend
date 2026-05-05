# CraftVita
## Product Requirement Document (PRD) v1.0
*AI-Powered Resume Builder for Global Job Seekers*

- Product Vision & Strategy
- Complete Feature Specification
- AI/LLM Architecture & Model Selection
- User Application Flow (Every Screen)
- Admin Dashboard Specification
- Database Schema & API Design
- Security, Compliance & Launch Roadmap

---

**Date:** April 4, 2026
**Prepared for:** Sravani Kolapalli, Founder
**Prepared by:** Perplexity Computer
**Version:** 1.0 | Development Edition

---

## TABLE OF CONTENTS

### Section 1: Product Overview
Vision, Target Users, Markets, Business Model, Competitive Positioning

### Section 2: Complete Feature Specification
27 Features, Detailed Specs, Free Operations

### Section 3: AI/LLM Architecture
Model Routing, Caching, Prompt Engineering, Cost Analysis

### Section 4: User Application Flow
Screen Map, Editor Layout, Section Details

### Section 5: Admin Dashboard Specification
Admin Screens, KPIs, API Tracking, Dynamic Pricing Control

### Section 6: Database Schema
10 Tables, Key Functions, Row Level Security

### Section 7: API Design
Endpoints, Request Formats, Authentication

### Section 8: Technology Stack
Frontend, Backend, AI, Payments, Infrastructure

### Section 9: Security & Compliance
Encryption, RLS, Payments, GDPR, DPDPA

### Section 10: Launch Roadmap
6-Phase Timeline from MVP to Global

### Section 11: Executive Summary
Key Numbers & Final Overview

### Appendix A
Risks, Assumptions & Success Metrics

---

## SECTION 1: PRODUCT OVERVIEW

### 1.1 Vision Statement

> **CraftVita** is an AI-powered resume intelligence platform that helps job seekers build, optimize, and tailor ATS-ready resumes through section-by-section AI editing, JD-specific customization, and intelligent skill gap analysis — all through a pay-as-you-go credit model with no subscription traps.

### 1.2 Target Users

| Segment | Users | Description |
|---------|-------|-------------|
| Primary | Job seekers in India | Freshers, experienced professionals, career changers targeting Indian and global companies |
| Secondary | Job seekers in US & UK | Professionals seeking ATS-optimized resumes for competitive Western markets |
| Tertiary | Agencies & coaches | Recruitment agencies, career coaches needing bulk resume optimization |

### 1.3 Target Markets

| Market | Share | Currency | Payment Gateway |
|--------|-------|----------|-----------------|
| India (Primary) | 65% | INR | Razorpay (UPI, cards, netbanking) |
| United States | 25% | USD | Stripe (cards, Apple Pay, Google Pay) |
| United Kingdom | 10% | GBP | Stripe |

### 1.4 Business Model

- **Pure credit-based, no subscriptions** — users are transient job seekers, not retained subscribers.
- **Every transaction must be profitable on its own** — no LTV assumptions.
- **Free ATS scoring as loss leader** — drives organic traffic (users search "free ATS checker").
- **3 free credits on signup** — lets users experience the product before purchasing.

### 1.5 Competitive Positioning

| Feature | CraftVita | Kickresume | Teal | Rezi | Resume.io |
|---------|-----------|------------|------|------|-----------|
| Pricing Model | Pay-as-you-go credits | Monthly sub | Freemium + paid | Monthly sub | Monthly sub |
| Section-by-Section AI Edit | Yes (locked fields) | No | No | No | No |
| JD Tailoring | Yes + free regen (cached) | Basic | Yes (limited) | Yes | No |
| AI Project Generation | Yes (humanized) | No | No | No | No |
| Skill Gap Analysis | Yes (JD-specific) | No | Partial | No | No |
| Free ATS Score | Yes (unlimited) | Limited | Yes | Yes | No |

---

## SECTION 2: COMPLETE FEATURE SPECIFICATION

### 2.1 Feature Matrix (27 Features)

| # | Feature | Description | Credits | AI Model | Status |
|---|---------|-------------|---------|----------|--------|
| 1 | Resume Upload & Parse | Upload PDF/DOCX/TXT, AI parses into structured sections | 2 | Gemini 1.5 Flash | Built |
| 2 | Start From Scratch | Create blank resume, fill sections manually | 0 | None | Built |
| 3 | Section-by-Section Editor | Edit each resume section independently | 0 | None | Built |
| 4 | Locked Fields | Company names, job titles, dates — AI NEVER modifies these | 0 | None | Built |
| 5 | AI Section Edit | AI improves a single section | 1 | Gemini 1.5 Flash | Built |
| 6 | Full Resume Rewrite | AI rewrites entire resume for target role | 5 | Gemini 1.5 Pro | Built |
| 7 | JD Tailoring (first time) | Paste JD, AI identifies gaps, suggests changes, match score | 4 | Gemini 1.5 Pro | Built |
| 8 | JD Tailoring (regen) | Same JD — served from cache, instant | FREE | Cache | Built |
| 9 | Skill Injection | AI suggests role-aware skills based on JD | 1 | Gemini 1.5 Flash | Built |
| 10 | Bulk Keyword Inject | AI injects missing JD keywords throughout resume | 2 | Gemini 1.5 Flash | Built |
| 11 | Bullet Enhancement | AI improves bullets with metrics and action verbs | 1 | Gemini 1.5 Flash | Built |
| 12 | AI Project Generation | AI generates realistic, humanized project descriptions | 4 | Gemini 1.5 Pro | Built |
| 13 | Cover Letter Generation | AI generates tailored cover letter matching resume + JD | 3 | Gemini 1.5 Flash | Built |
| 14 | ATS Score & Report | Instant ATS compatibility score (0-100) with breakdown | FREE | Gemini 1.5 Flash | Built |
| 15 | Keyword Highlighting | Visual overlay showing JD keywords present/missing | FREE | Local algorithm | Built |
| 16 | Template System | Professional ATS-optimized templates | FREE/1 | None | Built |
| 17 | Live Preview | Real-time preview of resume as you edit | FREE | None | Built |
| 18 | Auto-Save | Automatic save after 2 seconds of inactivity | FREE | None | Built |
| 19 | Version History | Restore previous versions of resume | FREE | None | Built |
| 20 | Cloud Storage | All resumes stored securely in the cloud | FREE | None | Built |
| 21 | PDF Download | Download resume as ATS-optimized PDF | FREE | None | Built |
| 22 | Credit Store | Browse and purchase credit packs | N/A | N/A | Built |
| 23 | Credit History | View purchase and usage history | FREE | None | Built |
| 24 | Promo Codes | Apply discount codes for bonus credits | N/A | N/A | Built |
| 25 | Low Credit Warning | Banner when credits are less than 5 | N/A | N/A | Built |
| 26 | Google OAuth Login | Sign in with Google account | N/A | N/A | Built |
| 27 | Email/Password Login | Sign in with email and password | N/A | N/A | Built |

> *Note: "FREE" operations consume no credits. "N/A" features are infrastructure/UI with no AI cost.*

---

### 2.2 Locked Fields Specification

Locked fields are protected from AI modification. They appear with a lock icon and gray background in the editor. This prevents AI from altering factual data like company names, employment dates, or degree information.

#### LOCKED (AI Never Modifies)
Company names, Client names, Job titles, Employment dates (start/end), Institution names, Degrees, Education dates, GPA, Certification issuing bodies, Certification dates, Project names, Project clients, Project dates.

#### EDITABLE (AI Can Improve)
Professional summary, Bullet points, Skill categories & individual skills, Project descriptions/tech stack/outcomes, Coursework, Honors, Tools & environments, Certification descriptions.

---

### 2.3 JD Tailoring with Caching

The JD tailoring feature uses an intelligent caching layer to eliminate redundant LLM calls:

- User pastes Job Description text into the JD Tailor panel
- System generates a hash of the JD text using a fast hashing function
- Checks `jd_cache` table for existing result with matching (user_id, resume_id, jd_hash)
- Cache HIT: returns stored result instantly — **0 credits consumed**
- Cache MISS: calls Gemini 1.5 Pro to analyze gaps between resume metadata and JD keywords
- AI generates match score (0-100), missing keywords, and section-specific suggestions
- Result stored in cache for future regeneration requests
- Regeneration of same JD is **always free** — served from cache

---

### 2.4 AI Project Generation

> **Key requirement:** Generated projects must NOT sound machine-generated. They must be realistic, believable, use specific tech stacks, include measurable outcomes, and read like real project descriptions written by a human engineer.

---

### 2.5 Free Operations (Loss Leaders)

The following operations are permanently free to drive user acquisition and engagement:

| Operation | Purpose | Strategy |
|-----------|---------|----------|
| ATS Score | Instant resume scoring | SEO-driven acquisition ("free ATS checker" = 110K+ monthly searches) |
| Keyword Highlighting | Visual JD keyword overlay | Encourages JD tailoring (paid) |
| PDF Download | Export resume as PDF | Core utility — must be free |
| Cloud Storage | Save resumes in cloud | Retention — users return for stored data |
| Template Switching | Browse templates | Free to browse, 1 credit to apply |
| JD Regen (cached) | Repeat JD analysis | Already computed — zero marginal cost |

---

## SECTION 3: AI/LLM ARCHITECTURE

### 3.1 LLM Routing

| Task Tier | Model | Used For | Cost / 1M Input Tokens |
|-----------|-------|----------|------------------------|
| Heavy (Pro) | Gemini 1.5 Pro | Full rewrites, Project generation, JD tailoring | ~$1.25 |
| Medium (Flash) | Gemini 1.5 Flash | Parsing, Section edits, Cover letters, Skill injection | ~$0.075 |
| Light (Lite) | Gemini 1.5 Flash | ATS scoring, Bullet enhancement, Template formatting | ~$0.075 |

### 3.2 Future Model Roadmap

| Task | Preferred Model | Fallback |
|------|----------------|----------|
| Content Generation | Claude Sonnet 4 | Gemini 2.5 Pro |
| Structured Parsing | GPT-4o | Gemini 2.0 Flash |
| Cheap Operations | Gemini 2.0 Flash-Lite | DeepSeek V3.2 |
| Cover Letters | DeepSeek V3.2 | Gemini 1.5 Flash |
| Gateway | OpenRouter | Direct API calls |

### 3.3 Metadata Index & Caching Architecture

The caching architecture reduces AI costs by 35-48% across JD tailoring operations:

- **Step 1:** On first upload, parse creates structured JSON + metadata index
- **Step 2:** Metadata index contains: all skills (categorized + experience level), locked fields list, editable blocks, industry keywords
- **Step 3:** JD tailoring compares cached metadata against JD keywords (cheap/local operation)
- **Step 4:** Only GAPS trigger the expensive Pro model call
- **Step 5:** Result cached per user + resume + JD hash
- **Step 6:** Subsequent same JD: 100% cache hit, zero LLM cost
- **Impact:** 56-74% cost reduction on JD tailoring, 100% reduction on regeneration

### 3.4 Cost Per Operation (With Caching)

| Operation | Credits | Model | Est. LLM Cost | With Caching |
|-----------|---------|-------|---------------|--------------|
| Parse + Index | 2 | Flash | $0.020 | N/A (one-time) |
| Section Edit | 1 | Flash | $0.0005 | Similar |
| Full Rewrite | 5 | Pro | $0.035 | Slightly less (locked fields excluded) |
| JD Tailor (first) | 4 | Pro | $0.015-0.025 | Targeted gaps only |
| JD Tailor (regen) | FREE | Cache | $0.000 | 100% cached |
| Cover Letter | 3 | Flash | $0.0012 | N/A |
| Project Gen | 4 | Pro | $0.040 | N/A |
| ATS Score | FREE | Lite | $0.0002 | N/A |
| Bullet Enhancement | 1 | Lite | $0.0003 | N/A |
| Skill Injection | 1 | Flash | $0.008 | Cheaper with cached index |

### 3.5 AI Prompt Engineering Overview

- **Parse prompt:** Structured JSON extraction — contact, summary, experience, education, skills, projects, certifications
- **Rewrite prompt:** Role-targeted, keyword injection, STAR format, humanized output
- **JD Tailor prompt:** Gap analysis, match scoring (0-100), section-specific suggestions
- **Project Generation:** Realistic, believable, specific tech stack, measurable outcomes (NOT machine-like)
- **ATS Score:** 5-category scoring — Keywords 30%, Formatting 20%, Completeness 20%, Action Verbs 15%, Metrics 15%

---

## SECTION 4: USER APPLICATION FLOW

### 4.1 Complete Screen Map

| Screen | URL | Key Elements | User Actions | Next Step |
|--------|-----|--------------|--------------|-----------|
| Landing Page | / | Hero, features, "Get Started Free" | Click Get Started | Sign up page |
| Login/Signup | /auth/login | Google OAuth, Email+Password, toggle | Sign in or create account | Dashboard |
| Auth Callback | /auth/callback | Processing OAuth return | Auto-redirect | Dashboard |
| Dashboard | /dashboard | Credit balance, Quick Actions, Recent Resumes, Low credit warning | Click quick action | Resume flow |
| My Resumes | /dashboard/resumes | Grid of resume cards with ATS badges | Edit/Duplicate/Delete | Editor |
| New Resume | /dashboard/resumes/new | Drag-drop upload zone (PDF/DOCX/TXT, max 5MB) OR Start From Scratch | Upload or Start Scratch | Editor |
| Resume Editor | /dashboard/resumes/[id]/edit | 3-panel: Nav \| Editor \| Preview. Tabs: Editor, ATS, JD Tailor | Edit sections, AI Enhance | Stay on editor |
| Cover Letter | /dashboard/resumes/[id]/cover-letter | Company, Role, JD inputs, Generate (3 credits) | Generate and copy/download | Editor |
| Credit Store | /dashboard/credits | Pack grid, promo code input, balance | Select and buy | Payment modal |
| Credit History | /dashboard/credits/history | Two tabs: Purchases and Usage | View history | N/A |

### 4.2 Resume Editor Layout (3-Panel)

#### LEFT PANEL (200px): Section Navigator
- Collapsible list of all resume sections
- Completion indicator (green dot if section has content)
- Drag-to-reorder sections
- Add/remove optional sections

#### CENTER PANEL (flexible): Active Section Editor
- Section title and editable fields (text inputs, textareas)
- Lock icon on locked fields (disabled input, gray background)
- "AI Enhance" button per section (shows credits to be consumed)
- AI result diff view with Apply / Discard buttons

#### RIGHT PANEL (300px): Live Preview
- Real-time styled resume rendering
- Template selector dropdown
- Zoom controls

#### TOP BAR
Resume title (editable) | Undo/Redo | Template dropdown | Download PDF | Credit balance | Auto-save status

#### BOTTOM TABS
Editor | ATS Score (FREE) | JD Tailor | Cover Letter link

### 4.3 Section Details (Locked vs Editable)

| Section | Locked Fields | AI-Editable Fields | AI Operations |
|---------|--------------|-------------------|---------------|
| Contact Info | Name, Email, Phone | LinkedIn URL, Portfolio URL | Format phone, suggest email |
| Summary | None | Entire summary | Generate, rewrite, keyword inject |
| Work Experience | Company, Client, Title, Dates | Bullet points, descriptions | Rewrite bullets, STAR, keywords |
| Projects | Name, Client, Dates | Description, Tech stack, Outcomes | Generate description, tech stack |
| Education | Institution, Degree, Dates, GPA | Coursework, Honors | Suggest relevant coursework |
| Skills | None | All skills | Role-aware injection, categorize |
| Certifications | Issuing body, Date | Description | Suggest relevant certs |
| Tools/Environments | None | All listings | Auto-suggest based on role |

---

## SECTION 5: ADMIN DASHBOARD SPECIFICATION

### 5.1 Admin Screens

| Screen | URL | Key Features | Actions Available |
|--------|-----|--------------|------------------|
| Overview | /admin | KPIs (users, revenue, credits sold, active today), Recent transactions, Recent signups | Date filter, drill-down |
| Pricing | /admin/pricing | Editable pack table (all fields inline editable), Active toggle, Add new pack | Edit prices/credits, toggle active, audit logged |
| Users | /admin/users | Search by email/name, User table with credits/role/joined, Grant Credits modal | Search, grant credits, change role |
| Analytics | /admin/analytics | Date range filter, Revenue by day, Top packs, Geo breakdown, Credit usage, Top users | Date range selection, export |
| API Tracking | /admin/api-tracking | Model usage + cost estimation, Cache hit rate, Daily API usage, Vendor status | View trends, set budget alerts |
| Promo Codes | /admin/promo-codes | Code list with usage counts, Create form, Active toggle | Create, edit, deactivate |
| Audit Log | /admin/audit-log | Every admin action: who, what, when, old value, new value | Filter by action type, pagination |

### 5.2 Admin KPIs

- Total Registered Users
- Total Revenue (all time)
- Total Credits Sold
- Active Users Today
- Free-to-Paid Conversion Rate
- Average Revenue Per Purchase
- Cache Hit Rate (JD Tailor)
- API Cost vs Revenue Ratio

### 5.3 Dynamic Pricing Control Flow

- **Step 1:** Admin navigates to /admin/pricing
- **Step 2:** Clicks Edit on any pack — fields become editable (credits, prices, description, badge)
- **Step 3:** Clicks Save — updates `pricing_packs` table in Supabase
- **Step 4:** Change is audit-logged (old value, new value, admin, timestamp)
- **Step 5:** User-facing credit store reads from same table — changes are **INSTANT**
- **Step 6:** No deployment needed

### 5.4 API & Vendor Tracking

| API / Vendor | Billing Type | Alert Thresholds |
|-------------|-------------|-----------------|
| OpenRouter (LLM Gateway) | Pay-per-use tokens | 80% budget, 100% budget |
| Supabase (Database) | Free tier | Storage limit, connection limit |
| Razorpay | Per-transaction 2.36% | Settlement delays, dispute spikes |
| Stripe | Per-transaction 2.9% + fixed | Chargeback rate |
| Vercel (Hosting) | Free tier | Bandwidth limit |
| Domain (.com) | Annual | 30 days before expiry |

---

## SECTION 6: DATABASE SCHEMA

### 6.1 Table Overview (10 Tables)

#### 1. profiles

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | UUID | PK, FK auth.users | Matches Supabase auth user |
| email | TEXT | NOT NULL | |
| full_name | TEXT | nullable | |
| avatar_url | TEXT | nullable | |
| role | TEXT | DEFAULT 'user' | CHECK: 'user' or 'admin' |
| credit_balance | INTEGER | DEFAULT 3 | 3 free credits on signup |
| total_credits_purchased | INTEGER | DEFAULT 0 | |
| total_credits_consumed | INTEGER | DEFAULT 0 | |
| country | TEXT | DEFAULT 'IN' | |
| currency | TEXT | DEFAULT 'INR' | |
| created_at | TIMESTAMPTZ | auto | |
| updated_at | TIMESTAMPTZ | auto | |

*RLS: Users read own, Admins read all*

#### 2. pricing_packs

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | UUID | PK | |
| name | TEXT | NOT NULL | |
| credits | INTEGER | NOT NULL | |
| price_inr | NUMERIC | NOT NULL | |
| price_usd | NUMERIC | NOT NULL | |
| price_gbp | NUMERIC | NOT NULL | |
| pack_type | TEXT | NOT NULL | standard / payg / promo |
| is_active | BOOLEAN | DEFAULT true | |
| sort_order | INTEGER | | |
| description | TEXT | nullable | |
| badge | TEXT | nullable | e.g., 'Popular', 'Best Value' |
| created_at / updated_at | TIMESTAMPTZ | auto | |

*RLS: Anyone reads active packs, Admins manage all*

#### 3. transactions

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | UUID | PK | |
| user_id | UUID | FK profiles | |
| pack_id | UUID | FK pricing_packs | nullable |
| amount | NUMERIC | NOT NULL | |
| currency | TEXT | NOT NULL | |
| credits_added | INTEGER | NOT NULL | |
| payment_gateway | TEXT | NOT NULL | razorpay / stripe / free / promo / referral |
| gateway_payment_id | TEXT | nullable | |
| gateway_order_id | TEXT | nullable | |
| status | TEXT | NOT NULL | pending / completed / failed / refunded |
| created_at | TIMESTAMPTZ | auto | |

*RLS: Users read own, Admins read all*

#### 4. resumes

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | UUID | PK | |
| user_id | UUID | FK profiles | |
| title | TEXT | DEFAULT 'Untitled Resume' | |
| original_file_url | TEXT | nullable | |
| parsed_data | JSONB | nullable | Structured resume JSON |
| metadata_index | JSONB | nullable | Skills, keywords, locked fields |
| current_version | INTEGER | DEFAULT 1 | |
| ats_score | INTEGER | nullable | 0-100 |
| target_role | TEXT | nullable | |
| template_id | TEXT | DEFAULT 'professional-clean' | |
| status | TEXT | DEFAULT 'draft' | draft / parsing / ready / error |
| created_at / updated_at | TIMESTAMPTZ | auto | |

*RLS: Users manage own, Admins read all*

#### 5. resume_versions

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | UUID | PK | |
| resume_id | UUID | FK resumes | |
| version_number | INTEGER | NOT NULL | |
| parsed_data | JSONB | NOT NULL | Snapshot of resume at this version |
| change_description | TEXT | nullable | |
| created_at | TIMESTAMPTZ | auto | |

#### 6. credit_usage

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | UUID | PK | |
| user_id | UUID | FK profiles | |
| resume_id | UUID | FK resumes | nullable |
| operation | TEXT | NOT NULL | parse / section_edit / full_rewrite / jd_tailor / ... |
| credits_used | INTEGER | NOT NULL | |
| ai_model | TEXT | nullable | |
| ai_cost_usd | NUMERIC | nullable | Estimated cost of this call |
| input_tokens | INTEGER | nullable | |
| output_tokens | INTEGER | nullable | |
| cached | BOOLEAN | DEFAULT false | |
| created_at | TIMESTAMPTZ | auto | |

*RLS: Users read own, Admins read all*

#### 7. jd_cache

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | UUID | PK | |
| user_id | UUID | FK profiles | |
| resume_id | UUID | FK resumes | |
| jd_hash | TEXT | NOT NULL | Hash of JD text |
| jd_text | TEXT | | Original JD text |
| tailored_result | JSONB | | Cached AI result |
| created_at | TIMESTAMPTZ | auto | |

*UNIQUE(user_id, resume_id, jd_hash). RLS: Users manage own*

#### 8. promo_codes

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | UUID | PK | |
| code | TEXT | UNIQUE, NOT NULL | |
| discount_percent | INTEGER | nullable | |
| bonus_credits | INTEGER | nullable | |
| max_uses | INTEGER | DEFAULT 100 | |
| current_uses | INTEGER | DEFAULT 0 | |
| valid_from | TIMESTAMPTZ | | |
| valid_until | TIMESTAMPTZ | nullable | |
| is_active | BOOLEAN | DEFAULT true | |
| created_at | TIMESTAMPTZ | auto | |

#### 9. admin_audit_log

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | UUID | PK | |
| admin_id | UUID | FK profiles | |
| action | TEXT | NOT NULL | e.g. update_pricing_pack, grant_credits |
| target_table | TEXT | nullable | |
| target_id | UUID | nullable | |
| old_value | JSONB | nullable | |
| new_value | JSONB | nullable | |
| created_at | TIMESTAMPTZ | auto | |

*RLS: Admins only*

#### 10. auth.users (Supabase Built-in)

Managed by Supabase Auth. Extended by **profiles** table via trigger on INSERT.

---

### 6.2 Key Database Functions

| Function | Trigger / RPC | Description |
|----------|--------------|-------------|
| handle_new_user() | TRIGGER on auth.users INSERT | Auto-creates profiles row with 3 free credits |
| deduct_credits(p_user_id, p_amount) | RPC | ATOMIC: row-locks profile, checks balance, deducts if sufficient, returns boolean |
| add_credits(p_user_id, p_amount) | RPC | Adds credits after successful payment, updates totals |
| update_updated_at() | TRIGGER | Auto-updates updated_at on profiles and resumes |

### 6.3 Row Level Security

All tables have RLS enabled. Users can only read/write their own data. Admins can read all data. **pricing_packs** active records are readable by everyone (public storefront). **admin_audit_log** is restricted to admin role only.

---

## SECTION 7: API DESIGN

### 7.1 API Endpoints

| Endpoint | Method | Purpose | Auth | Credits |
|----------|--------|---------|------|---------|
| /api/resume/parse | POST | Upload file text, parse with AI, create resume | Required | 2 |
| /api/ai | POST | All AI operations (9 types) | Required | Varies |
| /api/payments/create-order | POST | Create payment order; test mode auto-adds credits | Required | N/A |
| /api/payments/verify | POST | Verify payment signature, add credits | Required | N/A |
| /api/payments/webhook | POST | Payment gateway webhooks (Razorpay + Stripe) | Signature | N/A |

### 7.2 Unified AI Endpoint (/api/ai) Request Format

All AI operations go through a single POST endpoint with an **operation** field:

| Operation | Data Fields | Credits | Model |
|-----------|------------|---------|-------|
| full_rewrite | targetRole, keywords | 5 | Pro |
| section_edit | sectionType, content, targetRole | 1 | Flash |
| jd_tailor | jdText (auto checks cache first) | 4 | Pro |
| cover_letter | company, targetRole, jdText | 3 | Flash |
| project_generation | techStack, industry, experienceLevel | 4 | Pro |
| skill_injection | jdText | 1 | Flash |
| bulk_keyword_inject | jdText | 2 | Flash |
| bullet_enhancement | bullet | 1 | Lite |
| ats_score | jdText? (optional) | FREE | Lite |

### 7.3 Credit Deduction Flow

- **Step 1:** Receive request with operation type
- **Step 2:** Look up CREDIT_COSTS[operation]
- **Step 3:** If free operation (ats_score): skip to Step 7
- **Step 4:** If jd_tailor: check jd_cache table for hash match. If hit → return cached, 0 credits
- **Step 5:** Call `supabase.rpc('deduct_credits')` — atomic, returns boolean
- **Step 6:** If false → return 402 Payment Required "Insufficient credits"
- **Step 7:** If true → call AI model via OpenRouter
- **Step 8:** Log to `credit_usage` table (operation, credits, model, tokens, cached, cost)
- **Step 9:** Return AI result to client

---

## SECTION 8: TECHNOLOGY STACK

| Layer | Technology | Version | Why |
|-------|-----------|---------|-----|
| Frontend Framework | Next.js | 16.x | SSR for SEO, App Router, PWA support, TypeScript |
| Styling | Tailwind CSS + shadcn/ui | Latest | Rapid development, accessible, consistent |
| Database | PostgreSQL via Supabase | Latest | Relational, RLS, real-time, Mumbai region |
| Authentication | Supabase Auth | Built-in | Google OAuth, email/password, free 50K MAU |
| AI/LLM Gateway | OpenRouter | API v1 | Multi-model routing, single billing, 100+ models |
| AI Models (current) | Gemini 1.5 Pro + Flash | Latest | Free tier available, good quality |
| AI Models (future) | Claude Sonnet 4, GPT-4o, DeepSeek V3.2 | Latest | Best quality per task type |
| Payments India | Razorpay | Latest | UPI, cards, netbanking, best for India |
| Payments Global | Stripe | Latest | Cards, Apple Pay, Google Pay |
| Frontend Hosting | Vercel | Latest | Edge CDN, auto-deploy, free tier, Next.js native |
| File Storage | Supabase Storage | Built-in | Integrated, 5GB free, resume PDFs |
| Error Monitoring | Sentry | Free tier | Error tracking, performance monitoring |
| Version Control | GitHub | Private repo | Source control, CI/CD |
| Runtime | Node.js | 20.x | Required by Next.js |
| Language | TypeScript | 5.x | Type safety throughout |

---

## SECTION 9: SECURITY & COMPLIANCE

### 9.1 Data Security

- All data in transit: **HTTPS / TLS 1.3**
- Supabase RLS: **row-level isolation** between users
- Credit deduction: **atomic DB operations** with row locking (prevents race conditions)
- Payment signatures: **Razorpay HMAC-SHA256**, **Stripe webhook signature verification**
- API keys: environment variables only, **never in client-side code**
- Admin actions: all changes **audit-logged** with old/new values
- No sensitive financial data stored (**PCI DSS compliance via Razorpay/Stripe**)

### 9.2 Data Privacy & Compliance

| Aspect | Implementation | Compliance |
|--------|---------------|------------|
| Data Storage Location | Supabase PostgreSQL, Mumbai region (ap-south-1) | DPDPA data localization for India |
| Data Retention | Active: indefinite. Deleted: 30-day grace, then purged | GDPR Article 17, DPDPA |
| User Data Export | Users download all data from Settings | GDPR Article 20 portability |
| Account Deletion | Self-service deletion, cascading delete all tables | GDPR Article 17 right to erasure |
| Cookie Consent | Essential cookies only (auth). No tracking cookies | ePrivacy, GDPR |
| Third-Party Data Sharing | Resume content to OpenRouter (no storage). Payments via Razorpay/Stripe (PCI DSS) | DPA with processors |
| Encryption at Rest | Supabase AES-256 default | Industry standard |

---

## SECTION 10: LAUNCH ROADMAP

### 10.1 Phase Timeline

| Phase | Timeline | Deliverables |
|-------|----------|--------------|
| Phase 1: MVP | Weeks 1-4 | Auth (Google OAuth + email), Resume upload/parse, Section-by-section editor, 3 templates, Credit system, Razorpay |
| Phase 2: AI Features | Weeks 5-8 | All 10 AI operations, JD tailoring with cache, Free ATS scoring, Stripe |
| Phase 3: Admin & Polish | Weeks 9-12 | Admin dashboard (7 screens), Dynamic pricing, API tracking, Promo codes, PWA, SEO |
| Phase 4: Launch | Week 13 | Product Hunt, social media, SEO content, beta users |
| Phase 5: Scale | Months 4-6 | Multi-model routing (Claude + GPT-4o), 10+ templates, Referral program, A/B testing |
| Phase 6: Global | Months 7-12 | Region-specific templates, local payment methods, enterprise API |

### 10.2 Key Milestones

| # | Target | Milestone |
|---|--------|-----------|
| 1 | Week 4 | MVP live with core editor and India payments |
| 2 | Week 8 | All AI features operational, global payments enabled |
| 3 | Week 12 | Admin dashboard, dynamic pricing, promo codes complete |
| 4 | Week 13 | Public launch on Product Hunt |
| 5 | Month 6 | Multi-model AI, referral program, 10+ templates |
| 6 | Month 12 | Global expansion with region-specific features |

---

## SECTION 11: EXECUTIVE SUMMARY

- 27 user features, 7 admin screens, 10 database tables, 5 API endpoints
- 10 AI-powered operations (4 free, 6 paid)
- LLM routing: Gemini 1.5 Pro (heavy) / Gemini 1.5 Flash (medium/light) / Future: Claude Sonnet 4 + GPT-4o
- Caching reduces AI costs by 35-48% across JD tailoring operations
- Free tier: 3 credits + unlimited ATS scoring
- Tech stack: Next.js 16 + Supabase (Mumbai) + OpenRouter + Razorpay/Stripe + Vercel
- Launch timeline: 13 weeks from MVP to public launch
- Key differentiators: Section-by-section AI editing with locked fields, free JD regeneration (cached), AI project generation, credit-based model

---

## APPENDIX A: RISKS, ASSUMPTIONS & SUCCESS METRICS

### A.1 Key Assumptions

- OpenRouter provides Gemini model access; fallback models configured, can switch in under 1 hour
- Supabase free tier sufficient for initial launch (500MB DB, 5GB storage, 50K MAU)
- Vercel free tier supports initial traffic (100GB bandwidth/month)
- Average user consumes 15-25 credits per job search cycle
- Free ATS scoring attracts organic traffic ("free ATS checker" has 110K+ monthly global searches)

### A.2 Risk Assessment

| Risk | Impact | Probability | Mitigation |
|------|--------|-------------|------------|
| LLM provider price increase | High | Medium | Multi-model architecture, 100+ OpenRouter models, margin buffer |
| LLM quality degradation | High | Low | A/B testing, automatic fallback to alternative models |
| Competitor launches similar features | Medium | High | Credit model and caching are structural advantages |
| Low initial user acquisition | High | Medium | Free ATS scoring as SEO-driven acquisition, Product Hunt launch |
| Payment gateway issues | Medium | Low | Razorpay most reliable in India; backup: PayU or Cashfree |
| Supabase downtime | High | Low | 99.9% uptime SLA, auto-save prevents data loss |
| Data breach | Critical | Low | RLS at DB level, no financial data stored |
| DPDPA regulatory changes | Medium | Medium | Minimal data collection, data stored in India |

### A.3 Success Metrics (Technical KPIs)

| Metric | Target Month 1 | Target Month 3 | Target Month 6 |
|--------|---------------|---------------|---------------|
| Total Signups | 500 | 2,500 | 8,000 |
| Free-to-Paid Conversion | 8-12% | 10-15% | 12-18% |
| ATS Scores Generated (Free) | 2,000 | 10,000 | 40,000 |
| Cache Hit Rate (JD Tailor) | 20% | 35% | 45% |
| API Cost / Revenue Ratio | Below 25% | Below 20% | Below 18% |
| Monthly Active Users | 200 | 1,000 | 3,500 |
| Resume Parse Success Rate | Above 90% | Above 93% | Above 95% |
| NPS Score | 40+ | 50+ | 60+ |

---

*End of Document — CraftVita PRD v1.0 Development Edition*