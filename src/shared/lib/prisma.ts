import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    datasources: {
      db: {
        url: (() => {
          const url = process.env.DATABASE_URL || "";
          // Ensure connection_limit and pool_timeout are set in the URL
          try {
            const u = new URL(url);
            if (!u.searchParams.has("connection_limit")) {
              u.searchParams.set("connection_limit", "25");
            }
            if (!u.searchParams.has("pool_timeout")) {
              u.searchParams.set("pool_timeout", "30");
            }
            return u.toString();
          } catch {
            return url;
          }
        })(),
      },
    },
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
