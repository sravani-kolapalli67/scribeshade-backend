import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function run() {
  const userId = "e9e7dfb2-8139-46e9-accb-0d6b23a55922";
  
  console.log(`Searching for user ${userId}...`);
  
  const user = await prisma.user.findFirst({
    where: {
      OR: [
        { id: userId },
        { clerkId: userId }
      ]
    },
    include: { creditBalance: true }
  });

  if (!user) {
    console.error("User not found!");
    return;
  }

  console.log(`Found user: ${user.email} (DB ID: ${user.id})`);
  console.log("Current Balance:", user.creditBalance);

  const updatedBalance = await prisma.userCreditBalance.update({
    where: { userId: user.id },
    data: {
      purchasedCredits: 1.5,
      earnedCredits: 0,
      heldCredits: 0,
      totalAvailable: 1.5
    }
  });

  console.log("New Balance:", updatedBalance);
  
  // Also clean up any ACTIVE sessions for this user that might be holding credits
  const updatedSessions = await prisma.session.updateMany({
    where: {
      userId: user.id,
      status: { in: ["ACTIVE", "PAUSED"] }
    },
    data: {
      status: "ABANDONED",
      creditsHeld: 0
    }
  });
  
  console.log(`Updated ${updatedSessions.count} active/paused sessions to ABANDONED.`);
}

run()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
