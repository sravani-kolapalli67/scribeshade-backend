import { prisma } from "../../shared/lib/prisma";

export async function findByClerkId(clerkId: string) {
  return prisma.user.findUnique({
    where: { clerkId },
  });
}

export async function syncUser(clerkId: string, email?: string, name?: string) {
  return prisma.user.upsert({
    where: { clerkId },
    update: { email, name },
    create: { 
      clerkId, 
      email: email || "", 
      name: name || "" 
    },
  });
}

export async function getUserProfile(clerkId: string) {
  const user = await findByClerkId(clerkId);
  if (!user) {
    throw new Error("User not found");
  }
  return user;
}
