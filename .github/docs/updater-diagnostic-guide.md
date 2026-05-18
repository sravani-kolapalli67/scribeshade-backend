# ScribeShade Updater — Diagnostic & Troubleshooting Guide

This guide helps diagnose and resolve issues with the Tauri auto-updater system.

---

## Quick Diagnosis

### 1. Check Backend Endpoint

```bash
# Test the backend proxy endpoint
curl -i https://test.backend.scribeshade.org/api/updates/latest.json
```

**Expected response:**
- Status: `200 OK`
- Content-Type: `application/json`
- Body contains `{ "version": "...", "platforms": { ... } }`

**If 503:**
- Backend is not configured with `GITHUB_TOKEN`
- Check: `echo $GITHUB_TOKEN` on the backend server
- Fix: Add `GITHUB_TOKEN` to environment and restart

**If 404:**
- GitHub release does not have a `latest.json` asset
- Recreate release via GitHub Actions workflow (see below)

**If 502:**
- GitHub API is unreachable or invalid credentials
- Check: Is `GITHUB_TOKEN` valid and has `repo` scope?
- Test: `curl -H "Authorization: Bearer $GITHUB_TOKEN" https://api.github.com/user`

---

### 2. Check Latest Release Assets

```bash
# Fetch latest release from GitHub API
curl -H "Authorization: Bearer $GITHUB_TOKEN" \
  https://api.github.com/repos/hiddenmindsolutions/scribeshade-01-frontend/releases/latest | jq '.assets[] | {name, url}'
```

**Expected assets for macOS:**
- ✅ `ScribeShade_X.X.X_aarch64.app.tar.gz` (Apple Silicon)
- ✅ `ScribeShade_X.X.X_x86_64.app.tar.gz` (Intel)
- ✅ `.sig` files (signatures for each)
- ✅ `latest.json` (Tauri manifest)
- ❌ `.dmg` files (these are for fresh installs, not updates)

**If `.dmg` files exist instead of `.app.tar.gz`:**
- Release was likely created manually or outside the GitHub Actions workflow
- **Solution:** Delete the release and recreate via GitHub Actions

---

### 3. Check Latest.json Content

```bash
# Download the latest.json asset directly
RELEASE_URL=$(curl -s -H "Authorization: Bearer $GITHUB_TOKEN" \
  https://api.github.com/repos/hiddenmindsolutions/scribeshade-01-frontend/releases/latest | \
  jq -r '.assets[] | select(.name=="latest.json") | .url')

curl -H "Authorization: Bearer $GITHUB_TOKEN" \
  -H "Accept: application/octet-stream" \
  "$RELEASE_URL" | jq .
```

**Expected structure:**
```json
{
  "version": "1.1.1",
  "notes": "...",
  "pub_date": "2026-05-18T...",
  "platforms": {
    "darwin-aarch64": {
      "url": "https://github.com/.../ScribeShade_1.1.1_aarch64.app.tar.gz",
      "signature": "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIG1pbmlzaWduIHByaXZhdGUga2V5Ci4uLg=="
    },
    "darwin-x86_64": { /* similar */ },
    "windows-x86_64": { /* similar */ }
  }
}
```

**Red flags:**
- ❌ `"signature": ""` (empty signature)
- ❌ URLs pointing to `.dmg` instead of `.app.tar.gz`
- ❌ Missing platform keys
- ❌ Invalid base64 in signatures

**Fix:** Recreate the release via GitHub Actions.

---

### 4. Check Signature Verification

```bash
# Extract the signature from latest.json
SIGNATURE=$(curl -s https://test.backend.scribeshade.org/api/updates/latest.json | \
  jq -r '.platforms."darwin-aarch64".signature')

# Decode the base64 signature
echo "$SIGNATURE" | base64 -d | head -1
```

**Expected output:**
```
untrusted comment: signature from minisign private key
```

**If it's not base64 or doesn't decode:**
- The signature is invalid or corrupted
- Recreate the release via GitHub Actions

---

### 5. Check Client Configuration (Frontend)

In `src-tauri/tauri.conf.json`:

```json
{
  "plugins": {
    "updater": {
      "endpoints": [
        "https://test.backend.scribeshade.org/api/updates/latest.json"
      ],
      "pubkey": "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDM3MjU2MjVCQkNGRjlENzEKUldSeG5mKzhXMklsTnkyTU5yZEhMLy9sODRGSDMraXJHaGlGM2ZTNllENnZlYWMza3FtSGRiL0kK"
    }
  }
}
```

**Verify:**
- ✅ `endpoints` matches your backend URL
- ✅ `pubkey` is not empty
- ✅ `pubkey` is base64-encoded

**To verify pubkey matches the signing key:**
```bash
# Decode the public key
echo "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDM3MjU2MjVCQkNGRjlENzEKUldSeG5mKzhXMklsTnkyTU5yZEhMLy9sODRGSDMraXJHaGlGM2ZTNllENnZlYWMza3FtSGRiL0kK" | base64 -d
```

**Expected output:**
```
untrusted comment: minisign public key: 37256254BBCFF9D71
RWRxxnf+8W2IlNy2MNrdHL//l84FH3+irGhiF3fS6YD6veac3kqmHdb/I
```

---

## Resolving Common Issues

### Issue: No Update Dialog Appears

**Symptom:** App launches, no update prompt.

**Diagnosis checklist:**
1. Check backend endpoint returns `200 OK`:
   ```bash
   curl -i https://test.backend.scribeshade.org/api/updates/latest.json
   ```
2. Check app has a newer version in `tauri.conf.json`
3. Check browser console for errors (Tauri dev console)

**Common causes:**
- Backend endpoint is down or returning 503/404
- Release version is not newer than app version
- Signature verification failed (mismatched keys)

**Fix:**
- Verify backend is running and `GITHUB_TOKEN` is set
- Verify release `latest.json` has correct signatures
- Increment version number in `tauri.conf.json` and rebuild

---

### Issue: "GitHub returned 451"

**Symptom:** Update download fails with 451 status.

**Cause:** GitHub is rate-limiting the download or the asset URL is invalid.

**Fix:**
- Ensure backend `GITHUB_TOKEN` has `repo` scope
- Verify the asset URL in `latest.json` is correct
- Try downloading directly: `curl -L <asset-url>`

---

### Issue: "Signature verification failed"

**Symptom:** Update downloads but fails to install.

**Diagnosis:**
1. Check public key in `tauri.conf.json` matches the signing key
2. Verify signature in `latest.json` is not empty
3. Check that `.app.tar.gz` (not `.dmg`) is being downloaded

**Fix:**
- Verify `pubkey` in `tauri.conf.json` is correct
- Recreate release via GitHub Actions (ensures correct signatures)

---

## Recreating a Release (Manual Fix)

If the current release has wrong artifacts:

### Option 1: Via GitHub Actions (Recommended)

1. **Delete the problematic release:**
   - Go to GitHub → Releases → select release → Delete

2. **Trigger the workflow:**
   ```bash
   git checkout release
   git pull origin release
   git commit --allow-empty -m "Trigger release workflow"
   git push origin release
   ```

3. **Wait for GitHub Actions to complete** (5–10 minutes)

4. **Verify new release:**
   ```bash
   curl -H "Authorization: Bearer $GITHUB_TOKEN" \
     https://api.github.com/repos/hiddenmindsolutions/scribeshade-01-frontend/releases/latest | \
     jq '.assets[] | {name}'
   ```

### Option 2: Manual Build & Upload

If GitHub Actions is failing:

```bash
# Build locally
pnpm tauri build

# Look for signed artifacts in src-tauri/target/release/bundle
ls -la src-tauri/target/release/bundle/

# You'll see:
# - macos/  → .app folder, dmg, and app.tar.gz
# - msi/    → .msi installer
# - nsis/   → .exe installer

# tauri-action also generates signatures (`.sig` files)
# You need to manually upload these to GitHub Releases
```

---

## Environment Setup (Backend)

Ensure these are set on the backend server:

```bash
# Required
export GITHUB_TOKEN="ghp_xxxxxxxxxxxxxxxxxxxx"  # GitHub Personal Access Token

# Verify it works
curl -H "Authorization: Bearer $GITHUB_TOKEN" https://api.github.com/user
```

**Token requirements:**
- Scope: `repo` (full control of private repositories)
- Can be generated at: https://github.com/settings/tokens/new

---

## Monitoring & Alerting

### Log Updates

To log every update check on the backend:

```typescript
// In updates.router.ts - add logging
console.log(`[updater] ${req.ip} → /api/updates/latest.json`);
console.log(`[updater] Fetched release: ${release.tag_name}`);
console.log(`[updater] Found ${Object.keys(manifest.platforms).length} platforms`);
```

### Health Check Endpoint

Add a health check to verify the updater is working:

```typescript
router.get("/health", async (req, res) => {
  try {
    const releaseRes = await fetch(
      `https://api.github.com/repos/${REPO}/releases/latest`,
      { headers: githubHeaders() }
    );
    
    if (!releaseRes.ok) {
      return res.status(502).json({ status: "error", reason: "GitHub unreachable" });
    }
    
    const release = await releaseRes.json();
    const hasLatestJson = release.assets.some(a => a.name === "latest.json");
    
    res.json({
      status: hasLatestJson ? "ok" : "error",
      latestVersion: release.tag_name,
      assetsCount: release.assets.length,
    });
  } catch (err) {
    res.status(503).json({ status: "error", reason: (err as Error).message });
  }
});
```

---

## References

- [Tauri Updater Docs](https://v2.tauri.app/plugin/updater/)
- [GitHub API — Release Assets](https://docs.github.com/en/rest/releases/assets)
- [Minisign Documentation](https://jedisct1.github.io/minisign/)
