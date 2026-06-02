import { prisma } from "../src/shared/lib/prisma";
import * as sessionService from "../src/features/session/session.service";

async function main() {
  const session = await prisma.session.findFirst({
    orderBy: { createdAt: "desc" }
  });
  if (!session) {
    console.error("No session found in DB");
    return;
  }
  console.log("Using session:", session.id);
  
  const start = Date.now();
  const stream = await sessionService.getAIAnswer(
    session.id,
    "How does virtual DOM work in React?",
    false, // isCustomQuery
    false, // isRegen
  );
  
  console.log("Stream generator obtained in", Date.now() - start, "ms");
  
  let chunkCount = 0;
  for await (const chunk of stream as any) {
    console.log(`Chunk ${++chunkCount} received at ${Date.now() - start}ms:`, JSON.stringify(chunk));
  }
  console.log("Stream finished. Total chunks:", chunkCount);
}

main().catch(console.error).finally(() => prisma.$disconnect());
