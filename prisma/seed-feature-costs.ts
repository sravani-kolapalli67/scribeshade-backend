/**
 * Seeds the FeatureCost table with default values.
 * Run with: pnpm tsx prisma/seed-feature-costs.ts
 *
 * Safe to re-run — uses upsert so existing rows are updated, not duplicated.
 *
 * Pricing aligned to docs/Plan.md (Resume Builder section):
 *   - Parse uploaded resume:    2 credits
 *   - Section edit (AI enhance): 1 credit
 *   - JD tailoring (first time): 4 credits   (regenerate within 24h is FREE
 *                                             via AiGenerationCache)
 *   - Template apply (generate): 1 credit
 *
 * Project pricing (kept as-is):
 *   - AI project generation:           4 credits
 *   - Regenerate single section:       1 credit
 *   - Resume bullets only:             1 credit
 *   - Interview explanation script:    1 credit
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const defaults = [
  // ── Resume Builder (Plan.md) ────────────────────────────────────────────────
  {
    featureKey: "resume_extract_fields",
    credits: "2",
    label: "Resume Builder – Parse Uploaded Resume",
  },
  {
    featureKey: "resume_enhance_section",
    credits: "1",
    label: "Resume Builder – AI Enhance Section",
  },
  {
    featureKey: "resume_tailor",
    credits: "4",
    label: "Resume Builder – Tailor to Job Description (regenerate is free)",
  },
  {
    featureKey: "resume_generate",
    credits: "1",
    label: "Resume Builder – Apply Template (AI populate)",
  },
  // ── AI Projects (existing) ─────────────────────────────────────────────────
  {
    featureKey: "project_generate",
    credits: "4",
    label: "AI Project Generation (3 projects)",
  },
  {
    featureKey: "project_edit_component",
    credits: "1",
    label: "AI Project – Regenerate Single Section",
  },
  {
    featureKey: "project_resume_bullets",
    credits: "1",
    label: "AI Project – Resume Bullets Only",
  },
  {
    featureKey: "project_interview_script",
    credits: "1",
    label: "AI Project – Interview Explanation Script",
  },
];

async function main() {
  for (const row of defaults) {
    await prisma.featureCost.upsert({
      where: { featureKey: row.featureKey },
      update: { credits: row.credits, label: row.label },
      create: row,
    });
    console.log(`✅  FeatureCost upserted: ${row.featureKey} → ${row.credits} credits`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
