import { prisma } from "../../shared/lib/prisma";

export async function getPolicy() {
  // Get the most recent policy
  return prisma.policy.findFirst({
    orderBy: {
      updatedAt: "desc",
    },
  });
}

export async function updatePolicy(data: {
  privacyPolicy: string;
  termsAndConditions: string;
}) {
  // Since we want to keep track of changes, we can either update existing or create new.
  // Given the schema has an ID and updatedAt, findFirst + upsert or just create is fine.
  // The user asked to "create and get", so maybe they want multiple versions?
  // But usually, you just want the current one.
  // Let's check if there's any existing record.
  const existing = await prisma.policy.findFirst({
    orderBy: {
      updatedAt: "desc",
    },
  });

  if (existing) {
    return prisma.policy.update({
      where: { id: existing.id },
      data: {
        privacyPolicy: data.privacyPolicy,
        termsAndConditions: data.termsAndConditions,
        updatedAt: new Date(),
      },
    });
  }

  return prisma.policy.create({
    data: {
      privacyPolicy: data.privacyPolicy,
      termsAndConditions: data.termsAndConditions,
    },
  });
}
