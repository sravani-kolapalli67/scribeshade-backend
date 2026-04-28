---
description: "Use when creating, updating, renaming, or deleting backend APIs (routes, controllers, services, request/response contracts, auth requirements, or error behavior). Keep docs/api-reference.md in sync with update time and version history."
name: "API Reference Sync Rule"
applyTo: "src/routes/index.ts, src/features/**/*.router.ts, src/features/**/*.controller.ts, docs/api-reference.md"
---
# API Reference Sync Rule

Whenever any API is created or updated, you must update [docs/api-reference.md](docs/api-reference.md) in the same change.

Required updates in [docs/api-reference.md](docs/api-reference.md):
- Update `Last updated` to the current date.
- Bump `Document version` using semantic versioning:
- `MAJOR`: breaking API change (removed endpoint, incompatible request/response change).
- `MINOR`: new endpoint or new backward-compatible response fields.
- `PATCH`: docs corrections, clarifications, examples, or non-breaking wording updates.
- Append one entry in `## Version History` with:
- version
- date
- summary of API changes

Coverage checklist for any API change:
- Method + path
- Auth requirement
- Request payload/query/path parameters
- Success response example
- Error responses (at least key status codes and body examples)
- Streaming/file-upload behavior (if applicable)

Do not finish API implementation tasks without syncing [docs/api-reference.md](docs/api-reference.md).
