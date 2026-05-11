/**
 * Seeds the CreditPack table with all purchasable credit packs.
 * Run with: pnpm tsx prisma/seed-credit-packs.ts
 *
 * Safe to re-run — uses upsert keyed on `code`, so existing rows are updated,
 * not duplicated. Prices aligned to docs/ScribeShade Pricing & Credits.md.
 *
 * valuePct is the "value efficiency" shown on each card in the Billing UI:
 *   Quick 5      → 42%
 *   Starter 10   → 56%
 *   Basic 25     → 60%
 *   Standard 60  → 72%   (Popular)
 *   Professional → 77%
 *   Power 300    → 83%
 *   Mega 600     → 88%
 */
import { PrismaClient, PackTier, PackFeature } from "@prisma/client";

const prisma = new PrismaClient();

const packs: Array<{
  code: string;
  tier: PackTier;
  name: string;
  credits: string;
  feature: PackFeature;
  priceInr: string;
  priceUsd: string;
  priceGbp: string;
  valuePct: number;
  isPopular: boolean;
  sortOrder: number;
}> = [
  {
    code: "quick_5",
    tier: PackTier.QUICK,
    name: "Quick 5",
    credits: "5",
    feature: PackFeature.INTERVIEW_SESSION,
    priceInr: "99.00",
    priceUsd: "2.99",
    priceGbp: "2.49",
    valuePct: 42,
    isPopular: false,
    sortOrder: 1,
  },
  {
    code: "starter_10",
    tier: PackTier.STARTER,
    name: "Starter",
    credits: "10",
    feature: PackFeature.INTERVIEW_SESSION,
    priceInr: "149.00",
    priceUsd: "3.99",
    priceGbp: "3.49",
    valuePct: 56,
    isPopular: false,
    sortOrder: 2,
  },
  {
    code: "basic_25",
    tier: PackTier.BASIC,
    name: "Basic",
    credits: "25",
    feature: PackFeature.INTERVIEW_SESSION,
    priceInr: "349.00",
    priceUsd: "9.99",
    priceGbp: "8.99",
    valuePct: 60,
    isPopular: false,
    sortOrder: 3,
  },
  {
    code: "standard_60",
    tier: PackTier.STANDARD,
    name: "Standard",
    credits: "60",
    feature: PackFeature.INTERVIEW_SESSION,
    priceInr: "699.00",
    priceUsd: "19.99",
    priceGbp: "17.99",
    valuePct: 72,
    isPopular: true,
    sortOrder: 4,
  },
  {
    code: "professional_120",
    tier: PackTier.PROFESSIONAL,
    name: "Professional",
    credits: "120",
    feature: PackFeature.INTERVIEW_SESSION,
    priceInr: "1299.00",
    priceUsd: "39.99",
    priceGbp: "34.99",
    valuePct: 77,
    isPopular: false,
    sortOrder: 5,
  },
  {
    code: "power_300",
    tier: PackTier.POWER,
    name: "Power",
    credits: "300",
    feature: PackFeature.INTERVIEW_SESSION,
    priceInr: "2999.00",
    priceUsd: "89.99",
    priceGbp: "79.99",
    valuePct: 83,
    isPopular: false,
    sortOrder: 6,
  },
  {
    code: "mega_600",
    tier: PackTier.MEGA,
    name: "Mega",
    credits: "600",
    feature: PackFeature.INTERVIEW_SESSION,
    priceInr: "4999.00",
    priceUsd: "149.99",
    priceGbp: "129.99",
    valuePct: 88,
    isPopular: false,
    sortOrder: 7,
  },
];

async function main() {
  console.log("Seeding CreditPack table...");

  for (const pack of packs) {
    await prisma.creditPack.upsert({
      where: { code: pack.code },
      update: {
        tier: pack.tier,
        name: pack.name,
        credits: pack.credits,
        feature: pack.feature,
        priceInr: pack.priceInr,
        priceUsd: pack.priceUsd,
        priceGbp: pack.priceGbp,
        valuePct: pack.valuePct,
        isPopular: pack.isPopular,
        sortOrder: pack.sortOrder,
        isActive: true,
      },
      create: pack,
    });
    console.log(`  ✓ ${pack.name} (${pack.code})`);
  }

  console.log(`\nDone — ${packs.length} packs seeded.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
