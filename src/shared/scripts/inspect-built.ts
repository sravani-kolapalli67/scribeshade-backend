import { prisma } from "../lib/prisma";

async function main() {
  const resumeId = "c1b14f93-2218-4682-8881-0d92e5a49e17";
  
  console.log(`Checking resumeId: ${resumeId}`);
  
  const rawResume = await prisma.resume.findUnique({
    where: { id: resumeId }
  });
  console.log("In Resume table:", rawResume);
  
  const builtResume = await prisma.builtResume.findUnique({
    where: { id: resumeId }
  });
  console.log("In BuiltResume table:", builtResume);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
