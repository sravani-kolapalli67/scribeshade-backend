---
description: "Use when creating, updating, renaming, or deleting backend APIs (routes, controllers, services, request/response contracts, auth requirements, or error behavior). Also apply when asked about any API endpoint, route registration, or when touching src/routes/index.ts, src/features/**/*.router.ts, src/features/**/*.controller.ts. Keep docs/api-reference.md in sync with every change."
name: "API Reference Sync Rule"
applyTo: "src/routes/index.ts, src/features/**/*.router.ts, src/features/**/*.controller.ts, .github/docs/api-reference.md"
---
# API Reference Sync Rule

**Mandatory:** Whenever any API is created, modified, or removed — in the same change — you must update [docs/api-reference.md](docs/api-reference.md).

## Required Updates to docs/api-reference.md

1. Update `Last updated` to today's date.
2. Bump `Document version` using semantic versioning:
   - `MAJOR`: breaking change — removed endpoint, incompatible request/response shape.
   - `MINOR`: new endpoint or backward-compatible response fields added.
   - `PATCH`: documentation corrections, clarifications, or non-breaking wording.
3. Append one row in `## Version History`:
   ```
   | vX.Y.Z | YYYY-MM-DD | Summary of API changes |
   ```

## Coverage Checklist (every new or changed endpoint)

- [ ] HTTP method + full path (e.g. `POST /resume/builder/save`)
- [ ] Auth requirement (`requireAuth`, public, or `getCurrentUserId`)
- [ ] Request: body fields, query params, path params, file upload notes
- [ ] Success response: status code + JSON example
- [ ] Error responses: at minimum the most likely `4xx` and `500` with body examples
- [ ] Streaming / SSE / file-upload behavior (if applicable)
- [ ] Credit cost (if the endpoint deducts credits)

## Where to Add New Sections

- Match the existing module groupings (Auth, Credits, Session, Resume, etc.).
- If a new feature module is added, create a new `## <Module> APIs` section before `## Version History`.
- Mounted path comes from [src/routes/index.ts](src/routes/index.ts). Double-check the prefix when writing paths.

## Do Not Finish Without

- Syncing [docs/api-reference.md](docs/api-reference.md) with all of the above.
- Verifying `pnpm type-check` and `pnpm build` pass after changes.
