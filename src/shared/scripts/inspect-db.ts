import { prisma } from "../lib/prisma";

async function main() {
  console.log("=== RECENT SESSIONS ===");
  const sessions = await prisma.session.findMany({
    take: 5,
    orderBy: { createdAt: "desc" },
    include: {
      user: {
        select: {
          id: true,
          email: true,
          resumes: {
            select: {
              id: true,
              filename: true,
              uploadedAt: true,
            }
          }
        }
      }
    }
  });

  for (const s of sessions) {
    console.log(`Session ID: ${s.id}`);
    console.log(`  User: ${s.user.email} (${s.user.id})`);
    console.log(`  Company: ${s.companyName}`);
    console.log(`  resumeId field in Session: "${s.resumeId}"`);
    console.log(`  User's actual resumes in DB:`, s.user.resumes);
    console.log(`  documentId field in Session: "${s.documentId}"`);
    console.log("-----------------------------------------");
  }
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
