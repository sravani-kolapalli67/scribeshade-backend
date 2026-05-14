/**
 * AI-Projects Playwright PDF Export
 *
 * Renders all generated projects for a record into a single structured A4 PDF
 * using the shared Chromium instance from the resume builder.
 */

import path from "path";
import fs   from "fs";
import { prisma } from "../../shared/lib/prisma";
import { AppError } from "../../shared/middleware/error.middleware";
import {
  getSharedBrowser,
  PDF_PRINT_CSS,
} from "../resume/resume.builder.service";

// ─── Types ────────────────────────────────────────────────────────────────────

interface Section {
  key:      string;
  type:     string;
  title:    string;
  subtitle?: string;
  content:  unknown;
}

interface ProjectHeader {
  title:    string;
  tagline?: string;
  domain?:  string;
  duration?: string;
  teamSize?: string;
  role?:    string;
}

interface GeneratedProject {
  projectHeader: ProjectHeader;
  sections:      Section[];
  scope_limited?:       boolean;
  credibility_warning?: boolean;
}

// ─── HTML builder ─────────────────────────────────────────────────────────────

function esc(str: string): string {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderSection(sec: Section): string {
  const { type, content } = sec;

  try {
    switch (type) {
      // ── bullets ─────────────────────────────────────────────────
      case "bullets":
      case "quote_cards": {
        const items = Array.isArray(content) ? (content as string[]) : [];
        return `<ul class="bullet-list">${items.map((b) => `<li>${esc(b)}</li>`).join("")}</ul>`;
      }

      // ── narrative ───────────────────────────────────────────────
      case "narrative": {
        const text = typeof content === "string" ? content : JSON.stringify(content);
        return text
          .split(/\n+/)
          .filter(Boolean)
          .map((p) => `<p>${esc(p)}</p>`)
          .join("");
      }

      // ── how_to_explain ──────────────────────────────────────────
      case "how_to_explain": {
        const c = content as { elevatorPitch?: string; detailedExplanation?: string };
        return `
          <div class="kv-block">
            <div class="kv-row"><span class="kv-label">Elevator Pitch</span><span class="kv-value">${esc(c.elevatorPitch ?? "")}</span></div>
            <div class="kv-row"><span class="kv-label">Detailed</span><span class="kv-value">${esc(c.detailedExplanation ?? "")}</span></div>
          </div>`;
      }

      // ── star_story ──────────────────────────────────────────────
      case "star_story": {
        const c = content as { situation?: string; task?: string; action?: string; result?: string };
        return `
          <div class="kv-block">
            ${["situation","task","action","result"].map((k) =>
              `<div class="kv-row"><span class="kv-label">${k.charAt(0).toUpperCase()+k.slice(1)}</span><span class="kv-value">${esc((c as Record<string,string>)[k] ?? "")}</span></div>`
            ).join("")}
          </div>`;
      }

      // ── thirty_second_summary ───────────────────────────────────
      case "thirty_second_summary": {
        const c = content as { hook?: string; mainPoints?: string[]; closingLine?: string };
        return `
          <p><strong>Hook:</strong> ${esc(c.hook ?? "")}</p>
          <ul class="bullet-list">${(c.mainPoints ?? []).map((p) => `<li>${esc(p)}</li>`).join("")}</ul>
          <p><em>${esc(c.closingLine ?? "")}</em></p>`;
      }

      // ── metadata ────────────────────────────────────────────────
      case "metadata": {
        const c = content as { fields?: { label: string; value: string }[] };
        const fields = Array.isArray(c?.fields) ? c.fields : [];
        return `<div class="kv-block">${fields.map((f) =>
          `<div class="kv-row"><span class="kv-label">${esc(f.label)}</span><span class="kv-value">${esc(f.value)}</span></div>`
        ).join("")}</div>`;
      }

      // ── code_block ──────────────────────────────────────────────
      case "code_block": {
        const text = typeof content === "string" ? content : JSON.stringify(content, null, 2);
        return `<pre class="code-block"><code>${esc(text)}</code></pre>`;
      }

      // ── tech_tags ───────────────────────────────────────────────
      case "tech_tags": {
        const cats = Array.isArray(content)
          ? (content as { category: string; tags: string[] }[])
          : [];
        return cats.map((cat) => `
          <div class="tech-cat">
            <span class="tech-cat-label">${esc(cat.category)}</span>
            <span class="tech-tags">${cat.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join("")}</span>
          </div>`).join("");
      }

      // ── key_value_pairs ─────────────────────────────────────────
      case "key_value_pairs": {
        const items = Array.isArray(content)
          ? (content as { key: string; value: string }[])
          : [];
        return `<div class="kv-block">${items.map((i) =>
          `<div class="kv-row"><span class="kv-label">${esc(i.key)}</span><span class="kv-value">${esc(i.value)}</span></div>`
        ).join("")}</div>`;
      }

      // ── steps ───────────────────────────────────────────────────
      case "steps": {
        const items = Array.isArray(content)
          ? (content as { step: string; description: string }[])
          : [];
        return `<ol class="steps-list">${items.map((s, i) =>
          `<li><strong>${i + 1}. ${esc(s.step)}</strong> — ${esc(s.description)}</li>`
        ).join("")}</ol>`;
      }

      // ── challenge_cards ─────────────────────────────────────────
      case "challenge_cards": {
        const items = Array.isArray(content)
          ? (content as { challenge: string; solution: string }[])
          : [];
        return items.map((c) => `
          <div class="challenge-card">
            <div class="challenge-head">⚡ ${esc(c.challenge)}</div>
            <div class="challenge-body">✅ ${esc(c.solution)}</div>
          </div>`).join("");
      }

      // ── cards ───────────────────────────────────────────────────
      case "cards": {
        const items = Array.isArray(content)
          ? (content as { title: string; body: string; badge?: string }[])
          : [];
        return `<div class="cards-grid">${items.map((c) => `
          <div class="card">
            ${c.badge ? `<span class="badge">${esc(c.badge)}</span>` : ""}
            <div class="card-title">${esc(c.title)}</div>
            <div class="card-body">${esc(c.body)}</div>
          </div>`).join("")}</div>`;
      }

      // ── table ───────────────────────────────────────────────────
      case "table": {
        const c = content as { headers?: string[]; rows?: string[][] };
        const headers = Array.isArray(c?.headers) ? c.headers : [];
        const rows    = Array.isArray(c?.rows)    ? c.rows    : [];
        return `
          <table class="data-table">
            <thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead>
            <tbody>${rows.map((row) =>
              `<tr>${row.map((cell) => `<td>${esc(cell)}</td>`).join("")}</tr>`
            ).join("")}</tbody>
          </table>`;
      }

      // ── timeline ────────────────────────────────────────────────
      case "timeline": {
        const items = Array.isArray(content)
          ? (content as { date: string; event: string; description: string }[])
          : [];
        return `<div class="timeline">${items.map((i) => `
          <div class="timeline-item">
            <div class="tl-date">${esc(i.date)}</div>
            <div class="tl-body"><strong>${esc(i.event)}</strong> — ${esc(i.description)}</div>
          </div>`).join("")}</div>`;
      }

      // ── metrics ─────────────────────────────────────────────────
      case "metrics": {
        const items = Array.isArray(content)
          ? (content as { metric: string; value: string; description: string; before?: string; after?: string }[])
          : [];
        return `<div class="metrics-grid">${items.map((m) => `
          <div class="metric-card">
            <div class="metric-value">${esc(m.value)}</div>
            <div class="metric-label">${esc(m.metric)}</div>
            <div class="metric-desc">${esc(m.description)}</div>
            ${m.before ? `<div class="metric-change"><span class="before">${esc(m.before)}</span> → <span class="after">${esc(m.after ?? m.value)}</span></div>` : ""}
          </div>`).join("")}</div>`;
      }

      // ── comparison_table ────────────────────────────────────────
      case "comparison_table": {
        const items = Array.isArray(content)
          ? (content as { decision: string; winner: string; loser: string; rationale: string }[])
          : [];
        return `
          <table class="data-table">
            <thead><tr><th>Decision</th><th>Chosen</th><th>Alternative</th><th>Rationale</th></tr></thead>
            <tbody>${items.map((r) =>
              `<tr><td>${esc(r.decision)}</td><td class="winner">${esc(r.winner)}</td><td>${esc(r.loser)}</td><td>${esc(r.rationale)}</td></tr>`
            ).join("")}</tbody>
          </table>`;
      }

      // ── code_snippets ───────────────────────────────────────────
      case "code_snippets": {
        const items = Array.isArray(content)
          ? (content as { title: string; language: string; purpose: string; code: string }[])
          : [];
        return items.map((s) => `
          <div class="snippet-block">
            <div class="snippet-meta">${esc(s.title)} <span class="snippet-lang">${esc(s.language)}</span></div>
            <p class="snippet-purpose">${esc(s.purpose)}</p>
            <pre class="code-block"><code>${esc(s.code)}</code></pre>
          </div>`).join("");
      }

      // ── architecture_tree ───────────────────────────────────────
      case "architecture_tree": {
        const c = content as { layers?: { name: string; nodes: { name: string; description: string; tech: string; children?: { name: string; description: string }[] }[] }[] };
        const layers = Array.isArray(c?.layers) ? c.layers : [];
        return layers.map((layer) => `
          <div class="arch-layer">
            <div class="arch-layer-name">${esc(layer.name)}</div>
            <div class="arch-nodes">${layer.nodes.map((n) => `
              <div class="arch-node">
                <strong>${esc(n.name)}</strong>
                <span class="arch-tech">${esc(n.tech)}</span>
                <p>${esc(n.description)}</p>
                ${n.children?.length ? `<ul>${n.children.map((c) => `<li><strong>${esc(c.name)}</strong>: ${esc(c.description)}</li>`).join("")}</ul>` : ""}
              </div>`).join("")}
            </div>
          </div>`).join("");
      }

      // ── fallback ────────────────────────────────────────────────
      default: {
        const text = typeof content === "string" ? content : JSON.stringify(content, null, 2);
        return `<pre class="code-block"><code>${esc(text)}</code></pre>`;
      }
    }
  } catch {
    return `<p class="render-error">⚠ Could not render this section</p>`;
  }
}

function buildProjectsHtml(
  record: { position: string; jobDescription: string; createdAt: Date },
  projects: GeneratedProject[],
): string {
  const projectsHtml = projects
    .map((proj, idx) => {
      const sectionsHtml = (proj.sections ?? [])
        .map((sec) => `
          <div class="section-card">
            <h3 class="section-title">${esc(sec.title ?? sec.key)}</h3>
            ${sec.subtitle ? `<p class="section-subtitle">${esc(sec.subtitle)}</p>` : ""}
            <div class="section-content">${renderSection(sec)}</div>
          </div>`)
        .join("");

      const hdr = proj.projectHeader ?? ({} as ProjectHeader);
      const coverMetaParts = [
        hdr.role     ? `<span class="meta-chip">Role: ${esc(hdr.role)}</span>`         : "",
        hdr.domain   ? `<span class="meta-chip">Domain: ${esc(hdr.domain)}</span>`     : "",
        hdr.duration ? `<span class="meta-chip">Duration: ${esc(hdr.duration)}</span>` : "",
        hdr.teamSize ? `<span class="meta-chip">Team: ${esc(hdr.teamSize)}</span>`     : "",
      ].filter(Boolean).join("");

      return `
        <div class="project-block ${idx > 0 ? "page-break" : ""}">
          ${idx > 0 ? `<div class="page-break-spacer"></div>` : ""}
          <div class="project-cover">
            <div class="project-number">Project ${idx + 1}</div>
            <h2 class="project-title">${esc(hdr.title || `Project ${idx + 1}`)}</h2>
            ${hdr.tagline ? `<p class="project-tagline">${esc(hdr.tagline)}</p>` : ""}
            <div class="project-meta">${coverMetaParts}</div>
          </div>
          <div class="sections-wrapper">${sectionsHtml}</div>
        </div>`;
    })
    .join("");

  const generatedDate = new Date(record.createdAt).toLocaleDateString("en-US", {
    year: "numeric", month: "long", day: "numeric",
  });

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${esc(record.position)} — AI Projects</title>
  <style>
    /* ── Reset & base ── */
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, "Segoe UI", Helvetica, Arial, sans-serif;
      font-size: 11.5px;
      line-height: 1.6;
      color: #1a1a2e;
      background: #fff;
      padding: 0;
    }

    /* ── Page layout ── */
    @page { size: A4; margin: 18mm 16mm; }

    /* ── Cover / report header ── */
    .report-header {
      padding: 28px 32px 20px;
      background: linear-gradient(135deg, #1a1a2e 0%, #16213e 60%, #0f3460 100%);
      color: #fff;
      margin-bottom: 0;
    }
    .report-header .report-label {
      font-size: 10px;
      letter-spacing: 2px;
      text-transform: uppercase;
      color: rgba(255,255,255,.55);
      margin-bottom: 8px;
    }
    .report-header h1 {
      font-size: 22px;
      font-weight: 700;
      margin-bottom: 6px;
    }
    .report-header .report-meta {
      font-size: 10.5px;
      color: rgba(255,255,255,.65);
    }

    /* ── Project block ── */
    .project-block { padding: 0 0 32px; }
    .page-break { page-break-before: always; break-before: page; }
    .page-break-spacer { height: 8px; }

    /* ── Project cover ── */
    .project-cover {
      padding: 24px 32px 20px;
      background: #f8f9fe;
      border-left: 4px solid #5b4fcf;
      margin-bottom: 20px;
    }
    .project-number {
      font-size: 9.5px;
      font-weight: 700;
      letter-spacing: 2px;
      text-transform: uppercase;
      color: #5b4fcf;
      margin-bottom: 6px;
    }
    h2.project-title {
      font-size: 18px;
      font-weight: 700;
      color: #1a1a2e;
      margin-bottom: 6px;
    }
    .project-tagline {
      font-size: 12px;
      color: #4a4a6a;
      margin-bottom: 10px;
      font-style: italic;
    }
    .project-meta { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 10px; }
    .meta-chip {
      font-size: 9.5px;
      background: #ede9ff;
      color: #5b4fcf;
      padding: 2px 8px;
      border-radius: 12px;
    }
    .cover-tags { display: flex; flex-wrap: wrap; gap: 4px; }

    /* ── Sections ── */
    .sections-wrapper { padding: 0 32px; }
    .section-card {
      margin-bottom: 16px;
      padding: 14px 16px;
      border: 1px solid #e8e8f0;
      border-radius: 6px;
      break-inside: avoid;
    }
    h3.section-title {
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: .8px;
      color: #5b4fcf;
      margin-bottom: 3px;
      break-after: avoid;
    }
    .section-subtitle {
      font-size: 9.5px;
      color: #7a7a9a;
      margin-bottom: 8px;
    }
    .section-content { font-size: 11px; color: #2c2c44; }

    /* ── bullets ── */
    ul.bullet-list { padding-left: 18px; }
    ul.bullet-list li { margin-bottom: 3px; }

    /* ── steps ── */
    ol.steps-list { padding-left: 18px; }
    ol.steps-list li { margin-bottom: 5px; }

    /* ── kv ── */
    .kv-block { display: flex; flex-direction: column; gap: 5px; }
    .kv-row { display: flex; gap: 10px; }
    .kv-label { font-weight: 600; min-width: 120px; color: #5b4fcf; flex-shrink: 0; }
    .kv-value { flex: 1; color: #2c2c44; }

    /* ── tech tags ── */
    .tech-cat { display: flex; align-items: flex-start; gap: 8px; margin-bottom: 5px; }
    .tech-cat-label { font-weight: 600; min-width: 100px; flex-shrink: 0; color: #4a4a6a; }
    .tech-tags { display: flex; flex-wrap: wrap; gap: 4px; }
    .tag {
      font-size: 9.5px;
      background: #f0eeff;
      color: #5b4fcf;
      padding: 1.5px 7px;
      border-radius: 10px;
      white-space: nowrap;
    }

    /* ── code ── */
    pre.code-block {
      background: #1e1e2e;
      color: #cdd6f4;
      padding: 12px 14px;
      border-radius: 5px;
      font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
      font-size: 9.5px;
      line-height: 1.5;
      overflow: hidden;
      white-space: pre-wrap;
      word-break: break-all;
      break-inside: avoid;
    }

    /* ── table ── */
    .data-table { width: 100%; border-collapse: collapse; font-size: 10.5px; }
    .data-table th { background: #f0eeff; color: #5b4fcf; padding: 6px 8px; text-align: left; font-size: 9.5px; text-transform: uppercase; letter-spacing: .5px; }
    .data-table td { padding: 5px 8px; border-bottom: 1px solid #eee; vertical-align: top; }
    .data-table .winner { color: #16a34a; font-weight: 600; }

    /* ── challenge cards ── */
    .challenge-card { margin-bottom: 8px; padding: 8px 12px; border-radius: 5px; background: #fafafa; border-left: 3px solid #f59e0b; break-inside: avoid; }
    .challenge-head { font-weight: 600; margin-bottom: 3px; color: #92400e; }
    .challenge-body { color: #2c2c44; }

    /* ── cards grid ── */
    .cards-grid { display: flex; flex-wrap: wrap; gap: 8px; }
    .card { flex: 1 1 calc(50% - 4px); min-width: 180px; padding: 10px 12px; border: 1px solid #e8e8f0; border-radius: 5px; break-inside: avoid; }
    .card-title { font-weight: 600; margin-bottom: 4px; font-size: 10.5px; }
    .card-body { font-size: 10px; color: #4a4a6a; }
    .badge { font-size: 9px; background: #ede9ff; color: #5b4fcf; padding: 1px 6px; border-radius: 10px; float: right; margin-left: 6px; }

    /* ── timeline ── */
    .timeline { display: flex; flex-direction: column; gap: 8px; }
    .timeline-item { display: flex; gap: 10px; }
    .tl-date { min-width: 80px; font-size: 9.5px; font-weight: 600; color: #5b4fcf; }
    .tl-body { flex: 1; }

    /* ── metrics ── */
    .metrics-grid { display: flex; flex-wrap: wrap; gap: 8px; }
    .metric-card { flex: 1 1 calc(33% - 6px); min-width: 120px; padding: 10px; border: 1px solid #e8e8f0; border-radius: 5px; text-align: center; break-inside: avoid; }
    .metric-value { font-size: 18px; font-weight: 700; color: #5b4fcf; }
    .metric-label { font-size: 9.5px; font-weight: 600; color: #1a1a2e; margin: 2px 0; }
    .metric-desc { font-size: 9px; color: #7a7a9a; }
    .metric-change { font-size: 9.5px; margin-top: 4px; }
    .before { color: #ef4444; }
    .after  { color: #16a34a; }

    /* ── snippet ── */
    .snippet-block { margin-bottom: 12px; break-inside: avoid; }
    .snippet-meta { font-weight: 600; font-size: 10.5px; margin-bottom: 3px; }
    .snippet-lang { font-size: 9px; background: #e0e7ff; color: #4338ca; padding: 1px 6px; border-radius: 8px; margin-left: 6px; }
    .snippet-purpose { font-size: 10px; color: #4a4a6a; margin-bottom: 5px; }

    /* ── arch tree ── */
    .arch-layer { margin-bottom: 10px; }
    .arch-layer-name { font-weight: 700; font-size: 10px; text-transform: uppercase; letter-spacing: .5px; color: #5b4fcf; margin-bottom: 5px; }
    .arch-nodes { display: flex; flex-wrap: wrap; gap: 8px; }
    .arch-node { flex: 1 1 calc(50% - 4px); min-width: 160px; padding: 8px 10px; border: 1px solid #e0e7ff; border-radius: 4px; }
    .arch-tech { font-size: 9px; background: #f0eeff; color: #5b4fcf; padding: 1px 6px; border-radius: 8px; margin-left: 6px; }

    /* ── misc ── */
    .render-error { color: #ef4444; font-size: 10px; }
    p { margin-bottom: 6px; }

    ${PDF_PRINT_CSS}
  </style>
</head>
<body>
  <div class="report-header">
    <div class="report-label">AI Projects Report</div>
    <h1>${esc(record.position)}</h1>
    <div class="report-meta">Generated ${generatedDate} &nbsp;·&nbsp; ${projects.length} project${projects.length !== 1 ? "s" : ""}</div>
  </div>

  ${projectsHtml}
</body>
</html>`;
}

// ─── Main export function ─────────────────────────────────────────────────────

const EXPORTS_DIR = path.resolve(process.cwd(), "uploads/exports");
const PDF_TIMEOUT = 45_000;

export async function exportProjectsToPdf(
  projectRecordId: string,
  userId: string,
): Promise<{ buffer: Buffer; filename: string }> {
  // 1. Fetch record and verify ownership
  const record = await prisma.project.findUnique({
    where: { id: projectRecordId },
  });

  if (!record) {
    throw new AppError(404, "Project record not found");
  }

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user || record.userId !== userId) {
    throw new AppError(403, "Access denied");
  }

  const projectsRaw = record.projects;
  let projects: GeneratedProject[] = [];
  if (Array.isArray(projectsRaw)) {
    projects = projectsRaw as unknown as GeneratedProject[];
  } else if (typeof projectsRaw === "object" && projectsRaw !== null) {
    projects = [projectsRaw as unknown as GeneratedProject];
  }

  if (projects.length === 0) {
    throw new AppError(422, "No projects found in this record");
  }

  // 2. Build HTML
  const html = buildProjectsHtml(
    { position: record.position, jobDescription: record.jobDescription, createdAt: record.createdAt },
    projects,
  );

  // 3. Ensure exports dir exists
  if (!fs.existsSync(EXPORTS_DIR)) {
    fs.mkdirSync(EXPORTS_DIR, { recursive: true });
  }

  // 4. Render PDF via shared Playwright browser
  let browser: Awaited<ReturnType<typeof getSharedBrowser>> | null = null;
  const timeoutHandle = setTimeout(() => {
    throw new AppError(504, "PDF generation timed out");
  }, PDF_TIMEOUT);

  try {
    browser = await getSharedBrowser();
    const ctx  = await browser.newContext();
    const page = await ctx.newPage();

    // Block external network requests — only allow data: and blob:
    await page.route("**/*", (route: import('playwright').Route) => {
      const url = route.request().url();
      if (url.startsWith("data:") || url.startsWith("blob:")) {
        route.continue();
      } else {
        route.abort();
      }
    });

    await page.emulateMedia({ media: "print" });
    await page.setContent(html, { waitUntil: "domcontentloaded" });

    const pdfBytes = await page.pdf({
      format:          "A4",
      printBackground: true,
    });

    await ctx.close();
    clearTimeout(timeoutHandle);

    const filename = `projects_${projectRecordId}_${Date.now()}.pdf`;
    const filePath = path.join(EXPORTS_DIR, filename);
    fs.writeFileSync(filePath, pdfBytes);

    return { buffer: Buffer.from(pdfBytes), filename };
  } catch (err) {
    clearTimeout(timeoutHandle);
    if (err instanceof AppError) throw err;
    throw new AppError(500, `PDF generation failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
