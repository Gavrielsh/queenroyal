import { PrismaClient } from "@prisma/client";

import { getEnv } from "../config/env";

/**
 * Strict process-singleton Prisma client for the LONG-RUNNING Fastify gateway.
 *
 * Why this differs from the legacy serverless client (which cached on `globalThis` to survive
 * function cold-starts): a Fastify process is long-lived, so we want EXACTLY ONE client for
 * the lifetime of the process and a clean `$disconnect()` on shutdown. The instance is built
 * lazily on first use, so importing this module never opens a pool — and the dependency-free
 * liveness probe can answer even before the database is touched.
 *
 * ── Connection pooling / PgBouncer (transaction mode) ────────────────────────────────────
 * In production Postgres sits behind PgBouncer in TRANSACTION pooling mode. Two things are
 * required for Prisma to be correct there:
 *   1. `DATABASE_URL` must carry `?pgbouncer=true` so Prisma stops issuing NAMED server-side
 *      prepared statements — they cannot be reused across transaction-pooled backends and
 *      would otherwise fail with `prepared statement "s0" already exists`.
 *   2. Keep Prisma's own per-instance pool small via `connection_limit` in the URL (e.g.
 *      `connection_limit=1` for many small replicas) and let PgBouncer do the real pooling.
 * Example:
 *   postgresql://user:pass@pgbouncer:6432/db?pgbouncer=true&connection_limit=1
 *
 * Schema migrations CANNOT run through a transaction pooler — they use a DIRECT, session-mode
 * connection (`DIRECT_DATABASE_URL` → datasource `directUrl` in prisma/schema.prisma).
 */

let client: PrismaClient | null = null;

/**
 * Lazily construct (once) and return the singleton client. Validates env first so a missing
 * `DATABASE_URL` surfaces as a clear, fail-closed error rather than an opaque Prisma
 * initialization fault on the first query.
 */
export function getPrisma(): PrismaClient {
  if (client) return client;
  getEnv();
  client = new PrismaClient({ log: ["warn", "error"] });
  return client;
}

/** Eagerly open the pool (e.g. a boot-time fail-fast or a readiness probe). Optional. */
export async function connectPrisma(): Promise<void> {
  await getPrisma().$connect();
}

/** Close the pool on graceful shutdown. Safe no-op if the client was never constructed. */
export async function disconnectPrisma(): Promise<void> {
  if (!client) return;
  await client.$disconnect();
  client = null;
}
