import { PrismaClient } from "@prisma/client";

async function main() {
  const prisma = new PrismaClient();
  try {
    const latestSession = await prisma.session.findFirst({
      orderBy: { createdAt: "desc" },
    });

    if (!latestSession) {
      console.log("No sessions found!");
      return;
    }

    console.log("Latest Session details:");
    console.log("Session ID:", latestSession.id);
    console.log("User ID:", latestSession.userId);
    console.log("resumeId in session:", latestSession.resumeId);
    console.log("documentId in session:", latestSession.documentId);
    console.log("projectIds in session:", latestSession.projectIds);

    const userResumes = await prisma.resume.findMany({
      where: { userId: latestSession.userId },
    });
    console.log(`\nUser Resumes count: ${userResumes.length}`);
    userResumes.forEach((r, idx) => {
      console.log(`  Resume ${idx + 1}: ID=${r.id}, Filename=${r.filename}, Length of resumeContext=${r.resumeContext?.length || 0}`);
    });

    const userDocuments = await prisma.document.findMany({
      where: { userId: latestSession.userId },
    });
    console.log(`\nUser Documents count: ${userDocuments.length}`);
    userDocuments.forEach((d, idx) => {
      console.log(`  Document ${idx + 1}: ID=${d.id}, Filename=${d.filename}`);
    });

    const userProjects = await prisma.project.findMany({
      where: { userId: latestSession.userId },
    });
    console.log(`\nUser Projects count: ${userProjects.length}`);
    userProjects.forEach((p, idx) => {
      console.log(`  Project ${idx + 1}: ID=${p.id}, Title=${p.position}`);
    });

  } catch (error) {
    console.error("Inspect error:", error);
  } finally {
    await prisma.$disconnect();
  }
}

main();
