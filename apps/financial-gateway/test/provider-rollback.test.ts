import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Replace the Prisma singleton with the in-memory fake (shared instance with the helpers).
vi.mock("../src/lib/prisma", async () => {
  const mod = await import("./fakes/prisma.fake");
  return { getPrisma: () => mod.prismaFake };
});

import { setReconcileQueue } from "../src/lib/reconcile-queue";
import { processProviderRollback } from "../src/services/game-adapter.service";
import { type Directive, type EngineCall, engineCalls, resetEngine, setEngineHandler } from "./fakes/engine.fake";
import { getJournal, resetDb, seedJournalRow, seedUser } from "./fakes/prisma.fake";
import { ReconcileQueueFake } from "./fakes/reconcile-queue.fake";

const PROVIDER = "PRAGMATIC";
const USER_ID = "33333333-3333-4333-8333-333333333333";
const ENGINE_PLAYER_ID = "engine-player-rb";
const REF = "bet-ref-1"; // the ORIGINAL bet's provider_transaction_id
const BET_LEDGER = "ltx-bet-1"; // the bet's engine ledger_transaction_id

let queue: ReconcileQueueFake;

const unexpected: Directive = { ok: false, status: 500, body: { code: "UNEXPECTED" } };

function okRollback(operatorTransactionId: string, ledgerTxId: string): Directive {
  return {
    ok: true,
    status: 200,
    body: {
      code: "OK",
      result: {
        operator_code: "QUEENROYAL",
        operator_transaction_id: operatorTransactionId,
        ledger_transaction_id: ledgerTxId,
        player_id: ENGINE_PLAYER_ID,
        transaction_type: "ROLLBACK",
        family: "SC",
        amount: "5",
        post_balances: { gc: "0", sc_unplayed: "5", sc_redeemable: "0" },
        status: "PROCESSED",
      },
    },
  };
}

/** Seed a SUCCEEDED bet journal row (`bet:<ref>`) carrying its engine ledger id. */
function seedCommittedBet(ref = REF, ledgerTxId = BET_LEDGER, playerId = ENGINE_PLAYER_ID): void {
  seedJournalRow({
    operatorTransactionId: `bet:${ref}`,
    type: "BET",
    status: "SUCCEEDED",
    playerId,
    providerRef: ref,
    ledgerTransactionId: ledgerTxId,
    requestPayload: {
      operator_transaction_id: `bet:${ref}`,
      player_id: playerId,
      currency: "SC",
      amount: "5",
    },
  });
}

function input(overrides: Partial<{ provider_transaction_id: string; player_id: string; reference_transaction_id: string }> = {}) {
  return {
    provider_transaction_id: overrides.provider_transaction_id ?? "rb-1",
    player_id: overrides.player_id ?? USER_ID,
    reference_transaction_id: overrides.reference_transaction_id ?? REF,
  };
}

const rollbackCalls = (): EngineCall[] => engineCalls.filter((c) => c.path === "/api/v1/rollback");

beforeEach(() => {
  resetDb();
  resetEngine();
  queue = new ReconcileQueueFake();
  setReconcileQueue(queue);
  seedUser({ id: USER_ID, email: "rb@test.io", kycStatus: "VERIFIED", trueEnginePlayerId: ENGINE_PLAYER_ID });
});

afterEach(() => {
  setReconcileQueue(null);
});

describe("processProviderRollback (B2B aggregator rollback adapter)", () => {
  it("reverses a committed bet, keyed off the ORIGINAL bet (rollback:<ref>), via the engine's ledger id", async () => {
    seedCommittedBet();
    setEngineHandler((call: EngineCall) =>
      call.path === "/api/v1/rollback" ? okRollback(call.body.operator_transaction_id, "ltx-rb-1") : unexpected,
    );

    const outcome = await processProviderRollback(PROVIDER, input());

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.data.status).toBe("reversed");
    expect(outcome.data.rollback?.ledger_transaction_id).toBe("ltx-rb-1");

    // Exactly one reversal reached the engine, addressing the BET by its ledger id, under the
    // deterministic key the reconciler's win-compensation ALSO uses (so the two unify).
    const calls = rollbackCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body.operator_transaction_id).toBe(`rollback:${REF}`);
    expect(calls[0]?.body.reference_transaction_id).toBe(BET_LEDGER);

    // The rollback intent is journaled terminal.
    expect(getJournal(`rollback:${REF}`)?.status).toBe("SUCCEEDED");
    expect(getJournal(`rollback:${REF}`)?.ledgerTransactionId).toBe("ltx-rb-1");
  });

  it("is an idempotent VOID no-op (200) when no bet was ever journaled — never calls the engine", async () => {
    setEngineHandler(() => unexpected);

    const outcome = await processProviderRollback(PROVIDER, input());

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.data.status).toBe("noop");
    expect(rollbackCalls()).toHaveLength(0);
  });

  it("is a no-op (200) when the originating bet terminally FAILED (never debited)", async () => {
    seedJournalRow({
      operatorTransactionId: `bet:${REF}`,
      type: "BET",
      status: "FAILED",
      retryable: false,
      playerId: ENGINE_PLAYER_ID,
      providerRef: REF,
    });
    setEngineHandler(() => unexpected);

    const outcome = await processProviderRollback(PROVIDER, input());

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.data.status).toBe("noop");
    expect(rollbackCalls()).toHaveLength(0);
  });

  it("DEFERS (409, retryable) when the originating bet is still in flight (PENDING)", async () => {
    seedJournalRow({
      operatorTransactionId: `bet:${REF}`,
      type: "BET",
      status: "PENDING",
      playerId: ENGINE_PLAYER_ID,
      providerRef: REF,
    });
    setEngineHandler(() => unexpected);

    const outcome = await processProviderRollback(PROVIDER, input());

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.status).toBe(409);
    expect(outcome.error.code).toBe("BET_SETTLEMENT_PENDING");
    expect(rollbackCalls()).toHaveLength(0);
  });

  it("treats engine ROLLBACK_ALREADY (409) as an idempotent success (already_reversed)", async () => {
    seedCommittedBet();
    setEngineHandler((call: EngineCall) =>
      call.path === "/api/v1/rollback"
        ? { ok: false, status: 409, body: { code: "ROLLBACK_ALREADY", message: "already rolled back" } }
        : unexpected,
    );

    const outcome = await processProviderRollback(PROVIDER, input());

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.data.status).toBe("already_reversed");
    // FAILED-for-this-attempt is recorded, but the provider sees success and stops retrying.
    expect(getJournal(`rollback:${REF}`)?.status).toBe("FAILED");
  });

  it("treats engine ROLLBACK_NOT_FOUND (404) as an idempotent no-op (nothing to reverse)", async () => {
    seedCommittedBet();
    setEngineHandler((call: EngineCall) =>
      call.path === "/api/v1/rollback"
        ? { ok: false, status: 404, body: { code: "ROLLBACK_NOT_FOUND", message: "not found" } }
        : unexpected,
    );

    const outcome = await processProviderRollback(PROVIDER, input());

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.data.status).toBe("noop");
  });

  it("surfaces a TERMINAL engine rejection (ROLLBACK_UNSUPPORTED 422) verbatim and never enqueues", async () => {
    seedCommittedBet();
    setEngineHandler((call: EngineCall) =>
      call.path === "/api/v1/rollback"
        ? { ok: false, status: 422, body: { code: "ROLLBACK_UNSUPPORTED", message: "not a bet" } }
        : unexpected,
    );

    const outcome = await processProviderRollback(PROVIDER, input());

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.status).toBe(422);
    expect(outcome.error.code).toBe("ROLLBACK_UNSUPPORTED");
    expect(queue.readyCount).toBe(0); // terminal → not handed to the reconciler
    expect(getJournal(`rollback:${REF}`)?.status).toBe("FAILED");
  });

  it("on a RETRYABLE engine failure (timeout) returns 502 AND hands the intent to the reconciler", async () => {
    seedCommittedBet();
    setEngineHandler((call: EngineCall) =>
      call.path === "/api/v1/rollback" ? { throwKind: "timeout" } : unexpected,
    );

    const outcome = await processProviderRollback(PROVIDER, input());

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.status).toBe(502);
    // Durable replay was enqueued under the same deterministic key.
    expect(queue.readyCount).toBe(1);
    const row = getJournal(`rollback:${REF}`);
    expect(row?.status).toBe("FAILED");
    expect(row?.retryable).toBe(true);
  });

  it("rejects with 403 when the player's KYC is REJECTED — never touches the engine", async () => {
    seedUser({ id: USER_ID, email: "rb@test.io", kycStatus: "REJECTED", trueEnginePlayerId: ENGINE_PLAYER_ID });
    seedCommittedBet();
    setEngineHandler(() => unexpected);

    const outcome = await processProviderRollback(PROVIDER, input());

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.status).toBe(403);
    expect(outcome.error.code).toBe("KYC_REJECTED");
    expect(rollbackCalls()).toHaveLength(0);
  });

  it("rejects with 404 PLAYER_NOT_FOUND for an unprovisioned player", async () => {
    setEngineHandler(() => unexpected);

    const outcome = await processProviderRollback(PROVIDER, input({ player_id: "00000000-0000-4000-8000-000000000099" }));

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.status).toBe(404);
    expect(outcome.error.code).toBe("PLAYER_NOT_FOUND");
    expect(rollbackCalls()).toHaveLength(0);
  });

  it("refuses (422) to reverse a bet that belongs to a DIFFERENT player", async () => {
    seedCommittedBet(REF, BET_LEDGER, "engine-player-someone-else");
    setEngineHandler(() => unexpected);

    const outcome = await processProviderRollback(PROVIDER, input());

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.status).toBe(422);
    expect(outcome.error.code).toBe("ROLLBACK_PLAYER_MISMATCH");
    expect(rollbackCalls()).toHaveLength(0);
  });
});
