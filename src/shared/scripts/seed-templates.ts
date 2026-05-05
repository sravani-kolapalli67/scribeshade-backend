/**
 * Seed script — inserts three default resume templates (Classic, Modern, Minimal)
 * if they do not already exist (idempotent by name).
 *
 * Run with:
 *   pnpm seed:templates
 *   — or —
 *   tsx src/shared/scripts/seed-templates.ts
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// ─── Template HTML ─────────────────────────────────────────────────────────────
// Templates use data-field and data-list attributes so the client-side
// populateTemplate() utility can hydrate them with user data.

const CLASSIC_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: "Georgia", serif; font-size: 11pt; color: #1a1a1a; background: #fff; max-width: 800px; margin: 0 auto; padding: 32px 40px; }
  .header { text-align: center; border-bottom: 2px solid #2c3e50; padding-bottom: 14px; margin-bottom: 22px; }
  .header h1 { font-size: 26pt; letter-spacing: 1px; color: #2c3e50; }
  .header .role { font-size: 13pt; color: #555; margin-top: 4px; }
  .header .contact { font-size: 9.5pt; color: #666; margin-top: 8px; }
  .section { margin-bottom: 18px; }
  .section-title { font-size: 12pt; font-weight: bold; text-transform: uppercase; letter-spacing: 1px; color: #2c3e50; border-bottom: 1px solid #ccc; padding-bottom: 4px; margin-bottom: 10px; }
  .entry { margin-bottom: 10px; }
  .entry .title { font-weight: bold; }
  .entry .subtitle { color: #555; font-size: 10pt; }
  ul { padding-left: 18px; }
  ul li { margin-bottom: 3px; }
  .skills-grid { display: flex; flex-wrap: wrap; gap: 6px; }
  .skill-chip { background: #eef2f7; border-radius: 3px; padding: 2px 8px; font-size: 9.5pt; }
</style>
</head>
<body>
  <div class="header">
    <h1 data-field="name">Your Name</h1>
    <div class="role" data-field="role">Your Role</div>
    <div class="contact">
      <span data-field="email">email@example.com</span> &nbsp;|&nbsp;
      <span data-field="phone">+1 234 567 8901</span> &nbsp;|&nbsp;
      <span data-field="location">City, Country</span> &nbsp;|&nbsp;
      <span data-field="links">github.com/you</span>
    </div>
  </div>

  <div class="section" id="section-summary">
    <div class="section-title">Professional Summary</div>
    <p data-field="summary">A results-driven professional...</p>
  </div>

  <div class="section" id="section-experience">
    <div class="section-title">Work Experience</div>
    <div data-field="experience">Company | Role | Date\n• Achievement 1\n• Achievement 2</div>
  </div>

  <div class="section" id="section-skills">
    <div class="section-title">Skills</div>
    <div><strong>Languages:</strong> <span data-field="skillsLanguages">JavaScript, TypeScript</span></div>
    <div><strong>Frameworks:</strong> <span data-field="skillsFrameworks">React, Node.js</span></div>
    <div><strong>Databases:</strong> <span data-field="skillsDatabases">PostgreSQL, Redis</span></div>
    <div><strong>Tools:</strong> <span data-field="skillsTools">Docker, AWS</span></div>
  </div>

  <div class="section" id="section-projects">
    <div class="section-title">Projects</div>
    <div data-field="projects">Project Name\n• Description\n• Impact</div>
  </div>

  <div class="section" id="section-education">
    <div class="section-title">Education</div>
    <div data-field="education">Degree\nUniversity\nYear</div>
  </div>

  <div class="section" id="section-certifications">
    <div class="section-title">Certifications</div>
    <div data-field="certifications">Certification Name (Year)</div>
  </div>
</body>
</html>`;

const MODERN_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: "Segoe UI", "Inter", sans-serif; font-size: 10.5pt; color: #212121; background: #fff; display: grid; grid-template-columns: 260px 1fr; min-height: 100vh; }
  .sidebar { background: #1e2a3a; color: #e8ecf0; padding: 30px 20px; }
  .sidebar h1 { font-size: 20pt; font-weight: 700; line-height: 1.2; color: #fff; }
  .sidebar .role { font-size: 11pt; color: #7fb3d3; margin-top: 6px; }
  .sidebar-section { margin-top: 24px; }
  .sidebar-section .label { font-size: 8pt; text-transform: uppercase; letter-spacing: 1.5px; color: #7fb3d3; margin-bottom: 8px; border-bottom: 1px solid #2e4057; padding-bottom: 4px; }
  .sidebar-section p, .sidebar-section span { font-size: 9.5pt; line-height: 1.7; word-break: break-word; }
  .skill-bar-label { font-size: 9pt; margin-bottom: 2px; }
  .main { padding: 32px 30px; }
  .section { margin-bottom: 22px; }
  .section-title { font-size: 12pt; font-weight: 700; color: #1e2a3a; text-transform: uppercase; letter-spacing: 0.8px; border-left: 4px solid #1e7abf; padding-left: 8px; margin-bottom: 12px; }
  .entry { margin-bottom: 12px; }
  .entry-header { display: flex; justify-content: space-between; align-items: baseline; }
  .entry-title { font-weight: 600; font-size: 10.5pt; }
  .entry-date { font-size: 9pt; color: #777; }
  .entry-sub { font-size: 9.5pt; color: #555; margin-bottom: 4px; }
  ul { padding-left: 16px; }
  ul li { margin-bottom: 3px; font-size: 9.5pt; }
</style>
</head>
<body>
  <div class="sidebar">
    <h1 data-field="name">Your Name</h1>
    <div class="role" data-field="role">Your Role</div>

    <div class="sidebar-section">
      <div class="label">Contact</div>
      <p data-field="email">email@example.com</p>
      <p data-field="phone">+1 234 567 8901</p>
      <p data-field="location">City, Country</p>
      <p data-field="links">github.com/you</p>
    </div>

    <div class="sidebar-section">
      <div class="label">Languages</div>
      <p data-field="skillsLanguages">JavaScript, TypeScript</p>
    </div>
    <div class="sidebar-section">
      <div class="label">Frameworks</div>
      <p data-field="skillsFrameworks">React, Node.js</p>
    </div>
    <div class="sidebar-section">
      <div class="label">Databases</div>
      <p data-field="skillsDatabases">PostgreSQL, Redis</p>
    </div>
    <div class="sidebar-section">
      <div class="label">Tools</div>
      <p data-field="skillsTools">Docker, AWS</p>
    </div>
  </div>

  <div class="main">
    <div class="section" id="section-summary">
      <div class="section-title">About Me</div>
      <p data-field="summary">A results-driven professional...</p>
    </div>

    <div class="section" id="section-experience">
      <div class="section-title">Experience</div>
      <div data-field="experience">Company | Role | Date\n• Achievement 1\n• Achievement 2</div>
    </div>

    <div class="section" id="section-projects">
      <div class="section-title">Projects</div>
      <div data-field="projects">Project Name\n• Description\n• Impact</div>
    </div>

    <div class="section" id="section-education">
      <div class="section-title">Education</div>
      <div data-field="education">Degree\nUniversity\nYear</div>
    </div>

    <div class="section" id="section-certifications">
      <div class="section-title">Certifications</div>
      <div data-field="certifications">Certification Name (Year)</div>
    </div>
  </div>
</body>
</html>`;

const MINIMAL_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: "Helvetica Neue", Arial, sans-serif; font-size: 10.5pt; color: #333; background: #fff; max-width: 780px; margin: 0 auto; padding: 36px 44px; }
  .header { margin-bottom: 28px; }
  .header h1 { font-size: 24pt; font-weight: 300; letter-spacing: 2px; text-transform: uppercase; color: #111; }
  .header .role { font-size: 11pt; color: #888; margin-top: 2px; letter-spacing: 1px; }
  .header .contact { font-size: 9pt; color: #999; margin-top: 8px; display: flex; gap: 14px; flex-wrap: wrap; }
  .divider { height: 1px; background: #e0e0e0; margin: 20px 0; }
  .section { margin-bottom: 20px; }
  .section-title { font-size: 8.5pt; font-weight: 700; text-transform: uppercase; letter-spacing: 2px; color: #999; margin-bottom: 10px; }
  .section-content { font-size: 10.5pt; line-height: 1.65; }
  .inline-skills { display: flex; flex-wrap: wrap; gap: 6px 12px; }
  .inline-skills span { font-size: 9.5pt; color: #444; }
  ul { padding-left: 16px; }
  ul li { margin-bottom: 4px; }
</style>
</head>
<body>
  <div class="header">
    <h1 data-field="name">Your Name</h1>
    <div class="role" data-field="role">Your Role</div>
    <div class="contact">
      <span data-field="email">email@example.com</span>
      <span data-field="phone">+1 234 567 8901</span>
      <span data-field="location">City, Country</span>
      <span data-field="links">github.com/you</span>
    </div>
  </div>
  <div class="divider"></div>

  <div class="section" id="section-summary">
    <div class="section-title">Summary</div>
    <div class="section-content" data-field="summary">A results-driven professional...</div>
  </div>

  <div class="section" id="section-experience">
    <div class="section-title">Experience</div>
    <div class="section-content" data-field="experience">Company | Role | Date\n• Achievement 1\n• Achievement 2</div>
  </div>

  <div class="section" id="section-skills">
    <div class="section-title">Skills</div>
    <div class="section-content">
      <div><strong>Languages</strong> — <span data-field="skillsLanguages">JavaScript, TypeScript</span></div>
      <div><strong>Frameworks</strong> — <span data-field="skillsFrameworks">React, Node.js</span></div>
      <div><strong>Databases</strong> — <span data-field="skillsDatabases">PostgreSQL, Redis</span></div>
      <div><strong>Tools</strong> — <span data-field="skillsTools">Docker, AWS</span></div>
    </div>
  </div>

  <div class="section" id="section-projects">
    <div class="section-title">Projects</div>
    <div class="section-content" data-field="projects">Project Name\n• Description\n• Impact</div>
  </div>

  <div class="section" id="section-education">
    <div class="section-title">Education</div>
    <div class="section-content" data-field="education">Degree\nUniversity\nYear</div>
  </div>

  <div class="section" id="section-certifications">
    <div class="section-title">Certifications</div>
    <div class="section-content" data-field="certifications">Certification Name (Year)</div>
  </div>
</body>
</html>`;

// ─── Seed ─────────────────────────────────────────────────────────────────────

const DEFAULT_TEMPLATES = [
  {
    name: "Classic",
    category: "Classic",
    thumbnail: "",
    code: CLASSIC_HTML,
  },
  {
    name: "Modern",
    category: "Modern",
    thumbnail: "",
    code: MODERN_HTML,
  },
  {
    name: "Minimal",
    category: "Minimal",
    thumbnail: "",
    code: MINIMAL_HTML,
  },
];

async function main() {
  console.log("Seeding default resume templates...");

  for (const tpl of DEFAULT_TEMPLATES) {
    const existing = await (prisma as any).resumeTemplate.findFirst({
      where: { name: tpl.name },
    });

    if (existing) {
      console.log(`  [skip] "${tpl.name}" already exists (id: ${existing.id})`);
      continue;
    }

    const created = await (prisma as any).resumeTemplate.create({ data: tpl });
    console.log(`  [created] "${tpl.name}" (id: ${created.id})`);
  }

  console.log("Done.");
}

main()
  .catch((err) => {
    console.error("Seed failed:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
