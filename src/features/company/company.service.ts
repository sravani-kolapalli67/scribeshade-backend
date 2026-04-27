import { prisma } from "../../shared/lib/prisma";

/**
 * Returns all companies stored in the database.
 */
export async function listCompanies() {
  return prisma.company.findMany({
    include: {
      _count: {
        select: {
          sessions: true,
          questions: true,
        },
      },
    },
    // orderBy: { name: "asc" },
  });
}

/**
 * Returns a specific company by its ID.
 */
export async function getCompanyById(id: string) {
  return prisma.company.findUnique({
    where: { id },
  });
}

/**
 * Returns a specific company by its slug.
 */
export async function getCompanyBySlug(slug: string) {
  return prisma.company.findUnique({
    where: { slug },
  });
}
