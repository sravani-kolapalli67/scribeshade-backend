import { Router, Request, Response, NextFunction } from "express";

const router = Router();

const REPO = "hiddenmindsolutions/scribeshade-01-frontend";
const REPO_RELEASES_PREFIX = `https://github.com/${REPO}/releases/`;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

type UpdateManifest = {
  version: string;
  notes?: string;
  pub_date?: string;
  platforms: Record<string, { url: string; signature: string }>;
};

function githubHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${GITHUB_TOKEN}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "ScribeShade-UpdateServer/1.0",
  };
}

/**
 * GET /api/updates/latest.json
 *
 * Proxies the Tauri updater manifest from the private GitHub release.
 * Rewrites all platform download URLs to route through /api/updates/download
 * so the unauthenticated Tauri client never hits GitHub directly.
 */
router.get("/latest.json", async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!GITHUB_TOKEN) {
      res.status(503).json({ error: "Update server not configured" });
      return;
    }

    // 1. Fetch latest release metadata
    const releaseRes = await fetch(
      `https://api.github.com/repos/${REPO}/releases/latest`,
      { headers: githubHeaders() }
    );

    if (!releaseRes.ok) {
      res.status(502).json({ error: "Failed to fetch release info from GitHub" });
      return;
    }

    const release = await releaseRes.json() as {
      assets: Array<{ name: string; id: number; url: string }>;
    };

    // 2. Find the latest.json asset
    const asset = release.assets.find((a) => a.name === "latest.json");
    if (!asset) {
      res.status(404).json({ error: "latest.json not found in release assets" });
      return;
    }

    // 3. Download the asset content (requires Accept: application/octet-stream)
    const assetRes = await fetch(asset.url, {
      headers: {
        ...githubHeaders(),
        Accept: "application/octet-stream",
      },
    });

    if (!assetRes.ok) {
      res.status(502).json({ error: "Failed to download latest.json from GitHub" });
      return;
    }

    const manifest = await assetRes.json() as UpdateManifest;

    // 4. Rewrite each platform's download URL to go through this server's
    //    /api/updates/download proxy so the desktop client (which has no
    //    GITHUB_TOKEN) can download from the private repo.
    const proto = req.headers["x-forwarded-proto"] ?? req.protocol;
    const host = req.headers["x-forwarded-host"] ?? req.get("host");
    const base = `${proto}://${host}`;

    for (const platform of Object.keys(manifest.platforms)) {
      const original = manifest.platforms[platform].url;
      manifest.platforms[platform].url =
        `${base}/api/updates/download?url=${encodeURIComponent(original)}`;
    }

    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    res.json(manifest);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/updates/download?url=<encoded-github-release-url>
 *
 * Streams a private GitHub release asset to the Tauri client using the
 * server-side GITHUB_TOKEN.  Only GitHub release URLs for this repo are
 * permitted — all other origins are rejected to prevent open-redirect abuse.
 */
router.get("/download", async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!GITHUB_TOKEN) {
      res.status(503).json({ error: "Update server not configured" });
      return;
    }

    const rawUrl = req.query.url;
    if (typeof rawUrl !== "string" || !rawUrl) {
      res.status(400).json({ error: "Missing or invalid url parameter" });
      return;
    }

    const decoded = decodeURIComponent(rawUrl);

    // Allow-list: only stream release assets from this specific repo.
    if (!decoded.startsWith(REPO_RELEASES_PREFIX)) {
      res.status(403).json({ error: "Forbidden: URL is not a release asset for this repo" });
      return;
    }

    const assetRes = await fetch(decoded, {
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        Accept: "application/octet-stream",
        "User-Agent": "ScribeShade-UpdateServer/1.0",
      },
      redirect: "follow",
    });

    if (!assetRes.ok) {
      res.status(502).json({ error: `GitHub returned ${assetRes.status} for asset download` });
      return;
    }

    // Forward content headers so the Tauri client gets correct metadata
    const contentType = assetRes.headers.get("content-type") ?? "application/octet-stream";
    const contentLength = assetRes.headers.get("content-length");
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "no-cache");
    if (contentLength) res.setHeader("Content-Length", contentLength);

    // Stream bytes directly — never buffer a 100MB+ installer in memory
    if (!assetRes.body) {
      res.status(502).json({ error: "No response body from GitHub" });
      return;
    }
    const reader = assetRes.body.getReader();
    const pump = async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) { res.end(); return; }
        const ok = res.write(value);
        // Respect backpressure — wait for drain before writing more
        if (!ok) await new Promise<void>((resolve) => res.once("drain", resolve));
      }
    };
    await pump();
  } catch (err) {
    next(err);
  }
});

export { router as updatesRouter };
