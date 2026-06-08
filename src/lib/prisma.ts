import { PrismaClient } from "@prisma/client";

/**
 * Serverless-safe Prisma singleton.
 *
 * In a serverless/edge deployment every cold start evaluates this module once; the client
 * is cached on `globalThis` and REUSED across all subsequent warm invocations on the same
 * instance. Caching unconditionally (not just in dev) is what prevents connection-pool
 * exhaustion — without it, each invocation would open a new pool and quickly blow past the
 * Postgres `max_connections` limit.
 *
 * For high-concurrency serverless, also cap connections at the driver via the connection
 * string (e.g. `?connection_limit=1`) and/or front Postgres with a pooler such as PgBouncer
 * or Prisma Accelerate. The app emits its own structured logs, so Prisma is kept quiet
 * except for warnings/errors.
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma: PrismaClient =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: ["warn", "error"],
  });

globalForPrisma.prisma = prisma;
