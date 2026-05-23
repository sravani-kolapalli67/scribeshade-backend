import { Router, Request, Response, NextFunction } from "express";
import { createReadStream } from "fs";
import { access, readFile, stat } from "fs/promises";
import path from "path";

const router = Router();

const REPO = "hiddenmindsolutions/scribeshade-01-frontend";
const REPO_RELEASES_PREFIX = `https://github.com/${REPO}/releases/`;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const UPDATER_LOCAL_MODE = process.env.UPDATER_LOCAL_MODE === "true";
const UPDATER_LOCAL_RELEASE_DIR = process.env.UPDATER_LOCAL_RELEASE_DIR;

const REQUIRED_PLATFORM_KEYS = [
  "windows-x86_64",
  "darwin-aarch64",
  "darwin-x86_64",
] as const;
const OPTIONAL_PLATFORM_KEYS = ["linux-x86_64", "darwin-universal"] as const;
const SUPPORTED_PLATFORM_KEYS = new Set<string>([
  ...REQUIRED_PLATFORM_KEYS,
  ...OPTIONAL_PLATFORM_KEYS,
]);

type PlatformInfo = { url: string; signature: string };

type UpdateManifest = {
  version: string;
  notes?: string;
  pub_date?: string;
  platforms: Record<string, PlatformInfo>;
};

type ReleaseAsset = { name: string; id: number; url: string };
type GitHubRelease = { tag_name: string; assets: ReleaseAsset[] };

type ResolvedManifest = {
  manifest: UpdateManifest;
  release?: GitHubRelease;
};

function logEvent(event: string, payload?: Record<string, unknown>): void {
  if (payload) {
    console.log(`[updater] ${event}`, payload);
    return;
  }
  console.log(`[updater] ${event}`);
}

function githubHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${GITHUB_TOKEN}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "ScribeShade-UpdateServer/1.0",
  };
}

function githubBinaryHeaders(): Record<string, string> {
  return {
    ...githubHeaders(),
    Accept: "application/octet-stream",
  };
}

function getBackendBase(req: Request): string {
  const proto = req.headers["x-forwarded-proto"] ?? req.protocol;
  const host = req.headers["x-forwarded-host"] ?? req.get("host");
  return `${proto}://${host}`;
}

function extractFilenameFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.pathname.split("/").pop() || "download";
  } catch {
    const withoutQuery = url.split("?")[0] ?? url;
    return withoutQuery.split("/").pop() || "download";
  }
}

function validateManifest(manifest: UpdateManifest): { ok: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!manifest.version?.trim()) errors.push("version_missing");
  if (!manifest.pub_date?.trim()) errors.push("pub_date_missing");
  if (!manifest.platforms || typeof manifest.platforms !== "object") {
    errors.push("platforms_missing");
    return { ok: false, errors };
  }

  for (const key of REQUIRED_PLATFORM_KEYS) {
    if (!manifest.platforms[key]) errors.push(`platform_missing:${key}`);
  }

  for (const [platform, info] of Object.entries(manifest.platforms)) {
    if (!SUPPORTED_PLATFORM_KEYS.has(platform)) {
      errors.push(`platform_not_supported:${platform}`);
      continue;
    }

    if (!info?.url?.trim()) errors.push(`url_missing:${platform}`);
    if (!info?.signature?.trim()) errors.push(`signature_missing:${platform}`);
    if ((info?.signature?.length ?? 0) <= 50) errors.push(`signature_too_short:${platform}`);
  }

  if (!manifest.platforms["darwin-aarch64"] || !manifest.platforms["darwin-x86_64"]) {
    logEvent("macUpdaterArtifactMissing", {
      hasDarwinArm64: !!manifest.platforms["darwin-aarch64"],
      hasDarwinX64: !!manifest.platforms["darwin-x86_64"],
    });
  }

  return { ok: errors.length === 0, errors };
}

function rewriteManifestUrls(manifest: UpdateManifest, req: Request): UpdateManifest {
  const base = getBackendBase(req);
  const rewritten: UpdateManifest = {
    ...manifest,
    platforms: { ...manifest.platforms },
  };

  for (const platform of Object.keys(rewritten.platforms)) {
    rewritten.platforms[platform] = {
      ...rewritten.platforms[platform],
      url: `${base}/api/updates/download/${encodeURIComponent(platform)}`,
    };
  }

  return rewritten;
}

async function fetchGitHubLatestRelease(): Promise<GitHubRelease> {
  if (!GITHUB_TOKEN) throw new Error("github_token_missing");
  const releaseRes = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: githubHeaders(),
  });

  if (!releaseRes.ok) {
    throw new Error(`github_release_fetch_failed:${releaseRes.status}`);
  }

  const release = (await releaseRes.json()) as GitHubRelease;
  logEvent("githubReleaseResolved", { assetCount: release.assets.length });
  logEvent("githubReleaseTag", { tag: release.tag_name });
  return release;
}

async function readGitHubManifestFromRelease(release: GitHubRelease): Promise<UpdateManifest> {
  const latestJsonAsset = release.assets.find((asset) => asset.name === "latest.json");
  if (!latestJsonAsset) throw new Error("github_manifest_asset_missing");
  logEvent("githubManifestAssetFound", { assetId: latestJsonAsset.id });

  const assetRes = await fetch(latestJsonAsset.url, { headers: githubBinaryHeaders() });
  if (!assetRes.ok) throw new Error(`github_manifest_download_failed:${assetRes.status}`);

  const manifest = (await assetRes.json()) as UpdateManifest;
  for (const key of Object.keys(manifest.platforms || {})) {
    if (manifest.platforms[key]?.signature) {
      logEvent("githubSignatureFound", { platform: key, length: manifest.platforms[key].signature.length });
    }
  }
  return manifest;
}

async function readLocalManifest(): Promise<UpdateManifest> {
  if (!UPDATER_LOCAL_RELEASE_DIR) throw new Error("local_release_dir_missing");
  logEvent("updaterLocalModeEnabled", { releaseDir: UPDATER_LOCAL_RELEASE_DIR });

  const manifestPath = path.join(UPDATER_LOCAL_RELEASE_DIR, "latest.json");
  const raw = await readFile(manifestPath, "utf-8");
  const manifest = JSON.parse(raw) as UpdateManifest;
  logEvent("localManifestLoaded", { manifestPath });
  return manifest;
}

async function resolveManifest(req: Request): Promise<ResolvedManifest> {
  if (UPDATER_LOCAL_MODE) {
    const manifest = await readLocalManifest();
    return { manifest: rewriteManifestUrls(manifest, req) };
  }

  const release = await fetchGitHubLatestRelease();
  const manifest = await readGitHubManifestFromRelease(release);
  return {
    release,
    manifest: rewriteManifestUrls(manifest, req),
  };
}

async function resolveLocalArtifactPath(platform: string): Promise<{ filePath: string; filename: string }> {
  if (!UPDATER_LOCAL_RELEASE_DIR) throw new Error("local_release_dir_missing");

  const manifest = await readLocalManifest();
  const platformEntry = manifest.platforms[platform];
  if (!platformEntry?.url) {
    logEvent("localArtifactMissing", { platform, reason: "platform_url_missing" });
    throw new Error("local_platform_missing");
  }

  const filename = extractFilenameFromUrl(platformEntry.url);
  const filePath = path.resolve(UPDATER_LOCAL_RELEASE_DIR, filename);
  try {
    await access(filePath);
  } catch {
    logEvent("localArtifactMissing", { platform, filename, filePath });
    throw new Error("local_artifact_missing");
  }

  logEvent("localArtifactResolved", { platform, filename, filePath });
  return { filePath, filename };
}

function streamFileResponse(res: Response, filePath: string, filename: string): void {
  const stream = createReadStream(filePath);
  res.setHeader("Content-Type", "application/octet-stream");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);

  stream.on("error", () => {
    if (!res.headersSent) {
      res.status(500).json({ error: "Failed to stream local artifact" });
    } else {
      res.end();
    }
  });

  stream.pipe(res);
}

async function resolveGitHubAssetForPlatform(platform: string): Promise<{ release: GitHubRelease; asset: ReleaseAsset; filename: string }> {
  const release = await fetchGitHubLatestRelease();
  const manifest = await readGitHubManifestFromRelease(release);
  const platformEntry = manifest.platforms[platform];

  if (!platformEntry?.url) {
    throw new Error(`github_platform_missing:${platform}`);
  }

  const filename = extractFilenameFromUrl(platformEntry.url);
  const asset = release.assets.find((a) => a.name === filename);
  if (!asset) {
    throw new Error(`github_asset_not_found:${platform}:${filename}`);
  }

  logEvent("githubDownloadAssetResolved", {
    platform,
    filename,
    assetId: asset.id,
    tag: release.tag_name,
  });

  return { release, asset, filename };
}

router.get("/latest.json", async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!UPDATER_LOCAL_MODE && !GITHUB_TOKEN) {
      res.status(503).json({ error: "Update server not configured" });
      return;
    }

    const { manifest } = await resolveManifest(req);
    const validation = validateManifest(manifest);
    if (!validation.ok) {
      res.status(502).json({ error: "Invalid updater manifest", details: validation.errors });
      return;
    }

    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    res.json(manifest);
  } catch (err) {
    next(err);
  }
});

router.get("/download/:platform", async (req: Request, res: Response) => {
  const rawPlatform = req.params.platform;
  const platform = Array.isArray(rawPlatform) ? rawPlatform[0] : rawPlatform;

  if (!platform || !SUPPORTED_PLATFORM_KEYS.has(platform)) {
    res.status(400).json({ error: "Unsupported platform key" });
    return;
  }

  try {
    if (UPDATER_LOCAL_MODE) {
      const { filePath, filename } = await resolveLocalArtifactPath(platform);
      logEvent("localArtifactStreamStarted", { platform, filename, filePath });
      streamFileResponse(res, filePath, filename);
      return;
    }

    if (!GITHUB_TOKEN) {
      res.status(503).json({ error: "Update server not configured" });
      return;
    }

    const { asset, filename } = await resolveGitHubAssetForPlatform(platform);
    const downloadUrl = `https://api.github.com/repos/${REPO}/releases/assets/${asset.id}`;

    if (!downloadUrl.startsWith(REPO_RELEASES_PREFIX) && !downloadUrl.includes("api.github.com/repos")) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    const assetRes = await fetch(downloadUrl, {
      headers: githubBinaryHeaders(),
      redirect: "follow",
    });

    if (!assetRes.ok || !assetRes.body) {
      logEvent("githubAssetProxyStreamFailed", { platform, status: assetRes.status });
      res.status(assetRes.status === 404 ? 404 : 502).json({ error: `GitHub returned ${assetRes.status}` });
      return;
    }

    logEvent("githubAssetProxyStreamStarted", { platform, filename, assetId: asset.id });

    const contentLength = assetRes.headers.get("content-length");
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    if (contentLength) res.setHeader("Content-Length", contentLength);

    const reader = assetRes.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        res.end();
        break;
      }
      if (!res.write(value)) {
        await new Promise<void>((resolve) => res.once("drain", resolve));
      }
    }
  } catch (err) {
    logEvent("githubAssetProxyStreamFailed", { platform, reason: (err as Error).message });
    res.status(500).json({ error: "Failed to proxy updater artifact" });
  }
});

router.get("/health", async (req: Request, res: Response) => {
  const checks: Record<string, unknown> = {
    mode: UPDATER_LOCAL_MODE ? "local" : "github",
    timestamp: new Date().toISOString(),
  };

  try {
    if (UPDATER_LOCAL_MODE) {
      checks.localReleaseDir = UPDATER_LOCAL_RELEASE_DIR || "missing";
      const { manifest } = await resolveManifest(req);
      const validation = validateManifest(manifest);
      checks.manifestValidation = validation;

      for (const platform of REQUIRED_PLATFORM_KEYS) {
        try {
          const { filePath } = await resolveLocalArtifactPath(platform);
          const info = await stat(filePath);
          checks[`artifact_${platform}`] = { ok: true, size: info.size };
        } catch (error) {
          checks[`artifact_${platform}`] = { ok: false, error: (error as Error).message };
        }
      }

      const ok = validation.ok && REQUIRED_PLATFORM_KEYS.every((p) => (checks[`artifact_${p}`] as { ok: boolean } | undefined)?.ok);
      res.status(ok ? 200 : 502).json({ status: ok ? "ok" : "error", checks });
      return;
    }

    checks.githubToken = GITHUB_TOKEN ? "present" : "missing";
    if (!GITHUB_TOKEN) {
      res.status(503).json({ status: "error", checks });
      return;
    }

    const { manifest, release } = await resolveManifest(req);
    checks.latestReleaseTag = release?.tag_name;
    checks.manifestVersion = manifest.version;

    const validation = validateManifest(manifest);
    checks.manifestValidation = validation;

    for (const platform of REQUIRED_PLATFORM_KEYS) {
      try {
        const { asset } = await resolveGitHubAssetForPlatform(platform);
        checks[`artifact_${platform}`] = { ok: true, assetId: asset.id, name: asset.name };
      } catch (error) {
        checks[`artifact_${platform}`] = { ok: false, error: (error as Error).message };
      }
    }

    checks.backendDownloadUrlShape = Object.fromEntries(
      REQUIRED_PLATFORM_KEYS.map((platform) => [
        platform,
        manifest.platforms[platform]?.url?.includes(`/api/updates/download/${platform}`) || false,
      ]),
    );

    const requiredArtifactsOk = REQUIRED_PLATFORM_KEYS.every(
      (p) => (checks[`artifact_${p}`] as { ok: boolean } | undefined)?.ok,
    );
    const ok = validation.ok && requiredArtifactsOk;
    res.status(ok ? 200 : 502).json({ status: ok ? "ok" : "error", checks });
  } catch (err) {
    res.status(500).json({ status: "error", checks: { ...checks, exception: (err as Error).message } });
  }
});

export { router as updatesRouter };
