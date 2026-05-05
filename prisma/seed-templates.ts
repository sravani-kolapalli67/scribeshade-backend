/**
 * Seeds the ResumeTemplate table with the three default templates.
 * Run with: pnpm tsx prisma/seed-templates.ts
 *
 * Safe to re-run — uses upsert keyed on (name + category) so existing rows
 * are updated rather than duplicated.
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// ─── Template HTML ────────────────────────────────────────────────────────────

const CLASSIC_HTML = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8"/>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Segoe UI',Arial,sans-serif;font-size:13px;color:#1a1a1a;background:#fff;padding:32px 40px}
  h1{font-size:22px;font-weight:700;letter-spacing:-0.3px}
  .role{font-size:13px;color:#555;margin-top:2px}
  .contact{font-size:11px;color:#777;margin-top:6px}
  hr{border:none;border-top:2px solid #1a1a1a;margin:16px 0 10px}
  h2{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1.2px;color:#1a1a1a;margin-bottom:8px}
  section{margin-bottom:18px}
  .summary{font-size:12px;line-height:1.6;color:#333}
  .skill-group{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:6px}
  .skill-chip{background:#f0f0f0;border-radius:4px;padding:2px 8px;font-size:11px}
  .proj-item,.edu-item{margin-bottom:10px}
  .exp-title{font-weight:600;font-size:12.5px}
  .exp-meta{font-size:11px;color:#666}
  ul{padding-left:16px;margin-top:4px}
  li{font-size:12px;line-height:1.5;color:#333;margin-bottom:2px}
</style>
</head>
<body>
  <h1 data-field="name">Your Name</h1>
  <div class="role" data-field="role">Professional Role</div>
  <div class="contact">
    <span data-field="email">email@example.com</span>
    <span> · </span><span data-field="phone">+1 (555) 000-0000</span>
    <span> · </span><span data-field="links">linkedin.com/in/yourprofile</span>
  </div>
  <hr/>
  <section>
    <h2>Summary</h2>
    <p class="summary" data-field="summary">A brief professional summary highlighting your key skills and experience.</p>
  </section>
  <section>
    <h2>Work Experience</h2>
    <div data-list="experiences">
      <div class="exp-item" style="margin-bottom:12px">
        <div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px">
          <div>
            <span class="exp-title" data-field="company">Company</span>
            <span class="exp-meta" style="margin-left:6px" data-field="title">Title</span>
          </div>
          <span class="exp-meta" style="white-space:nowrap" data-field="dates">Dates</span>
        </div>
        <ul data-list="points"><li data-field="point">Point</li></ul>
      </div>
    </div>
  </section>
  <section>
    <h2>Skills</h2>
    <div class="skill-group">
      <span class="skill-chip" data-field="languages">Languages</span>
      <span class="skill-chip" data-field="frameworks">Frameworks</span>
      <span class="skill-chip" data-field="database">Databases</span>
      <span class="skill-chip" data-field="tools">Tools</span>
    </div>
  </section>
  <section>
    <h2>Projects</h2>
    <div data-list="projects">
      <div class="proj-item">
        <div class="exp-title" data-field="title">Project Title</div>
        <ul data-list="points"><li data-field="point">Project description point</li></ul>
      </div>
    </div>
  </section>
  <section>
    <h2>Education</h2>
    <div data-list="education">
      <div class="edu-item">
        <div class="exp-title" data-field="degree">Degree</div>
        <div class="exp-meta"><span data-field="institute">Institute</span> · <span data-field="year">Year</span></div>
      </div>
    </div>
  </section>
</body>
</html>`;

const MODERN_HTML = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8"/>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Segoe UI',Arial,sans-serif;font-size:13px;color:#111;background:#fff;display:flex;min-height:100vh}
  .sidebar{width:200px;background:#1a1a2e;color:#e2e8f0;padding:28px 20px;flex-shrink:0}
  .sidebar h1{font-size:16px;font-weight:700;color:#fff;line-height:1.3}
  .sidebar .role{font-size:11px;color:#94a3b8;margin-top:4px}
  .sidebar h2{font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;color:#64748b;margin:20px 0 8px}
  .sidebar p,.sidebar span{font-size:11px;color:#cbd5e1;line-height:1.5;display:block;margin-bottom:2px}
  .sidebar .skill-chip{background:#1e293b;border-radius:3px;padding:2px 8px;font-size:10.5px;color:#e2e8f0;margin-bottom:4px}
  .main{flex:1;padding:28px 24px}
  section{margin-bottom:18px}
  .section-title{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;color:#1a1a2e;border-bottom:2px solid #1a1a2e;padding-bottom:4px;margin-bottom:10px}
  .proj-item,.edu-item{margin-bottom:10px}
  .item-title{font-weight:600;font-size:12.5px}
  .item-meta{font-size:11px;color:#666}
  ul{padding-left:16px;margin-top:4px}
  li{font-size:12px;line-height:1.5;color:#333;margin-bottom:2px}
  .summary{font-size:12px;line-height:1.6;color:#444}
</style>
</head>
<body>
  <div class="sidebar">
    <h1 data-field="name">Your Name</h1>
    <div class="role" data-field="role">Role</div>
    <h2>Contact</h2>
    <span data-field="email">email@example.com</span>
    <span data-field="phone">+1 000-0000</span>
    <span data-field="links">linkedin</span>
    <h2>Skills</h2>
    <span class="skill-chip" data-field="languages">Languages</span>
    <span class="skill-chip" data-field="frameworks">Frameworks</span>
    <span class="skill-chip" data-field="database">Databases</span>
    <span class="skill-chip" data-field="tools">Tools</span>
  </div>
  <div class="main">
    <section>
      <div class="section-title">Summary</div>
      <p class="summary" data-field="summary">Professional summary goes here.</p>
    </section>
    <section>
      <div class="section-title">Work Experience</div>
      <div data-list="experiences">
        <div class="proj-item">
          <div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px">
            <div>
              <span class="item-title" data-field="company">Company</span>
              <span class="item-meta" style="margin-left:6px" data-field="title">Title</span>
            </div>
            <span class="item-meta" style="white-space:nowrap" data-field="dates">Dates</span>
          </div>
          <ul data-list="points"><li data-field="point">Point</li></ul>
        </div>
      </div>
    </section>
    <section>
      <div class="section-title">Projects</div>
      <div data-list="projects">
        <div class="proj-item">
          <div class="item-title" data-field="title">Project Title</div>
          <ul data-list="points"><li data-field="point">Detail</li></ul>
        </div>
      </div>
    </section>
    <section>
      <div class="section-title">Education</div>
      <div data-list="education">
        <div class="edu-item">
          <div class="item-title" data-field="degree">Degree</div>
          <div class="item-meta"><span data-field="institute">Institute</span> · <span data-field="year">Year</span></div>
        </div>
      </div>
    </section>
  </div>
</body>
</html>`;

const MINIMAL_HTML = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8"/>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:Georgia,'Times New Roman',serif;font-size:13px;color:#1a1a1a;background:#fff;padding:36px 44px}
  h1{font-size:24px;font-weight:400;letter-spacing:2px;text-transform:uppercase;text-align:center}
  .role{font-size:11px;color:#888;text-align:center;letter-spacing:1.5px;text-transform:uppercase;margin-top:4px}
  .contact{text-align:center;font-size:11px;color:#888;margin-top:6px}
  .divider{border:none;border-top:1px solid #ccc;margin:18px 0 12px}
  h2{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:2px;color:#888;margin-bottom:8px}
  section{margin-bottom:20px}
  .summary{font-size:12.5px;line-height:1.7;color:#333;font-style:italic}
  .skills-row{display:flex;flex-wrap:wrap;gap:4px}
  .skill{font-size:11.5px;color:#555}
  .skill::after{content:" ·";color:#ccc}
  .skill:last-child::after{content:""}
  .proj-item,.edu-item{margin-bottom:10px}
  .item-title{font-weight:700;font-size:12.5px}
  .item-meta{font-size:11px;color:#888}
  ul{padding-left:18px;margin-top:4px}
  li{font-size:12px;line-height:1.6;color:#444;margin-bottom:2px}
</style>
</head>
<body>
  <h1 data-field="name">YOUR NAME</h1>
  <div class="role" data-field="role">PROFESSIONAL ROLE</div>
  <div class="contact">
    <span data-field="email">email@example.com</span> &nbsp;·&nbsp;
    <span data-field="phone">Phone</span> &nbsp;·&nbsp;
    <span data-field="links">Links</span>
  </div>
  <hr class="divider"/>
  <section>
    <h2>Profile</h2>
    <p class="summary" data-field="summary">Your professional summary.</p>
  </section>
  <hr class="divider"/>
  <section>
    <h2>Technical Skills</h2>
    <div class="skills-row">
      <span class="skill" data-field="languages">Languages</span>
      <span class="skill" data-field="frameworks">Frameworks</span>
      <span class="skill" data-field="database">Databases</span>
      <span class="skill" data-field="tools">Tools</span>
    </div>
  </section>
  <hr class="divider"/>
  <section>
    <h2>Work Experience</h2>
    <div data-list="experiences">
      <div class="exp-item" style="margin-bottom:12px">
        <div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px">
          <div>
            <span class="item-title" data-field="company">Company</span>
            <span class="item-meta" style="margin-left:6px" data-field="title">Title</span>
          </div>
          <span class="item-meta" style="white-space:nowrap" data-field="dates">Dates</span>
        </div>
        <ul data-list="points"><li data-field="point">Point</li></ul>
      </div>
    </div>
  </section>
  <hr class="divider"/>
  <section>
    <h2>Projects</h2>
    <div data-list="projects">
      <div class="proj-item">
        <div class="item-title" data-field="title">Project Title</div>
        <ul data-list="points"><li data-field="point">Detail</li></ul>
      </div>
    </div>
  </section>
  <hr class="divider"/>
  <section>
    <h2>Education</h2>
    <div data-list="education">
      <div class="edu-item">
        <div class="item-title" data-field="degree">Degree</div>
        <div class="item-meta"><span data-field="institute">Institute</span> · <span data-field="year">Year</span></div>
      </div>
    </div>
  </section>
</body>
</html>`;

// ─── Seed data ────────────────────────────────────────────────────────────────

const templates = [
  { name: "Classic", category: "CLASSIC", thumbnail: "", code: CLASSIC_HTML },
  { name: "Modern",  category: "MODERN",  thumbnail: "", code: MODERN_HTML  },
  { name: "Minimal", category: "MINIMAL", thumbnail: "", code: MINIMAL_HTML },
];

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  for (const tpl of templates) {
    // Upsert keyed on name so re-runs update the code without creating duplicates.
    const existing = await prisma.resumeTemplate.findFirst({ where: { name: tpl.name } });
    if (existing) {
      await prisma.resumeTemplate.update({
        where: { id: existing.id },
        data: { category: tpl.category, thumbnail: tpl.thumbnail, code: tpl.code },
      });
      console.log(`  updated  → ${tpl.name}`);
    } else {
      await prisma.resumeTemplate.create({ data: tpl });
      console.log(`  created  → ${tpl.name}`);
    }
  }
  console.log("Done.");
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
