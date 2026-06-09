import { randomUUID } from "node:crypto";

/**
 * In-memory Prisma fake implementing exactly the `user` and `engineRequestLog` operations the
 * gateway services + reconciler use. It lets the integration tests exercise the REAL service +
 * reconciler code (which talk to the journal via `getPrisma()` and the repository's raw
 * `FOR UPDATE [SKIP LOCKED]` queries) against a controllable journal/outbox without a database.
 *
 * Install it by mocking the prisma singleton in the test file:
 *   vi.mock("../src/lib/prisma", async () => {
 *     const mod = await import("./fakes/prisma.fake");
 *     return { getPrisma: () => mod.prismaFake };
 *   });
 */

type AnyRow = Record<string, any>;

const users = new Map<string, AnyRow>();
const journal = new Map<string, AnyRow>(); // keyed by id

/**
 * Apply a Prisma-style `data` patch onto a row, honoring atomic numeric ops
 * (`{ increment }` / `{ decrement }` / `{ set }`) and skipping `undefined`.
 */
function applyData(row: AnyRow, data: AnyRow): void {
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined) continue;
    if (v !== null && typeof v === "object" && !(v instanceof Date)) {
      if ("increment" in v) {
        row[k] = (row[k] ?? 0) + (v as { increment: number }).increment;
        continue;
      }
      if ("decrement" in v) {
        row[k] = (row[k] ?? 0) - (v as { decrement: number }).decrement;
        continue;
      }
      if ("set" in v) {
        row[k] = (v as { set: unknown }).set;
        continue;
      }
    }
    row[k] = v;
  }
}

/** Minimal Prisma-style where matcher: AND of keys, OR arrays, and {lt,lte,gt,gte,equals,in}. */
function matchWhere(row: AnyRow, where: AnyRow): boolean {
  for (const [key, cond] of Object.entries(where)) {
    if (key === "OR") {
      if (!(cond as AnyRow[]).some((c) => matchWhere(row, c))) return false;
      continue;
    }
    if (key === "AND") {
      if (!(cond as AnyRow[]).every((c) => matchWhere(row, c))) return false;
      continue;
    }
    const value = row[key];
    if (cond !== null && typeof cond === "object" && !(cond instanceof Date)) {
      for (const [op, operand] of Object.entries(cond as AnyRow)) {
        if (op === "lt" && !(value < operand)) return false;
        else if (op === "lte" && !(value <= operand)) return false;
        else if (op === "gt" && !(value > operand)) return false;
        else if (op === "gte" && !(value >= operand)) return false;
        else if (op === "equals" && value !== operand) return false;
        else if (op === "in" && !(operand as any[]).includes(value)) return false;
      }
    } else if (value !== cond) {
      return false;
    }
  }
  return true;
}

function journalByOpTx(opTx: string): AnyRow | undefined {
  for (const row of journal.values()) if (row.operatorTransactionId === opTx) return row;
  return undefined;
}

function newJournalRow(d: AnyRow): AnyRow {
  const now = new Date();
  return {
    id: d.id ?? randomUUID(),
    operatorTransactionId: d.operatorTransactionId,
    type: d.type,
    status: d.status ?? "PENDING",
    playerId: d.playerId ?? null,
    providerRef: d.providerRef ?? null,
    ledgerTransactionId: d.ledgerTransactionId ?? null,
    requestPayload: d.requestPayload ?? null,
    retryable: d.retryable ?? false,
    attempts: d.attempts ?? 0,
    lastError: d.lastError ?? null,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Normalize a `$queryRaw` invocation to `{ text, values }`. Prisma accepts both a tagged
 * template (`$queryRaw\`...\``) and a `Prisma.sql\`...\`` fragment object; the gateway's
 * repository + claim use the latter.
 */
function readRawQuery(q: any, rest: unknown[]): { text: string; values: unknown[] } {
  if (Array.isArray(q) && "raw" in q) {
    return { text: (q as string[]).join(" "), values: rest };
  }
  if (q && Array.isArray(q.strings)) {
    return { text: (q.strings as string[]).join(" "), values: (q.values as unknown[]) ?? [] };
  }
  return { text: String(q), values: rest };
}

export const prismaFake = {
  user: {
    findUnique: async ({ where }: any) => {
      const u = users.get(where.id);
      return u ? { ...u } : null;
    },
    update: async ({ where, data }: any) => {
      const u = users.get(where.id);
      if (!u) throw new Error(`user ${where.id} not found`);
      applyData(u, data);
      return { ...u };
    },
  },
  engineRequestLog: {
    upsert: async ({ where, update, create }: any) => {
      const existing = journalByOpTx(where.operatorTransactionId);
      if (existing) {
        applyData(existing, update);
        existing.updatedAt = new Date();
        return { ...existing };
      }
      const row = newJournalRow(create);
      journal.set(row.id, row);
      return { ...row };
    },
    // Idempotent intent create (createIntentIfAbsent). `skipDuplicates` collapses a repeated
    // deterministic key to the single existing row, mirroring `ON CONFLICT DO NOTHING`.
    createMany: async ({ data, skipDuplicates }: any) => {
      const rows: AnyRow[] = Array.isArray(data) ? data : [data];
      let count = 0;
      for (const d of rows) {
        if (skipDuplicates && journalByOpTx(d.operatorTransactionId)) continue;
        const row = newJournalRow(d);
        journal.set(row.id, row);
        count += 1;
      }
      return { count };
    },
    update: async ({ where, data }: any) => {
      const row = where.id ? journal.get(where.id) : journalByOpTx(where.operatorTransactionId);
      if (!row) throw new Error("engineRequestLog row not found");
      applyData(row, data);
      row.updatedAt = new Date();
      return { ...row };
    },
    findUnique: async ({ where }: any) => {
      const row = where.id ? journal.get(where.id) : journalByOpTx(where.operatorTransactionId);
      return row ? { ...row } : null;
    },
    findMany: async ({ where, orderBy, take }: any) => {
      let rows = [...journal.values()].filter((r) => (where ? matchWhere(r, where) : true));
      if (orderBy?.updatedAt === "asc") {
        rows.sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime());
      }
      if (typeof take === "number") rows = rows.slice(0, take);
      return rows.map((r) => ({ ...r }));
    },
  },

  // Interactive transaction: the fake has no real isolation, so it simply runs the callback
  // against itself (ignoring the isolation/timeout options). `txClient()` is referenced (not
  // `prismaFake` directly) to avoid a self-referential-initializer type cycle.
  $transaction: async (fn: (tx: unknown) => Promise<unknown>, _opts?: unknown): Promise<unknown> =>
    fn(txClient()),

  /**
   * Raw query handler. The gateway runs exactly two raw statements against the journal:
   *   - the reconciler CLAIM (`… FOR UPDATE SKIP LOCKED`) → resolve the single eligible
   *     (PENDING/FAILED, under-budget) row by key; values = [operatorTransactionId, maxAttempts].
   *   - the terminal-transition status read (`SELECT "status" … FOR UPDATE`) used by
   *     markIntentTerminal; values = [operatorTransactionId].
   * With no real lock contention, SKIP LOCKED always finds the eligible row.
   */
  $queryRaw: async (q: any, ...rest: unknown[]): Promise<Array<Record<string, unknown>>> => {
    const { text, values } = readRawQuery(q, rest);
    if (text.includes("SKIP LOCKED")) {
      const [operatorTransactionId, maxAttempts] = values as [string, number];
      const row = journalByOpTx(operatorTransactionId);
      if (row && (row.status === "PENDING" || row.status === "FAILED") && row.attempts < maxAttempts) {
        return [{ id: row.id }];
      }
      return [];
    }
    if (text.includes("FOR UPDATE")) {
      const [operatorTransactionId] = values as [string];
      const row = journalByOpTx(operatorTransactionId);
      return row ? [{ status: row.status }] : [];
    }
    return [];
  },
};

/** Late-bound accessor so {@link prismaFake}'s `$transaction` doesn't self-reference its initializer. */
function txClient(): unknown {
  return prismaFake;
}

// ── Test helpers ───────────────────────────────────────────────────────────
export function resetDb(): void {
  users.clear();
  journal.clear();
}

export function seedUser(u: {
  id: string;
  email?: string;
  kycStatus?: string;
  trueEnginePlayerId?: string | null;
}): void {
  users.set(u.id, {
    id: u.id,
    email: u.email ?? null,
    kycStatus: u.kycStatus ?? "PENDING",
    trueEnginePlayerId: u.trueEnginePlayerId ?? null,
  });
}

export function seedJournalRow(row: AnyRow): void {
  const full = { ...newJournalRow(row), ...row };
  if (!full.createdAt) full.createdAt = new Date();
  if (!full.updatedAt) full.updatedAt = new Date();
  journal.set(full.id, full);
}

export function getJournal(opTx: string): AnyRow | undefined {
  const row = journalByOpTx(opTx);
  return row ? { ...row } : undefined;
}
