import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function run() {
  const userId = "e9e7dfb2-8139-46e9-accb-0d6b23a55922";
  
  const sessions = await prisma.session.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: 5
  });

  console.log("Recent Sessions for user:");
  sessions.forEach(s => {
    console.log(`- ID: ${s.id}, Status: ${s.status}, CreditsHeld: ${s.creditsHeld}, Started: ${s.startedAt}, Ended: ${s.endedAt}`);
  });
}

run()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
