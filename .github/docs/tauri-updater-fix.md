# Tauri Auto-Updater Fix & Architecture

## Issue

The Tauri auto-updater is not working for any platform (macOS, Windows, Linux). Users are not receiving update prompts when a new version is released to GitHub.

## Root Cause

The GitHub release's `latest.json` asset contains **fresh install artifacts** instead of **updater artifacts**:

- **macOS:** `.dmg` files (for fresh installs) instead of `.app.tar.gz` (required by auto-updater)
- This causes Tauri's `downloadAndInstall()` to fail on macOS
- The backend endpoint (`/api/updates/latest.json`) proxies this `latest.json` directly from GitHub — the backend cannot fix this

**Why this happens:**
The GitHub release workflow uses `tauri-action@v0` which should automatically generate `latest.json` with updater artifacts when `createUpdaterArtifacts: true` is set in `tauri.conf.json`. The current `latest.json` contains `.dmg` URLs, indicating either:

1. The release was created manually (not by the GitHub Actions workflow)
2. The `tauri-action@v0` is not generating updater artifacts correctly
3. The `latest.json` was manually edited after release creation

**Impact on all platforms:**
While macOS is the most affected (wrong file format), Windows and Linux might also be affected if the `latest.json` was manually created or the workflow is not generating proper updater artifacts for those platforms either.

**Platform keys:**
The platform keys in the GitHub release are correct (darwin-aarch64, darwin-x86_64, windows-x86_64, etc.) — this is not the issue.

## Backend Fix Applied (Necessary But Insufficient)

**File:** `src/features/updates/updates.router.ts`

Removed the darwin-specific block that was replacing `.app.tar.gz` URLs with `.dmg` URLs:

```typescript
// ❌ REMOVED — This broke the auto-updater
if (platform.startsWith("darwin")) {
  const dmgAsset = release.assets.find(a => a.name.endsWith(".dmg"));
  if (dmgAsset) {
    filename = dmgAsset.name;
    const assetId = dmgAsset.id;
    manifest.platforms[platform].url = `${base}/api/updates/download/${encodeURIComponent(filename)}?assetId=${assetId}`;
    continue;
  }
}
```

**Why this was removed:**
1. **Wrong file format** — Tauri's `downloadAndInstall()` on macOS requires `.app.tar.gz` for in-place updates. `.dmg` is a distribution format for fresh installs, not for delta updates.
2. **Signature mismatch** — The `signature` field in `latest.json` is the minisign signature of the `.app.tar.gz`. Verifying a `.dmg` against that signature fails.

**Status:** ✅ Backend fix applied and deployed to production. However, this fix alone is insufficient because the GitHub release's `latest.json` itself contains `.dmg` URLs. The backend now correctly proxies whatever is in the GitHub release, but the GitHub release still has the wrong artifacts.

## Architecture Overview

### Backend (`/api/updates/latest.json`)

The backend proxy fetches the latest GitHub release and:

1. Downloads the `latest.json` asset from the private GitHub release
2. Rewrites all platform download URLs to route through `/api/updates/download/:filename` (for authenticated access)
3. Returns the manifest to the Tauri client

### Frontend (`src/lib/updater.ts`)

The updater runs on app launch:

```typescript
useEffect(() => {
  checkForUpdates();
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, []);
```

It calls `@tauri-apps/plugin-updater`'s `check()` function:
- Returns `null` if no update is available or if there's an error
- Returns an `Update` object with `available: true` if a newer version exists

If an update is available, the user sees:
- A dialog with the version number and release notes
- "Update Now" or "Later" buttons

Clicking "Update Now" calls `update.downloadAndInstall()` → `relaunch()`.

### Tauri Updater File Requirements

| Platform | Updater Artifact | Fresh Install Artifact |
|---|---|---|
| macOS | `.app.tar.gz` (required by Tauri) | `.dmg` |
| Windows | `.exe` or `.msi` | `.exe` or `.msi` |
| Linux | `.AppImage` or `.deb` | `.AppImage` or `.deb` |

**Critical:** The auto-updater can ONLY use the updater artifact column. It cannot apply fresh install artifacts.

## Current Status

- ✅ Backend fix applied — removed darwin `.dmg` override block in `updates.router.ts`
- ✅ Backend deployed to production (deploy.sh executed successfully)
- 🔴 **Root cause remains:** GitHub release's `latest.json` contains fresh install artifacts (`.dmg`) instead of updater artifacts (`.app.tar.gz`) for macOS
- ⏳ GitHub release needs to be regenerated with correct updater artifacts by the GitHub Actions workflow
- ⏳ After GitHub release is fixed, users will receive update prompts on next app launch

## RESOLUTION STEPS

### Step 1: Verify Backend Endpoint ✅

The backend proxy at `/api/updates/latest.json` is correctly implemented. It:
1. Fetches the GitHub release's `latest.json` asset
2. Rewrites download URLs through `/api/updates/download/:filename`
3. Returns the manifest with updated URLs

**No changes needed** — the backend is working correctly.

### Step 2: Verify Tauri Configuration ✅

Check `src-tauri/tauri.conf.json`:
- ✅ `"createUpdaterArtifacts": true` is set (line 80 in bundle config)
- ✅ `"endpoints"` points to `https://test.backend.scribeshade.org/api/updates/latest.json`
- ✅ `"pubkey"` is configured (minisign public key for signature verification)

**No changes needed** — Tauri is configured correctly.

### Step 3: Verify GitHub Actions Workflow ✅

The `.github/workflows/release.yml` uses `tauri-action@v0` which:
1. Builds the app for the specified platform
2. Signs artifacts with the private key (stored in `TAURI_SIGNING_PRIVATE_KEY`)
3. Generates `latest.json` with correct updater artifacts
4. Creates the GitHub Release and uploads all artifacts

**No changes needed** — the workflow is correct.

### Step 4: Verify Frontend Updater Implementation ✅

The `src/lib/updater.ts` correctly:
1. Calls `check()` from `@tauri-apps/plugin-updater`
2. Shows an update dialog with version and release notes
3. Calls `downloadAndInstall()` on user confirmation
4. Relaunches the app after installation

**No changes needed** — the frontend implementation is correct.

### Step 5: Identify & Fix Root Cause

**The GitHub release likely has incorrect artifacts because:**

1. **Manual release creation** — If a release was created manually (not via the GitHub Actions workflow), it will contain whatever artifacts were uploaded manually, likely the fresh install files (`.dmg`, `.msi`, `.exe`).

2. **tauri-action@v0 not invoked** — The release was created outside the CI/CD pipeline.

**Solution:**
1. **Delete the problematic release** from GitHub → Releases → select release → Delete
2. **Trigger the workflow again:**
   ```bash
   # Make a commit and push to the release branch
   git checkout release
   git pull origin release
   git commit --allow-empty -m "Trigger release workflow"
   git push origin release
   ```
3. **Verify the new release has correct artifacts:**
   - macOS: `.app.tar.gz` and `.app.tar.gz.sig` (not `.dmg`)
   - Windows: `.msi`, `.exe`, `.msi.sig`, `.exe.sig`
   - Plus a `latest.json` asset containing platform keys like `darwin-aarch64`, `darwin-x86_64`, `windows-x86_64`

### Step 6: Verify Signature and Platform Keys

Once the new release is created, check the `latest.json` asset contains entries like:

```json
{
  "version": "1.1.1",
  "notes": "...",
  "pub_date": "2026-05-18T00:00:00Z",
  "platforms": {
    "darwin-aarch64": {
      "url": "https://github.com/hiddenmindsolutions/scribeshade-01-frontend/releases/download/v1.1.1/ScribeShade_1.1.1_aarch64.app.tar.gz",
      "signature": "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIG1pbmlzaWduIHByaXZhdGUga2V5Ci..."
    },
    "darwin-x86_64": { /* similar */ },
    "windows-x86_64": {
      "url": "https://github.com/.../ScribeShade_1.1.1_x64-setup.msi",
      "signature": "..."
    }
  }
}
```

**Key points:**
- Platform keys match `"${os}-${arch}"` format
- URLs point to `.app.tar.gz` (not `.dmg`) for macOS
- URLs point to `.msi` or `.exe` for Windows
- Every `url` has a corresponding `signature`

### Step 7: Test on Client

After a new release is deployed:

1. **Increment version** in `src-tauri/tauri.conf.json` (e.g., `1.1.1` → `1.1.2`)
2. **Push to release branch** to trigger the workflow
3. **Wait for release** to complete
4. **On user machines**, the next app launch will:
   - Call `/api/updates/latest.json`
   - Detect that `1.1.2 > 1.1.1` (current version)
   - Show update dialog
   - Download `.app.tar.gz`, verify signature, install in-place
   - Relaunch the app

---

## Deployment Checklist

- [ ] Delete problematic release from GitHub Releases
- [ ] Trigger workflow by pushing to `release` branch (empty commit is fine)
- [ ] Wait for GitHub Actions to complete (5–10 minutes)
- [ ] Verify new release has `.app.tar.gz` (not `.dmg`) for macOS
- [ ] Verify new release has correct `latest.json` with platform keys
- [ ] Verify `latest.json` signatures are not empty
- [ ] On test machine, check for updates and confirm dialog appears
- [ ] Click "Update Now" and verify installation completes
- [ ] Verify app relaunches with new version

---

## Troubleshooting

| Issue | Diagnosis | Fix |
|-------|-----------|-----|
| **No update dialog appears** | `check()` returns `null` | Check backend endpoint `/api/updates/latest.json` returns valid JSON with `platforms` object |
| **Backend endpoint 503** | `GITHUB_TOKEN` not configured | Set `GITHUB_TOKEN` env var on backend and restart |
| **Backend endpoint 404** | `latest.json` asset missing | Recreate release via GitHub Actions (must use `tauri-action@v0`) |
| **Signature verification fails** | Public key mismatch or wrong artifact format | Verify `pubkey` in `tauri.conf.json` matches the key used to sign the release; verify `.app.tar.gz` (not `.dmg`) |
| **Download fails (451 status)** | GitHub rate limit on private releases | Ensure `GITHUB_TOKEN` in backend is valid and has `repo` scope |

---

## Architecture Overview (Final)

```
┌─ User clicks "Check for Updates" ─────────────────────────────────────┐
│                                                                        │
│  [Frontend] src/lib/updater.ts                                         │
│    └─ call @tauri-apps/plugin-updater.check()                         │
│       └─ fetch https://test.backend.scribeshade.org/api/updates/latest.json
│          └─ Backend proxy fetches GitHub release latest.json          │
│             └─ GitHub /repos/.../releases/latest → latest.json asset  │
│                                                                        │
│  [Backend] src/features/updates/updates.router.ts                     │
│    └─ GET /api/updates/latest.json                                    │
│       └─ 1. Fetch release metadata from GitHub API                    │
│       └─ 2. Download latest.json asset from GitHub                    │
│       └─ 3. Rewrite all URLs to /api/updates/download/:filename       │
│       └─ 4. Return manifest to Tauri client                           │
│                                                                        │
│  [Tauri Client] Signature Verification                                │
│    └─ Verify manifest.platforms[platform].signature                   │
│       └─ Using pubkey from tauri.conf.json                            │
│                                                                        │
│  [Tauri Client] Download & Install                                    │
│    └─ download() → /api/updates/download/:filename (app.tar.gz)       │
│    └─ downloadAndInstall() → extract, replace binary, relaunch        │
│                                                                        │
└────────────────────────────────────────────────────────────────────────┘
```

## Files Modified

- `src/features/updates/updates.router.ts` — Removed darwin `.dmg` override block (lines 88–98)
- No other changes needed; architecture is correct.
