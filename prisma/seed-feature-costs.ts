/**
 * Seeds the FeatureCost table with default values.
 * Run with: pnpm tsx prisma/seed-feature-costs.ts
 *
 * Safe to re-run — uses upsert so existing rows are updated, not duplicated.
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const defaults = [
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
