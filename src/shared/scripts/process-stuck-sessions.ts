import { PrismaClient, SessionStatus, Prisma } from "@prisma/client";
import * as creditsService from "../../features/credits/credits.service";

const prisma = new PrismaClient();

async function processStuckSession(sessionId: string) {
  console.log(`Processing stuck session ${sessionId}...`);
  
  await prisma.$transaction(async (tx) => {
    const session = await tx.session.findUnique({ where: { id: sessionId } });
    if (!session) return;
    if (session.status === SessionStatus.COMPLETED || session.status === SessionStatus.CREDIT_EXHAUSTED) return;

    const snapshot = session.bracketConfigSnapshot as any;
    if (!snapshot) {
      await tx.session.update({
        where: { id: sessionId },
        data: { status: SessionStatus.COMPLETED },
      });
      return;
    }

    const endedAt = session.endedAt ?? new Date();
    const startedAt = session.startedAt ?? endedAt;
    const totalSeconds = Math.floor(
      (endedAt.getTime() - startedAt.getTime()) / 1000,
    );
    const activeDurationMinutes = Math.floor(
      (totalSeconds - (session.pausedDurationSeconds || 0)) / 60,
    );

    const result = await creditsService.deductCredits(
      session.userId,
      sessionId,
      activeDurationMinutes,
      new Prisma.Decimal(session.creditsHeld.toString()),
      snapshot,
      false, // assume not exhausted for manual cleanup unless we know
      tx,
    );

    await tx.session.update({
      where: { id: sessionId },
      data: {
        status: SessionStatus.COMPLETED,
        creditsDeducted: new Prisma.Decimal(result.creditsDeducted),
        deductionReason: result.reason as any,
        durationSeconds: totalSeconds,
      },
    });
  });
  
  console.log(`Session ${sessionId} processed successfully.`);
}

async function run() {
  const userId = "e9e7dfb2-8139-46e9-accb-0d6b23a55922";
  
  const stuckSessions = await prisma.session.findMany({
    where: { 
      userId,
      status: SessionStatus.COMPLETING
    }
  });

  console.log(`Found ${stuckSessions.length} stuck sessions.`);
  for (const s of stuckSessions) {
    await processStuckSession(s.id);
  }
}

run()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
