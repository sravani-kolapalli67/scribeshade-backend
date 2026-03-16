import { prisma } from "../../shared/lib/prisma";

export class AuthService {
  static async syncUser(clerkId: string, email?: string, name?: string) {
    return prisma.user.upsert({
      where: { clerkId },
      update: { email, name },
      create: { clerkId, email, name },
    });
  }

  // Future: Handle Clerk webhooks here
  static async handleWebhook(data: any) {
    // Logic for clerk webhooks
  }
}
