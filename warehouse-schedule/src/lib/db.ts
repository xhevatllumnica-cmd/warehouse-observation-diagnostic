import { PrismaClient } from "@prisma/client";

/**
 * Një instancë e vetme e PrismaClient. Në development, Next.js ringarkon
 * modulet shpesh, prandaj instanca ruhet në `globalThis`.
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = db;
