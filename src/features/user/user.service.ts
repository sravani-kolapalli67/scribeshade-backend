import { prisma } from "../../shared/lib/prisma";

export class UserService {
  static async findByClerkId(clerkId: string) {
    return prisma.user.findUnique({
      where: { clerkId },
    });
  }

  static async syncUser(clerkId: string, email?: string, name?: string) {
    return prisma.user.upsert({
      where: { clerkId },
      update: { email, name },
      create: { clerkId, email, name },
    });
  }

  static async getUserProfile(clerkId: string) {
    const user = await this.findByClerkId(clerkId);
    if (!user) {
      throw new Error("User not found");
    }
    return user;
  }
}
