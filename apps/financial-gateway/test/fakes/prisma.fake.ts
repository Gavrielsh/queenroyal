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

// Rows in this fake mirror Prisma model rows loosely; the value type stays wide because
// the fake stores whatever a test hands it. Named once here so the looseness is declared in
// a single place instead of re-spelled as `any` at every call site.
type AnyRow = Record<string, unknown>;

/** The shape of a Prisma delegate argument object, as far as this fake needs it. */
type QueryArgs = {
  where?: AnyRow;
  data?: AnyRow | AnyRow[];
  create?: AnyRow;
  update?: AnyRow;
  orderBy?: AnyRow;
  take?: number;
  skipDuplicates?: boolean;
};

/** A tagged-template argument accepted by $queryRaw / $executeRaw. */
type RawQuery = TemplateStringsArray | { strings?: unknown; values?: unknown } | string;

const users = new Map<string, AnyRow>();
const journal = new Map<string, AnyRow>(); // keyed by id
const redemptions = new Map<string, AnyRow>(); // keyed by id
const amoeGrants = new Map<string, AnyRow>(); // keyed by id
const kycVerifications = new Map<string, AnyRow>(); // keyed by id
const kycDocuments = new Map<string, AnyRow>(); // keyed by id
const kycWebhookEvents = new Map<string, AnyRow>(); // keyed by id

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
        else if (op === "in" && !(operand as unknown[]).includes(value)) return false;
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
function readRawQuery(q: RawQuery, rest: unknown[]): { text: string; values: unknown[] } {
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
    findUnique: async ({ where }: QueryArgs) => {
      if (where.email !== undefined) {
        for (const u of users.values()) if (u.email === where.email) return { ...u };
        return null;
      }
      const u = users.get(where.id);
      return u ? { ...u } : null;
    },
    // Upsert by unique email (mockLogin) or id, filling Prisma schema defaults on create.
    upsert: async ({ where, create, update }: QueryArgs) => {
      let existing: AnyRow | undefined;
      if (where.email !== undefined) {
        existing = [...users.values()].find((u) => u.email === where.email);
      } else {
        existing = users.get(where.id);
      }
      if (existing) {
        applyData(existing, update);
        existing.updatedAt = new Date();
        return { ...existing };
      }
      const now = new Date();
      const row: AnyRow = {
        id: create.id ?? randomUUID(),
        email: create.email ?? null,
        passwordHash: create.passwordHash ?? null,
        kycStatus: create.kycStatus ?? "PENDING",
        vipLevel: create.vipLevel ?? 0,
        trueEnginePlayerId: create.trueEnginePlayerId ?? null,
        createdAt: now,
        updatedAt: now,
      };
      users.set(row.id, row);
      return { ...row };
    },
    update: async ({ where, data }: QueryArgs) => {
      const u = users.get(where.id);
      if (!u) throw new Error(`user ${where.id} not found`);
      applyData(u, data);
      return { ...u };
    },
  },
  engineRequestLog: {
    upsert: async ({ where, update, create }: QueryArgs) => {
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
    createMany: async ({ data, skipDuplicates }: QueryArgs) => {
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
    update: async ({ where, data }: QueryArgs) => {
      const row = where.id ? journal.get(where.id) : journalByOpTx(where.operatorTransactionId);
      if (!row) throw new Error("engineRequestLog row not found");
      applyData(row, data);
      row.updatedAt = new Date();
      return { ...row };
    },
    findUnique: async ({ where }: QueryArgs) => {
      const row = where.id ? journal.get(where.id) : journalByOpTx(where.operatorTransactionId);
      return row ? { ...row } : null;
    },
    findMany: async ({ where, orderBy, take }: QueryArgs) => {
      let rows = [...journal.values()].filter((r) => (where ? matchWhere(r, where) : true));
      if (orderBy?.updatedAt === "asc") {
        rows.sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime());
      }
      if (typeof take === "number") rows = rows.slice(0, take);
      return rows.map((r) => ({ ...r }));
    },
    // Bulk delete (retention sweeper): remove every row matching `where`, return the count.
    deleteMany: async ({ where }: QueryArgs) => {
      let count = 0;
      for (const [id, row] of journal) {
        if (!where || matchWhere(row, where)) {
          journal.delete(id);
          count += 1;
        }
      }
      return { count };
    },
  },

  redemptionRequest: {
    create: async ({ data }: QueryArgs) => {
      const now = new Date();
      const row: AnyRow = {
        id: randomUUID(),
        ledgerTransactionId: null,
        statusChangedAt: now,
        reviewedBy: null,
        reviewedAt: null,
        decisionReason: null,
        payoutProviderRef: null,
        paidAt: null,
        cancelledAt: null,
        refundLedgerTransactionId: null,
        refundedAt: null,
        createdAt: now,
        updatedAt: now,
        ...data,
      };
      redemptions.set(row.id, row);
      return { ...row };
    },
    update: async ({ where, data }: QueryArgs) => {
      const row = redemptions.get(where.id);
      if (!row) throw new Error("redemptionRequest row not found");
      applyData(row, data);
      row.updatedAt = new Date();
      return { ...row };
    },
    findUnique: async ({ where }: QueryArgs) => {
      const row = redemptions.get(where.id);
      return row ? { ...row } : null;
    },
    // Conditional update — the worker's compare-and-set. Matches only rows satisfying EVERY
    // clause in `where`, so a status precondition is honoured exactly as Postgres would.
    updateMany: async ({ where, data }: QueryArgs) => {
      let count = 0;
      for (const row of redemptions.values()) {
        if (where.id !== undefined && row.id !== where.id) continue;
        if (where.status !== undefined && row.status !== where.status) continue;
        applyData(row, data);
        row.updatedAt = new Date();
        count += 1;
      }
      return { count };
    },
    findMany: async ({ where, select }: QueryArgs) => {
      const rows = [...redemptions.values()].filter((r) => {
        if (!where) return true;
        if (where.playerId !== undefined && r.playerId !== where.playerId) return false;
        if (where.status?.in && !where.status.in.includes(r.status)) return false;
        if (where.createdAt?.gte && r.createdAt < where.createdAt.gte) return false;
        return true;
      });
      if (!select) return rows.map((r) => ({ ...r }));
      return rows.map((r) => {
        const out: AnyRow = {};
        for (const k of Object.keys(select)) if (select[k]) out[k] = r[k];
        return out;
      });
    },
  },

  amoeGrant: {
    /**
     * `create` ENFORCES THE (userId, grantPeriod) UNIQUE INDEX, throwing a P2002-shaped error
     * exactly as Postgres would.
     *
     * This is the one place the fake must not be lenient. That index IS the frequency cap —
     * the Zone 1 endpoint behind this flow applies none of its own — so a fake that quietly
     * accepted a duplicate would let the cap's tests pass against a fake that does not have
     * the cap. The error shape matches what the service's `isUniqueViolation` looks for, so
     * the refusal path under test is the real one.
     */
    create: async ({ data }: QueryArgs) => {
      const row = data as AnyRow;
      for (const existing of amoeGrants.values()) {
        if (existing.userId === row.userId && existing.grantPeriod === row.grantPeriod) {
          throw Object.assign(new Error("Unique constraint failed on the fields: (`userId`,`grantPeriod`)"), {
            code: "P2002",
            meta: { target: ["userId", "grantPeriod"] },
          });
        }
        if (existing.userId === row.userId && existing.claimAttemptKey === row.claimAttemptKey) {
          throw Object.assign(new Error("Unique constraint failed on the fields: (`userId`,`claimAttemptKey`)"), {
            code: "P2002",
            meta: { target: ["userId", "claimAttemptKey"] },
          });
        }
        if (existing.operatorTransactionId === row.operatorTransactionId) {
          throw Object.assign(new Error("Unique constraint failed on the fields: (`operatorTransactionId`)"), {
            code: "P2002",
            meta: { target: ["operatorTransactionId"] },
          });
        }
      }
      const now = new Date();
      const full: AnyRow = {
        id: randomUUID(),
        status: "REQUESTED",
        ledgerTransactionId: null,
        claimIp: null,
        claimJurisdiction: null,
        failureReason: null,
        createdAt: now,
        updatedAt: now,
        ...row,
      };
      amoeGrants.set(full.id as string, full);
      return { ...full };
    },
    update: async ({ where, data }: QueryArgs) => {
      const row = amoeGrants.get(where?.id as string);
      if (!row) throw new Error("amoeGrant row not found");
      applyData(row, data as AnyRow);
      row.updatedAt = new Date();
      return { ...row };
    },
    /**
     * Supports the `id` lookup and BOTH compound selectors Prisma generates for this model's
     * two uniques — `userId_grantPeriod` (the period cap's pre-flight read) and
     * `userId_claimAttemptKey` (the attempt replay). A fake that answered only one would let
     * the other's tests pass against a lookup that always returned null.
     */
    findUnique: async ({ where }: QueryArgs) => {
      if (where?.id !== undefined) {
        const row = amoeGrants.get(where.id as string);
        return row ? { ...row } : null;
      }
      const byPeriod = where?.userId_grantPeriod as { userId: string; grantPeriod: string } | undefined;
      if (byPeriod) {
        for (const row of amoeGrants.values()) {
          if (row.userId === byPeriod.userId && row.grantPeriod === byPeriod.grantPeriod) return { ...row };
        }
        return null;
      }
      const byAttempt = where?.userId_claimAttemptKey as { userId: string; claimAttemptKey: string } | undefined;
      if (byAttempt) {
        for (const row of amoeGrants.values()) {
          if (row.userId === byAttempt.userId && row.claimAttemptKey === byAttempt.claimAttemptKey) return { ...row };
        }
        return null;
      }
      return null;
    },
    findMany: async ({ where }: QueryArgs) => {
      return [...amoeGrants.values()]
        .filter((r) => {
          if (!where) return true;
          if (where.userId !== undefined && r.userId !== where.userId) return false;
          if (where.grantPeriod !== undefined && r.grantPeriod !== where.grantPeriod) return false;
          if (where.status !== undefined && r.status !== where.status) return false;
          return true;
        })
        .map((r) => ({ ...r }));
    },
    count: async ({ where }: QueryArgs) => {
      let n = 0;
      for (const r of amoeGrants.values()) {
        if (where?.userId !== undefined && r.userId !== where.userId) continue;
        if (where?.grantPeriod !== undefined && r.grantPeriod !== where.grantPeriod) continue;
        n += 1;
      }
      return n;
    },
  },

  kycVerification: {
    /** Upsert on the provider case ref — the "one row per case" rule the real unique enforces. */
    upsert: async ({ where, create, update }: QueryArgs) => {
      const ref = where?.providerCaseRef as string | undefined;
      const existing = [...kycVerifications.values()].find((r) => r.providerCaseRef === ref);
      if (existing) {
        applyData(existing, (update ?? {}) as AnyRow);
        existing.updatedAt = new Date();
        return { ...existing };
      }
      const now = new Date();
      const row: AnyRow = {
        id: randomUUID(),
        status: "PENDING",
        decisionReason: null,
        decidedAt: null,
        createdAt: now,
        updatedAt: now,
        ...(create as AnyRow),
      };
      kycVerifications.set(row.id as string, row);
      return { ...row };
    },
    findUnique: async ({ where }: QueryArgs) => {
      if (where?.id !== undefined) {
        const row = kycVerifications.get(where.id as string);
        return row ? { ...row } : null;
      }
      if (where?.providerCaseRef !== undefined) {
        for (const row of kycVerifications.values()) {
          if (row.providerCaseRef === where.providerCaseRef) return { ...row };
        }
      }
      return null;
    },
    update: async ({ where, data }: QueryArgs) => {
      const row = kycVerifications.get(where?.id as string);
      if (!row) throw new Error("kycVerification row not found");
      applyData(row, data as AnyRow);
      row.updatedAt = new Date();
      return { ...row };
    },
    findMany: async ({ where }: QueryArgs) => {
      return [...kycVerifications.values()]
        .filter((r) => (where?.userId === undefined ? true : r.userId === where.userId))
        .map((r) => ({ ...r }));
    },
  },

  kycDocument: {
    create: async ({ data }: QueryArgs) => {
      const row = data as AnyRow;
      for (const existing of kycDocuments.values()) {
        if (existing.providerUploadRef === row.providerUploadRef) {
          throw Object.assign(new Error("Unique constraint failed on the fields: (`providerUploadRef`)"), {
            code: "P2002",
            meta: { target: ["providerUploadRef"] },
          });
        }
      }
      const full: AnyRow = { id: randomUUID(), createdAt: new Date(), ...row };
      kycDocuments.set(full.id as string, full);
      return { ...full };
    },
    findMany: async ({ where }: QueryArgs) => {
      return [...kycDocuments.values()]
        .filter((r) => {
          if (!where) return true;
          if (where.userId !== undefined && r.userId !== where.userId) return false;
          if (where.verificationId !== undefined && r.verificationId !== where.verificationId) return false;
          return true;
        })
        .map((r) => ({ ...r }));
    },
    count: async ({ where }: QueryArgs) => {
      let n = 0;
      for (const r of kycDocuments.values()) {
        if (where?.userId !== undefined && r.userId !== where.userId) continue;
        n += 1;
      }
      return n;
    },
  },

  kycWebhookEvent: {
    /**
     * `create` ENFORCES the providerEventId unique, throwing a P2002-shaped error exactly as
     * Postgres would.
     *
     * This is the one place the fake must not be lenient. That unique IS the webhook's
     * idempotency — there is no status check behind it — so a fake that quietly accepted a
     * duplicate would let the idempotency tests pass against a fake that has no idempotency.
     */
    create: async ({ data }: QueryArgs) => {
      const row = data as AnyRow;
      for (const existing of kycWebhookEvents.values()) {
        if (existing.providerEventId === row.providerEventId) {
          throw Object.assign(new Error("Unique constraint failed on the fields: (`providerEventId`)"), {
            code: "P2002",
            meta: { target: ["providerEventId"] },
          });
        }
      }
      const full: AnyRow = { id: randomUUID(), receivedAt: new Date(), ...row };
      kycWebhookEvents.set(full.id as string, full);
      return { ...full };
    },
    findUnique: async ({ where }: QueryArgs) => {
      if (where?.providerEventId !== undefined) {
        for (const row of kycWebhookEvents.values()) {
          if (row.providerEventId === where.providerEventId) return { ...row };
        }
      }
      return null;
    },
    update: async ({ where, data }: QueryArgs) => {
      const ref = where?.providerEventId as string | undefined;
      for (const row of kycWebhookEvents.values()) {
        if (row.providerEventId === ref) {
          applyData(row, data as AnyRow);
          return { ...row };
        }
      }
      throw new Error("kycWebhookEvent row not found");
    },
    findMany: async () => [...kycWebhookEvents.values()].map((r) => ({ ...r })),
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
  $queryRaw: async (q: RawQuery, ...rest: unknown[]): Promise<Array<Record<string, unknown>>> => {
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
  redemptions.clear();
  amoeGrants.clear();
  kycVerifications.clear();
  kycDocuments.clear();
  kycWebhookEvents.clear();
}

/** Every redemption row, newest last. Lets a test assert the orchestration row's lifecycle. */
export function getRedemptions(): AnyRow[] {
  return [...redemptions.values()].map((r) => ({ ...r }));
}

/** Seed a prior redemption so the period-cap sums have something to count. */
export function seedRedemption(row: AnyRow): void {
  const now = new Date();
  // Every nullable column defaults to null, as Prisma returns them — so a test asserting
  // `paidAt` is null is asserting the same thing it would against a real database, not the
  // absence of a key in a fixture.
  const full: AnyRow = {
    id: row.id ?? randomUUID(),
    status: "REQUESTED",
    ledgerTransactionId: null,
    reviewedBy: null,
    reviewedAt: null,
    decisionReason: null,
    payoutProviderRef: null,
    paidAt: null,
    cancelledAt: null,
    refundLedgerTransactionId: null,
    refundedAt: null,
    createdAt: now,
    updatedAt: now,
    statusChangedAt: now,
    ...row,
  };
  redemptions.set(full.id, full);
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

/** Every AMOE grant row, newest last. Lets a test assert the claim's lifecycle. */
export function getAmoeGrants(): AnyRow[] {
  return [...amoeGrants.values()].map((r) => ({ ...r }));
}

/** Seed a prior AMOE grant so the period cap has something to refuse against. */
export function seedAmoeGrant(row: AnyRow): void {
  const now = new Date();
  // Every nullable column defaults to null, as Prisma returns them.
  const full: AnyRow = {
    id: row.id ?? randomUUID(),
    status: "GRANTED",
    ledgerTransactionId: null,
    claimIp: null,
    claimJurisdiction: null,
    failureReason: null,
    createdAt: now,
    updatedAt: now,
    ...row,
  };
  amoeGrants.set(full.id as string, full);
}

/** Every KYC verification row. Lets a test assert the case's lifecycle. */
export function getKycVerifications(): AnyRow[] {
  return [...kycVerifications.values()].map((r) => ({ ...r }));
}

/** Every KYC document METADATA row — never a file; the model has no column for one. */
export function getKycDocuments(): AnyRow[] {
  return [...kycDocuments.values()].map((r) => ({ ...r }));
}

/** Every processed KYC webhook event. The idempotency ledger. */
export function getKycWebhookEvents(): AnyRow[] {
  return [...kycWebhookEvents.values()].map((r) => ({ ...r }));
}
