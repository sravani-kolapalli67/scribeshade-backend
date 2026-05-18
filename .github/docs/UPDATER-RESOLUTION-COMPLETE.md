# ScribeShade Tauri Updater — Complete Resolution Guide

**Last Updated:** May 18, 2026  
**Status:** ✅ Backend Implementation Complete | 🔴 GitHub Release Manual Fix Required

---

## Executive Summary

The Tauri auto-updater system has been fully implemented and tested on the backend. The issue preventing users from receiving update prompts is **not a code problem** — it's a **GitHub release artifact problem**:

- ✅ Backend proxy is correctly configured
- ✅ Frontend updater client is correctly implemented
- ✅ Tauri configuration is correct
- ✅ GitHub Actions workflow is correct
- 🔴 **Current GitHub release contains wrong artifact files** (`.dmg` instead of `.app.tar.gz` for macOS)

**Action Required:** Recreate the GitHub release using the GitHub Actions workflow.

---

## What's Been Fixed

### 1. Backend Updates Endpoints (✅ Complete)

**New file:** `src/features/updates/updates.router.ts`

Three endpoints are now available:

| Endpoint | Purpose | Auth | Status |
|----------|---------|------|--------|
| `GET /api/updates/latest.json` | Proxies GitHub release manifest | ❌ None | ✅ Working |
| `GET /api/updates/download/:filename` | Streams app binaries | ❌ None | ✅ Working |
| `GET /api/updates/health` | Health & diagnostics | ❌ None | ✅ NEW |

**Key features:**
- Unauthenticated access (required for Tauri clients)
- GitHub API error handling with detailed diagnostics
- URL rewriting to bypass direct GitHub access from clients
- Stream-based downloads for efficiency

### 2. Health Check Endpoint (✅ Complete)

New `/api/updates/health` endpoint verifies:
- GitHub token is configured
- GitHub API is reachable
- Latest release exists with correct assets
- `latest.json` asset is valid
- All platforms have non-empty signatures

**Usage:**
```bash
curl https://test.backend.scribeshade.org/api/updates/health | jq
```

### 3. Frontend Updater (✅ Already Correct)

`src/lib/updater.ts` is already correctly implemented:
- Calls `@tauri-apps/plugin-updater` on app launch
- Shows update dialog with version & release notes
- Calls `downloadAndInstall()` and `relaunch()` on user confirmation

### 4. Documentation (✅ Complete)

**Created/Updated:**
- `tauri-updater-fix.md` — Architecture and fix overview
- `updater-diagnostic-guide.md` — Step-by-step diagnostic procedures
- `api-reference.md` — New Updates APIs section (v1.9.0)
- `check-updater.sh` — Automated diagnostic script

---

## The Real Issue: GitHub Release Artifacts

### Root Cause

The GitHub release currently contains **fresh install artifacts** instead of **updater artifacts**:

| Platform | Current (❌ Wrong) | Required (✅ Correct) |
|----------|---------------|----------------|
| macOS | `.dmg` files | `.app.tar.gz` files |
| Windows | `.exe` (NSIS installer) | `.msi` or `.exe` |
| Linux | `.AppImage` or `.deb` | `.AppImage` or `.deb` |

**Why this breaks the updater:**
- Tauri's `downloadAndInstall()` expects `.app.tar.gz` on macOS (platform-specific binary archive)
- It cannot extract or apply a `.dmg` file (which is a disk image distribution format)
- The signature in `latest.json` is for the `.app.tar.gz`, not the `.dmg`, so signature verification fails

### Why This Happened

The GitHub release was likely created **outside the GitHub Actions workflow** (manually or via an incomplete CI/CD run). The correct workflow (`tauri-action@v0`) wasn't used, so the proper updater artifacts weren't generated.

---

## How to Fix It

### Step 1: Delete the Problematic Release

1. Go to https://github.com/hiddenmindsolutions/scribeshade-01-frontend/releases
2. Find the current release (likely v1.1.1 or similar)
3. Click the three dots → **Delete**
4. Confirm deletion

### Step 2: Trigger the GitHub Actions Release Workflow

```bash
# Clone repo and switch to release branch
git clone https://github.com/hiddenmindsolutions/scribeshade-01-frontend.git
cd scribeshade-01-frontend
git checkout release
git pull origin release

# Create an empty commit to trigger the workflow
git commit --allow-empty -m "Trigger release workflow — regenerate updater artifacts"

# Push to the release branch
git push origin release
```

### Step 3: Monitor the Workflow

1. Go to https://github.com/hiddenmindsolutions/scribeshade-01-frontend/actions
2. Click the workflow run that just started
3. Wait for it to complete (5–10 minutes)
   - macOS build: ~2–3 minutes
   - Windows build: ~2–3 minutes
   - Artifact upload: ~1 minute

### Step 4: Verify the New Release

Once the workflow completes:

```bash
# Check the release assets
curl -H "Authorization: Bearer $GITHUB_TOKEN" \
  https://api.github.com/repos/hiddenmindsolutions/scribeshade-01-frontend/releases/latest | \
  jq '.assets[] | {name}'
```

**Expected assets:**
- ✅ `ScribeShade_X.X.X_aarch64.app.tar.gz` (Apple Silicon)
- ✅ `ScribeShade_X.X.X_x86_64.app.tar.gz` (Intel)
- ✅ `.sig` files for each
- ✅ `latest.json`
- ❌ NO `.dmg` files

### Step 5: Test on Client

On a macOS user's machine running the old version:

1. Close the app (if running)
2. Reopen the app
3. The updater should show a dialog: "Version X.X.X is available! Update Now / Later"
4. Click "Update Now"
5. Wait ~30 seconds for download and installation
6. App will relaunch with the new version

---

## Verification Checklist

Use the provided diagnostic script to verify everything is working:

```bash
# Make the script executable
chmod +x scripts/check-updater.sh

# Run diagnostics
./scripts/check-updater.sh https://test.backend.scribeshade.org
```

**Expected output:**
```
ScribeShade Updater Diagnostic
Backend: https://test.backend.scribeshade.org
---
[1/6] Testing backend health endpoint...
✓ Backend is healthy
✓ Version: 1.1.1
✓ Platforms: 3

[2/6] Fetching latest.json from backend...
✓ Backend serving latest.json

[3/6] Checking platform download URLs...
✓ darwin-aarch64: accessible
✓ darwin-x86_64: accessible
✓ windows-x86_64: accessible

[4/6] Checking signatures...
✓ darwin-aarch64: signature is valid
✓ darwin-x86_64: signature is valid
✓ windows-x86_64: signature is valid

[5/6] Testing GitHub Token...
✓ GitHub Token valid (authenticated as: hiddenmindsolutions)

[6/6] Verifying GitHub release assets...
✓ Found .app.tar.gz (correct for auto-updater)

---
Diagnostic complete!
✓ All checks passed
```

---

## Backend Configuration

### Environment Variables Required

Ensure these are set on the backend server:

```bash
# GitHub Personal Access Token (with `repo` scope)
export GITHUB_TOKEN="ghp_xxxxxxxxxxxxxxxxxxxx"
```

### Verify Backend is Working

```bash
# Health check
curl https://test.backend.scribeshade.org/api/updates/health

# Download manifest
curl https://test.backend.scribeshade.org/api/updates/latest.json | jq

# Check specific platform
curl https://test.backend.scribeshade.org/api/updates/latest.json | jq '.platforms."darwin-aarch64"'
```

---

## Architecture Diagram

```
┌────────────────────────────────────────────────────────────────┐
│                    User App Launch                              │
│                                                                  │
│  [Frontend] src/lib/updater.ts                                  │
│    └─ useEffect() → checkForUpdates()                           │
│       └─ await @tauri-apps/plugin-updater.check()              │
│          ↓                                                       │
│          HTTPS GET https://test.backend.scribeshade.org/api/updates/latest.json
│          ↓                                                       │
│  [Backend] src/features/updates/updates.router.ts              │
│    └─ GET /api/updates/latest.json                             │
│       ├─ fetch GitHub API (with GITHUB_TOKEN)                  │
│       ├─ get /repos/.../releases/latest                        │
│       ├─ download latest.json asset                            │
│       ├─ rewrite URLs to /api/updates/download/:filename       │
│       └─ return { version, platforms: { ... } }                │
│          ↓                                                       │
│  [Tauri Client] Signature Verification                         │
│    └─ verify signature using pubkey from tauri.conf.json       │
│       ↓                                                         │
│       If update.available == true:                              │
│       ├─ Show dialog with version + release notes              │
│       ├─ User clicks "Update Now"                              │
│       └─ await update.downloadAndInstall()                     │
│          ├─ HTTPS GET /api/updates/download/:filename          │
│          ├─ Receive .app.tar.gz (macOS) or .msi (Windows)      │
│          ├─ Extract to temporary directory                      │
│          ├─ Verify signatures                                  │
│          ├─ Replace running binary                              │
│          └─ relaunch()                                         │
│          ↓                                                       │
│  [App Relaunches with new version] ✓                           │
│                                                                  │
└────────────────────────────────────────────────────────────────┘
```

---

## Troubleshooting

### No Update Dialog Appears

**Diagnosis:**
1. Check backend is responding:
   ```bash
   curl https://test.backend.scribeshade.org/api/updates/health
   ```
2. Check app version is older than release version
3. Check browser console for errors (Tauri dev console)

**Common fixes:**
- Ensure `GITHUB_TOKEN` is set on backend
- Verify GitHub release has `latest.json` asset
- Verify release version > app version

### Update Downloads But Installation Fails

**Diagnosis:**
1. Check signature in `latest.json` is not empty
2. Verify it's a `.app.tar.gz` (not `.dmg`)

**Common fixes:**
- Recreate release via GitHub Actions
- Verify `pubkey` in `tauri.conf.json` matches signing key

### Backend Returns 503

**Issue:** `GITHUB_TOKEN` not configured

**Fix:**
```bash
# On the backend server
export GITHUB_TOKEN="ghp_xxxxxxxxxxxxxxxxxxxx"
# Then restart the backend app
```

---

## Testing Locally (Development)

To test the updater locally without a real release:

```bash
# 1. Increment version in tauri.conf.json
# 2. Build for current platform
pnpm tauri build

# 3. Create a test release on GitHub
# 4. Ensure latest.json has correct updater artifacts

# 5. In WidgetApp.tsx or updater test, modify endpoint to point to test backend
# 6. Manually trigger checkForUpdates() or wait for auto-check on app launch
```

---

## Files Changed

### Backend

| File | Change | Status |
|------|--------|--------|
| `src/features/updates/updates.router.ts` | Added complete implementation | ✅ Complete |
| `src/routes/index.ts` | Already registered (no change) | ✅ Complete |
| `.github/docs/api-reference.md` | Added v1.9.0 Updates APIs section | ✅ Complete |
| `.github/docs/tauri-updater-fix.md` | Added resolution steps & checklist | ✅ Complete |
| `.github/docs/updater-diagnostic-guide.md` | Created comprehensive diagnostic guide | ✅ Complete |
| `scripts/check-updater.sh` | Created automated diagnostic script | ✅ Complete |

### Frontend

| File | Status |
|------|--------|
| `src/lib/updater.ts` | ✅ Already correct, no changes needed |
| `src-tauri/tauri.conf.json` | ✅ Already correct, no changes needed |
| `.github/workflows/release.yml` | ✅ Already correct, no changes needed |

---

## Next Steps

1. **Recreate GitHub release** (delete old, push to release branch)
2. **Wait for GitHub Actions** to complete
3. **Verify release assets** using diagnostic script
4. **Test on client** with next app launch
5. **Monitor logs** for any issues

---

## Support & Monitoring

### Logs to Monitor

**Backend logs:**
- `[updater] ${ip} → /api/updates/latest.json` (request log)
- `[updater] GitHub returned 502` (error log)

**Client logs (Tauri):**
- `Check for updates...` → shows check initiated
- `Update available: vX.X.X` → shows result
- `[updater] check failed: ...` → shows error

### Support Contacts

- **GitHub Issues:** https://github.com/hiddenmindsolutions/scribeshade-01-frontend/issues
- **Tauri Docs:** https://v2.tauri.app/plugin/updater/
- **Backend Logs:** Check backend server logs at `server.log`

---

## Version & Release Notes

**Release:** Tauri Updater System  
**Version:** 1.0.0 (backend) + 1.1.1 (app)  
**Date:** May 18, 2026  
**Status:** Ready for production (pending GitHub release recreation)

