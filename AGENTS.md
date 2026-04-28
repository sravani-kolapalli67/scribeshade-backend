# AGENTS.md

AI agent instructions for this backend repository.

## Project Snapshot
- Stack: Express 5 + TypeScript + Prisma + Clerk auth + OpenRouter integrations.
- Runtime: Node >= 20, package manager is pnpm.
- Entrypoints: [src/server.ts](src/server.ts), [src/app.ts](src/app.ts).

## Setup And Run
- Install: pnpm install
- Dev server: pnpm dev
- Build: pnpm build
- Start built app: pnpm start
- Type check: pnpm type-check

## Database Workflow
- Prisma schema: [prisma/schema.prisma](prisma/schema.prisma)
- Generate client after schema changes: pnpm db:generate
- Create/apply local migration: pnpm db:migrate
- Sync schema without migration (careful): pnpm db:push
- Inspect data: pnpm db:studio

## Architecture Boundaries
- API mount point is /api in [src/app.ts](src/app.ts).
- Route registration is centralized in [src/routes/index.ts](src/routes/index.ts).
- Feature modules generally follow router/controller/service split under [src/features](src/features).
- Shared cross-cutting code lives under [src/shared](src/shared) (middleware, prisma client, utils, types).

## Auth And Request Context
- Global Clerk middleware is applied in [src/app.ts](src/app.ts); auth state exists on most requests.
- Use getCurrentUserId from [src/features/auth/auth.middleware.ts](src/features/auth/auth.middleware.ts) when user identity is required.
- For protected route groups, use requireAuth from [src/features/auth/auth.middleware.ts](src/features/auth/auth.middleware.ts).

## Error Handling Conventions
- Global error middleware lives in [src/shared/middleware/error.middleware.ts](src/shared/middleware/error.middleware.ts).
- Prefer forwarding typed errors with AppError + next(err) in new code so response formatting remains consistent.
- Some existing controllers return JSON errors directly; preserve local style when editing a file unless doing a deliberate refactor.

## File Upload And Storage Notes
- Static uploads are served from /uploads in [src/app.ts](src/app.ts).
- Document upload pipeline is in [src/features/document/document.router.ts](src/features/document/document.router.ts) and [src/features/document/document.service.ts](src/features/document/document.service.ts).
- Uploaded files are persisted under uploads/documents and uploads/resumes.

## Env And Config
- Environment validation is strict and fail-fast in [src/config/env.ts](src/config/env.ts).
- Required values include DATABASE_URL and Clerk keys; app exits on invalid config.
- Some features also require OPENROUTER_API_KEY at module load time (see [src/features/document/document.service.ts](src/features/document/document.service.ts)).

## Change Checklist For Agents
- Keep changes scoped to the touched feature module.
- If adding a new feature route:
  1. Add router/controller/service in [src/features](src/features).
  2. Register router in [src/routes/index.ts](src/routes/index.ts).
- If changing Prisma models:
  1. Update [prisma/schema.prisma](prisma/schema.prisma).
  2. Run migration and regenerate client.
- Before finishing, run at least: pnpm type-check and pnpm build.
