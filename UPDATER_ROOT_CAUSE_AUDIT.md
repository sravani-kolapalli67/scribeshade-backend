# ScribeShade Tauri Updater Root-Cause Audit

Date: 2026-05-22  
Scope: Frontend Tauri updater client + release workflows + backend update proxy API

## Executive Summary
Auto-update distribution is currently fragile because release generation is split across two workflows with different behaviors. One workflow creates GitHub releases without updater metadata assets, while the other creates proper Tauri updater releases. If operators publish from the wrong workflow/branch, clients will not update automatically even when app version changes.

The most likely production failure mode is:
- New app build exists in GitHub release assets
- But required updater metadata/signatures are missing or mismatched
- `@tauri-apps/plugin-updater` cannot detect/apply update
- Users remain on old version unless they manually reinstall

---

## Findings (Ordered by Severity)

## 1) CRITICAL: `build.yml` release path does not publish updater metadata assets

### Evidence
- File: `/.github/workflows/build.yml`
- It runs `pnpm tauri build` and uploads only installers (`.dmg`, `.msi`, `.exe`, `.deb`, `.AppImage`) via `softprops/action-gh-release`.
- Release file patterns in this workflow **exclude** updater artifacts such as:
  - `latest.json`
  - signature files (`*.sig`)

### Why this breaks auto-update
Tauri updater requires manifest + signatures generated and published consistently with binaries. Without these assets, updater check/download/install either fails silently or reports no actionable update.

### Impact
- Version is bumped and installers are downloadable
- Existing desktop installs do not auto-update
- Looks like “distribution broken” to end users

### Recommended fix
- Either:
  1. Stop using `build.yml` to publish desktop releases, and use only `release.yml` for updater-compatible releases.
  2. Or update `build.yml` to include all updater artifacts (`latest.json`, `.sig`, target bundles) and ensure atomic release publication.

---

## 2) CRITICAL: Two release workflows create different release semantics (channel confusion)

### Evidence
- `/.github/workflows/build.yml`
  - Trigger: `push` to `main` / `develop`
  - Creates tag format `v<version>-<short_sha>`
- `/.github/workflows/release.yml`
  - Trigger: `push` to `release` / `release-*`
  - Uses `tauri-apps/tauri-action` and tag `v__VERSION__`

### Why this breaks auto-update
Backend updater endpoint fetches **GitHub latest release** (`/releases/latest`). If the latest published release is from the non-updater-compatible workflow, clients see a release that cannot be applied.

### Impact
- Non-deterministic update behavior depending on which workflow published last
- Operations team may think “release succeeded” but updater fails in app

### Recommended fix
- Establish one authoritative release pipeline for desktop updater (prefer `release.yml` with `tauri-action`).
- Prevent `build.yml` from creating public GitHub releases (artifact only), or mark those as prerelease/non-latest channel.

---

## 3) HIGH: Frontend updater treats `check() === null` as an error in manual flow

### Evidence
- File: `/src/lib/updater.ts`
- Current behavior:
  - if `update === null` and user clicked manual check, UI shows: “Failed to check for updates.”

### Why this is wrong
In Tauri updater flow, `null` commonly means no update available. Misclassifying this as failure confuses QA and users and hides real telemetry about actual errors.

### Impact
- False error UX
- Harder to diagnose real updater outages

### Recommended fix
- Treat `null` as “already up to date” in manual flow.
- Reserve error dialog for thrown exceptions/network/verification failures.

---

## 4) HIGH: Updater check runs once at launcher mount only (no retry policy)

### Evidence
- File: `/src/pages/Launcher/WidgetApp.tsx`
- `checkForUpdates()` is called once in a mount `useEffect`.

### Why this causes missed updates
Any transient failure (startup network issue, backend temporary error, GitHub rate limit) means no further auto-check until app restart or manual action.

### Impact
- Users can stay stale for long sessions
- Update adoption delays

### Recommended fix
- Add periodic background checks (e.g., every 4–12 hours) with jitter.
- Add backoff retry on startup failure.

---

## 5) MEDIUM: Backend updater depends strictly on `/releases/latest`

### Evidence
- File: `/src/features/updates/updates.router.ts`
- Uses `https://api.github.com/repos/<repo>/releases/latest`

### Risk
If release process uses draft/prerelease gating, updater may not see intended rollout immediately.

### Recommended fix
- Make channel explicit:
  - stable endpoint (`latest` non-prerelease)
  - optional beta endpoint
- Add diagnostics exposing which GitHub tag is currently served to clients.

---

## 6) MEDIUM: Release/version mismatch risk due mixed versioning paths

### Evidence
- `scripts/tauri-wrapper.cjs` auto-bumps version on local `pnpm tauri build` when not CI.
- `release.yml` expects version already committed and uses `v__VERSION__`.

### Risk
Manual local builds and CI releases may diverge if team forgets consistent bump policy.

### Recommended fix
- Enforce single version bump mechanism:
  - CI-based bump/tag, or
  - mandatory pre-release bump script + validation step.
- Add CI guard: fail if `package.json`, `src-tauri/tauri.conf.json`, and `src-tauri/Cargo.toml` versions differ.

---

## 7) LOW: Sparse updater observability in frontend

### Evidence
- `src/lib/updater.ts` logs minimal info; no structured reason codes.

### Impact
When updates fail in field, root-cause triage is slow.

### Recommended fix
- Add structured telemetry fields:
  - `check_started`, `check_result`, `available_version`, `download_started`, `download_done`, `install_done`, `relaunch_prompted`, `error_code`.

---

## Backend Health Endpoint Assessment

Backend provides `/api/updates/health` with useful checks:
- token present
- GitHub API reachability
- latest release presence
- latest.json parse
- platform signature presence

This is good, but currently it does not validate that manifest URLs are downloadable end-to-end by an unauthenticated client from production edge/CDN path. Add a synthetic probe for rewritten `/api/updates/download/*` URLs.

---

## Frontend + Backend Integration Notes

- Tauri config updater endpoint is currently:
  - `https://test.backend.scribeshade.org/api/updates/latest.json`
- Per your note, this is intended production endpoint. No change required if operationally true.
- Updater permissions/capabilities are present (`updater:allow-check`, `updater:allow-download-and-install`).

---

## Most Probable Root Cause (for current “users not updating” reports)

1. Release published via `build.yml` path (without full updater metadata/signatures), or
2. `build.yml` release became latest and overshadowed proper `release.yml` updater release.

This directly matches symptom: version exists, but installed apps don’t auto-upgrade.

---

## Action Plan (Priority)

1. Make `release.yml` the only workflow that publishes public desktop releases.
2. Disable GitHub release creation in `build.yml` (artifact-only CI), or convert to prerelease channel.
3. Fix `updater.ts` null-handling and messaging.
4. Add periodic updater retry checks in app runtime.
5. Add CI validation that release contains `latest.json` + required signatures.
6. Add updater telemetry + backend synthetic download probe.

---

## File Reference Index

### Frontend
- `/Users/hiddenmindsolutions/Projects/scribeshade-01-frontend/src/lib/updater.ts`
- `/Users/hiddenmindsolutions/Projects/scribeshade-01-frontend/src/pages/Launcher/WidgetApp.tsx`
- `/Users/hiddenmindsolutions/Projects/scribeshade-01-frontend/src-tauri/tauri.conf.json`
- `/Users/hiddenmindsolutions/Projects/scribeshade-01-frontend/.github/workflows/build.yml`
- `/Users/hiddenmindsolutions/Projects/scribeshade-01-frontend/.github/workflows/release.yml`
- `/Users/hiddenmindsolutions/Projects/scribeshade-01-frontend/scripts/tauri-wrapper.cjs`

### Backend
- `/Users/hiddenmindsolutions/Projects/scribeshade-01-backend/src/features/updates/updates.router.ts`
- `/Users/hiddenmindsolutions/Projects/scribeshade-01-backend/src/routes/index.ts`

