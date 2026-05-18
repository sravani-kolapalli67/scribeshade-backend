import dotenv from "dotenv";
import { getAIAnswer } from "../../features/session/session.service";
import { PrismaClient } from "@prisma/client";

dotenv.config();

async function main() {
  const prisma = new PrismaClient();
  try {
    const latestSession = await prisma.session.findFirst({
      orderBy: { createdAt: "desc" },
    });

    if (!latestSession) {
      console.log("No sessions found in the database!");
      return;
    }

    console.log("=== LATEST SESSION ===");
    console.log("ID:", latestSession.id);
    console.log("Status:", latestSession.status);
    console.log("Company Name:", latestSession.companyName);
    console.log("Job Description:", latestSession.jobDescription);

    const query = "From my resume, give me how many technologies I have.";
    console.log(`\nCalling getAIAnswer with query: "${query}"...`);
    
    const stream = await getAIAnswer(latestSession.id, query, false, false);
    
    console.log("\n=== STREAM OUT ===");
    let fullResponse = "";
    for await (const chunk of stream) {
      if (chunk.text) {
        process.stdout.write(chunk.text);
        fullResponse += chunk.text;
      }
    }
    console.log("\n==================");
    console.log("Full length:", fullResponse.length);
  } catch (error) {
    console.error("Diagnostic error:", error);
  } finally {
    await prisma.$disconnect();
  }
}

main();
