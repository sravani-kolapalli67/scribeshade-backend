import { Router, Request, Response, NextFunction } from "express";

const router = Router();

const REPO = "hiddenmindsolutions/scribeshade-01-frontend";
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

/**
 * GET /api/updates/latest.json
 *
 * Proxies the Tauri updater manifest (latest.json) from the private GitHub
 * release using a server-side GITHUB_TOKEN so unauthenticated desktop clients
 * can reach it.
 *
 * Tauri updater endpoint in tauri.conf.json should point here.
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
      {
        headers: {
          Authorization: `Bearer ${GITHUB_TOKEN}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "ScribeShade-UpdateServer/1.0",
        },
      }
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
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        Accept: "application/octet-stream",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "ScribeShade-UpdateServer/1.0",
      },
    });

    if (!assetRes.ok) {
      res.status(502).json({ error: "Failed to download latest.json from GitHub" });
      return;
    }

    const manifest = await assetRes.json();

    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    res.json(manifest);
  } catch (err) {
    next(err);
  }
});

export { router as updatesRouter };
