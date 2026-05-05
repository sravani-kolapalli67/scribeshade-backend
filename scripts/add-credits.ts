/**
 * add-credits.ts
 *
 * Usage:
 *   pnpm tsx scripts/add-credits.ts <email> <credits>
 *
 * Example:
 *   pnpm tsx scripts/add-credits.ts user@example.com 100
 */

import { PrismaClient, LedgerType } from "@prisma/client";
import { Decimal } from "@prisma/client/runtime/library";

const prisma = new PrismaClient();

async function main() {
  const [, , emailArg, creditsArg] = process.argv;

  if (!emailArg || !creditsArg) {
    console.error("Usage: pnpm tsx scripts/add-credits.ts <email> <credits>");
    process.exit(1);
  }

  const email = emailArg.trim().toLowerCase();
  const creditsToAdd = parseFloat(creditsArg);

  if (isNaN(creditsToAdd) || creditsToAdd <= 0) {
    console.error("Error: credits must be a positive number.");
    process.exit(1);
  }

  // Resolve user
  const user = await prisma.user.findUnique({ where: { email } });

  if (!user) {
    console.error(`Error: no user found with email "${email}".`);
    process.exit(1);
  }

  console.log(`Found user: ${user.name ?? user.email} (id: ${user.id})`);

  // Upsert credit balance and add credits atomically
  const result = await prisma.$transaction(async (tx) => {
    // Ensure a balance row exists
    const balance = await tx.userCreditBalance.upsert({
      where: { userId: user.id },
      create: {
        userId: user.id,
        purchasedCredits: 0,
        earnedCredits: 0,
        heldCredits: 0,
        totalAvailable: 0,
      },
      update: {},
    });

    const balanceBefore = new Decimal(balance.totalAvailable.toString());
    const amount = new Decimal(creditsToAdd.toString());
    const balanceAfter = balanceBefore.add(amount);

    // Update the balance
    const updated = await tx.userCreditBalance.update({
      where: { userId: user.id },
      data: {
        earnedCredits: { increment: amount },
        totalAvailable: { increment: amount },
      },
    });

    // Write a ledger entry for traceability
    const ledger = await tx.creditLedger.create({
      data: {
        userId: user.id,
        type: LedgerType.EARN,
        amount,
        balanceBefore,
        balanceAfter,
        reason: `Manual credit grant via add-credits script`,
      },
    });

    return { updated, ledger };
  });

  console.log(`\nCredits added successfully!`);
  console.log(`  Added        : ${creditsToAdd}`);
  console.log(
    `  New balance  : ${result.updated.totalAvailable.toString()}`
  );
  console.log(`  Ledger entry : ${result.ledger.id}`);
}

main()
  .catch((err) => {
    console.error("Unexpected error:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
