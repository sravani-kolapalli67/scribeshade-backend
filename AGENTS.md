# AGENTS.md

AI agent instructions for this backend repository.

## Project Snapshot
- **App**: ScribeShade — AI-powered interview assistant with real-time session coaching, credit billing, and resume tooling.
- **Stack**: Express 5 + TypeScript + Prisma (PostgreSQL) + Clerk auth + OpenRouter AI + BullMQ (Redis) + Razorpay payments.
- **Runtime**: Node >= 20, package manager is pnpm.
- **Entrypoints**: [src/server.ts](src/server.ts), [src/app.ts](src/app.ts).
- **API reference**: [docs/api-reference.md](docs/api-reference.md) (v1.3.0).

## Setup And Run
- Install: `pnpm install`
- Dev server: `pnpm dev`
- Build: `pnpm build`
- Start built app: `pnpm start`
- Type check: `pnpm type-check`

## Database Workflow
- Prisma schema: [prisma/schema.prisma](prisma/schema.prisma)
- Generate client after schema changes: `pnpm db:generate`
- Create/apply local migration: `pnpm db:migrate`
- Sync schema without migration (careful): `pnpm db:push`
- Inspect data: `pnpm db:studio`

## Architecture Boundaries
- API mount point is `/api` in [src/app.ts](src/app.ts).
- Route registration is centralized in [src/routes/index.ts](src/routes/index.ts).
- Feature modules follow a router/controller/service split under [src/features](src/features).
- Shared cross-cutting code lives under [src/shared](src/shared) (middleware, prisma client, utils, types, prompts).

## Feature Modules

| Module | Path | Notes |
|---|---|---|
| `auth` | [src/features/auth](src/features/auth) | Clerk middleware, `requireAuth`, `getCurrentUserId`, `/me` sync, `/tauri-ticket`, Svix webhooks |
| `session` | [src/features/session](src/features/session) | Core interview lifecycle; SSE streaming; AI answer/screen analysis; credit enforcement via heartbeat |
| `resume` | [src/features/resume](src/features/resume) | PDF/DOC upload, ATS scoring, templates CRUD, cover letter generation |
| `document` | [src/features/document](src/features/document) | Supporting document upload; content fed to AI session context |
| `credits` | [src/features/credits](src/features/credits) | Balance, ledger, Razorpay order + HMAC verify, bracket configs, packs |
| `qa` | [src/features/qa](src/features/qa) | Q&A records per session/company/user; public `isShared` flag |
| `company` | [src/features/company](src/features/company) | Read-only company directory |
| `projects` | [src/features/projects](src/features/projects) | AI-generated project suggestions; stored as JSON blobs |
| `session-notes` | [src/features/session-notes](src/features/session-notes) | AI post-session notes generation |
| `policy` | [src/features/policy](src/features/policy) | Single-row privacy policy / terms storage |
| `jobs` | [src/features/jobs](src/features/jobs) | BullMQ workers: `credit-deduction`, `session-watchdog` (60s tick), `hold-expiry` (10-min PRE_CHECK cleanup) |
| `user` | [src/features/user](src/features/user) | **Dead code** — router is commented out and not registered. Do not add to routes. |

## Auth And Request Context
- Global Clerk middleware is applied in [src/app.ts](src/app.ts); auth state exists on most requests.
- Use `getCurrentUserId` from [src/features/auth/auth.middleware.ts](src/features/auth/auth.middleware.ts) when user identity is required.
- For protected route groups, use `requireAuth` from [src/features/auth/auth.middleware.ts](src/features/auth/auth.middleware.ts).
- **Clerk ID vs DB ID**: Clerk's `userId` is stored as `clerkId` on the `User` model. The internal DB `user.id` (UUID) is used for all FK relations. Always resolve: `getCurrentUserId(req)` → `prisma.user.findUnique({ where: { clerkId } })` → use `user.id` for queries.

## Error Handling Conventions
- Global error middleware: [src/shared/middleware/error.middleware.ts](src/shared/middleware/error.middleware.ts).
- `AppError(statusCode, message)` + `next(err)` is the preferred pattern in new code.
- `ZodError` → `400 { error, details: { formErrors, fieldErrors } }`.
- **Mixed pattern**: newer modules (credits, session-notes) use `next(err)`; older modules (session, resume) catch and return `res.status(500).json(...)` directly. Preserve local style unless doing a deliberate refactor.

## Response Format Conventions
- **Newer modules**: `{ success: true, data: ... }`.
- **Older modules** (session, resume): direct entity or mixed `{ success: true, sessionId, data }`.
- **Pagination**: `{ success, data, pagination: { total, page, limit, pages } }`.
- **AI streaming**: plain text chunks via `res.write()` + `res.end()`.
- **SSE events**: `event: <name>\ndata: <JSON>\n\n` via `sseManager` ([src/shared/lib/sse.ts](src/shared/lib/sse.ts)).
- **No WebSocket**: all real-time session events use SSE (`GET /session/:id/events`).
- **Prisma `Decimal`** fields serialize as strings (e.g. `"0.50"`) in JSON responses.

## Credit System
- On session creation, credits are **held** (moved from `totalAvailable` to `heldCredits`).
- On completion, the `credit-deduction` BullMQ job does the final deduction and releases the hold.
- `hold-expiry` job fires 10 min after creation to clean up sessions stuck in `PRE_CHECK`.
- Session state machine: `PRE_CHECK → ACTIVE ↔ PAUSED → COMPLETING → COMPLETED` or `→ CREDIT_EXHAUSTED → COMPLETED` or `→ ABANDONED / FORCE_ENDED`.

## File Upload And Storage Notes
- Static uploads are served from `/uploads` in [src/app.ts](src/app.ts).
- Uploaded files persist under `uploads/documents/` and `uploads/resumes/`.
- `POST /session/create-session` uses `multer().any()` to handle FormData + JSON bodies; booleans need explicit `=== "true"` coercion.

## Env And Config
- Validated at startup (fail-fast) in [src/config/env.ts](src/config/env.ts).
- `DATABASE_URL`, `CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY` are required by Zod.
- **Not in Zod but required at runtime**: `OPENROUTER_API_KEY` (AI features fail at module load), `CLERK_WEBHOOK_SECRET` (webhook verification).
- Optional: `REDIS_URL` (default `redis://localhost:6379`), `CORS_ORIGINS` (default `http://localhost:3000,http://localhost:1420`), `RAZORPAY_KEY_ID/SECRET`, `OPENROUTER_MODEL`.

## Key Shared Utilities
| Path | Purpose |
|---|---|
| [src/shared/lib/prisma.ts](src/shared/lib/prisma.ts) | Singleton `PrismaClient` with dev hot-reload cache |
| [src/shared/lib/sse.ts](src/shared/lib/sse.ts) | `SSEManager` — session → `Set<Response>` map |
| [src/shared/lib/prompt.ts](src/shared/lib/prompt.ts) | `buildSystemMessage(context)` for AI interview assistant |
| [src/shared/prompts/analytics.ts](src/shared/prompts/analytics.ts) | Session feedback AI prompts |
| [src/shared/prompts/session-notes.ts](src/shared/prompts/session-notes.ts) | Session notes AI prompts |

## Change Checklist For Agents
- Keep changes scoped to the touched feature module.
- If adding a new feature route:
  1. Add router/controller/service files in [src/features](src/features).
  2. Register router in [src/routes/index.ts](src/routes/index.ts).
  3. Update [docs/api-reference.md](docs/api-reference.md) — see [api-doc-sync instructions](.github/instructions/api-doc-sync.instructions.md).
- If changing Prisma models:
  1. Update [prisma/schema.prisma](prisma/schema.prisma).
  2. Run `pnpm db:migrate` then `pnpm db:generate`.
- Before finishing, run: `pnpm type-check` and `pnpm build`.
