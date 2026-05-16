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

    const manifest = (await assetRes.json()) as UpdateManifest;

    // 4. Rewrite each platform's download URL to go through this server's
    //    /api/updates/download proxy. We match the filename from the manifest
    //    url with the asset ID from the GitHub release metadata so we can
    //    perform an authenticated API download.
    const proto = req.headers["x-forwarded-proto"] ?? req.protocol;
    const host = req.headers["x-forwarded-host"] ?? req.get("host");
    const base = `${proto}://${host}`;

    for (const platform of Object.keys(manifest.platforms)) {
      const originalUrl = manifest.platforms[platform].url;
      let filename = originalUrl.split("/").pop() || "download";
      
      // Feature: For Mac users, prefer the .dmg installer if available,
      // as the .tar.gz in latest.json is intended for the auto-updater.
      if (platform.startsWith("darwin")) {
        const dmgAsset = release.assets.find(a => a.name.endsWith(".dmg"));
        if (dmgAsset) {
          filename = dmgAsset.name;
          const assetId = dmgAsset.id;
          manifest.platforms[platform].url = `${base}/api/updates/download/${encodeURIComponent(filename)}?assetId=${assetId}`;
          continue;
        }
      }

      const assetMatch = release.assets.find((a) => a.name === filename);

      if (assetMatch) {
        // Use path-based filename for better browser compatibility
        manifest.platforms[platform].url = `${base}/api/updates/download/${encodeURIComponent(filename)}?assetId=${assetMatch.id}`;
      } else {
        // Fallback for non-matching assets
        manifest.platforms[platform].url = `${base}/api/updates/download/${encodeURIComponent(filename)}?url=${encodeURIComponent(originalUrl)}`;
      }
    }

    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    res.json(manifest);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/updates/download/:filename
 *
 * Streams a private GitHub release asset to the Tauri client.
 * Using the filename in the path ensures browsers correctly identify the
 * download even if the Content-Disposition header is strictly handled.
 */
router.get("/download/:filename", async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!GITHUB_TOKEN) {
      res.status(503).json({ error: "Update server not configured" });
      return;
    }

    const { assetId, url } = req.query;
    const { filename } = req.params;
    let downloadUrl = "";

    if (assetId) {
      downloadUrl = `https://api.github.com/repos/${REPO}/releases/assets/${assetId}`;
    } else if (typeof url === "string" && url) {
      downloadUrl = decodeURIComponent(url);
      if (!downloadUrl.startsWith(REPO_RELEASES_PREFIX)) {
        res.status(403).json({ error: "Forbidden" });
        return;
      }
    } else {
      res.status(400).json({ error: "Missing asset source" });
      return;
    }

    const assetRes = await fetch(downloadUrl, {
      headers: {
        ...githubHeaders(),
        Accept: "application/octet-stream",
      },
      redirect: "follow",
    });

    if (!assetRes.ok) {
      res.status(assetRes.status === 404 ? 404 : 502).json({
        error: `GitHub returned ${assetRes.status}`,
      });
      return;
    }

    // Forward content headers
    const contentType = assetRes.headers.get("content-type") ?? "application/octet-stream";
    const contentLength = assetRes.headers.get("content-length");
    
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "no-cache");
    // Explicitly set the filename in the attachment header as well
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    if (contentLength) res.setHeader("Content-Length", contentLength);

    if (!assetRes.body) {
      res.status(502).json({ error: "No body" });
      return;
    }

    const reader = assetRes.body.getReader();
    const pump = async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          res.end();
          return;
        }
        if (!res.write(value)) {
          await new Promise<void>((resolve) => res.once("drain", resolve));
        }
      }
    };
    await pump();
  } catch (err) {
    next(err);
  }
});

export { router as updatesRouter };
