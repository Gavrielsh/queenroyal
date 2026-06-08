import { randomUUID } from "node:crypto";

/**
 * In-memory Prisma fake implementing exactly the `user` and `engineRequestLog` operations
 * the services use. It lets the integration tests exercise the real service + reconciler
 * code against a controllable journal/outbox without a database.
 */

type AnyRow = Record<string, any>;

const users = new Map<string, AnyRow>();
const journal = new Map<string, AnyRow>(); // keyed by id

function stripUndefined(obj: AnyRow): AnyRow {
  const out: AnyRow = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
  return out;
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

export const prismaFake = {
  user: {
    findUnique: async ({ where }: any) => {
      const u = users.get(where.id);
      return u ? { ...u } : null;
    },
    update: async ({ where, data }: any) => {
      const u = users.get(where.id);
      if (!u) throw new Error(`user ${where.id} not found`);
      Object.assign(u, stripUndefined(data));
      return { ...u };
    },
  },
  engineRequestLog: {
    upsert: async ({ where, update, create }: any) => {
      const existing = journalByOpTx(where.operatorTransactionId);
      if (existing) {
        Object.assign(existing, stripUndefined(update));
        existing.updatedAt = new Date();
        return { ...existing };
      }
      const now = new Date();
      const row: AnyRow = {
        id: create.id ?? randomUUID(),
        operatorTransactionId: create.operatorTransactionId,
        type: create.type,
        status: create.status ?? "PENDING",
        playerId: create.playerId ?? null,
        providerRef: create.providerRef ?? null,
        ledgerTransactionId: create.ledgerTransactionId ?? null,
        requestPayload: create.requestPayload ?? null,
        retryable: create.retryable ?? false,
        attempts: create.attempts ?? 0,
        lastError: create.lastError ?? null,
        createdAt: now,
        updatedAt: now,
      };
      journal.set(row.id, row);
      return { ...row };
    },
    update: async ({ where, data }: any) => {
      const row = where.id ? journal.get(where.id) : journalByOpTx(where.operatorTransactionId);
      if (!row) throw new Error("engineRequestLog row not found");
      Object.assign(row, stripUndefined(data));
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
};

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
  const now = new Date();
  const full: AnyRow = {
    id: randomUUID(),
    status: "PENDING",
    playerId: null,
    providerRef: null,
    ledgerTransactionId: null,
    requestPayload: null,
    retryable: false,
    attempts: 0,
    lastError: null,
    createdAt: now,
    updatedAt: now,
    ...row,
  };
  journal.set(full.id, full);
}

export function getJournal(opTx: string): AnyRow | undefined {
  const row = journalByOpTx(opTx);
  return row ? { ...row } : undefined;
}
