# 🏛️ Sweepstakes Casino — Architecture Blueprint

## 📌 Overview
A high-frequency US Social Sweepstakes Casino built on a **Zero-Trust** separation of
concerns. Three decoupled zones:

1. **The Core Ledger ("True Engine" — Go)** — the single source of truth for all money.
2. **The Fastify Gateway & Cashier (Standalone Microservice)** — security perimeter, B2B adapter,
   and orchestrator. **Holds zero money.**
3. **The Frontend (Next.js App Router)** — presentation and UI only.

> This document is kept in lock-step with the **actual** True Engine source. Where it
> describes the engine's contract, the engine code (`internal/api`, `internal/domain`,
> `internal/repository`, `migrations/`) is authoritative.

---

## 🏗️ Zone 1: The Core Ledger ("True Engine")
**Status: COMPLETED & SEALED.** *(Do NOT modify it, compute balances, or write SQL that
bypasses it.)*

* **Stack:** Go, PostgreSQL, Redis.
* **Role:** ACID double-entry bookkeeping ledger. Maintains strict separation of `GC`,
  `SC_UNPLAYED`, and `SC_REDEEMABLE`; pessimistic `SELECT … FOR UPDATE`; append-only
  ledger with offsetting `ROLLBACK` entries (no in-place mutation).
* **Money model — DECIMAL, not integer:** every amount is `NUMERIC(18,4)` (whole-coin
  units, 4 dp) and is sent/received on the wire as a **JSON string** (`"12.3400"`) to
  preserve precision across JS/Java decoders. Integer "cents" are NOT used. *(This
  corrects a prior misconception in this doc — there are no integer minor-units.)*
* **Idempotency / Ghost-Spin:** deduplicates on the body field
  `operator_transaction_id` (scoped per operator). A duplicate raises Postgres `23505`,
  which the engine catches to reconstruct and replay the original result **without
  re-deducting** funds. Safe retries therefore REQUIRE a **stable** key.
* **Security (every `/api/v1/*` call):** HMAC-SHA256 over the **raw body** in
  `X-Signature` (constant-time compared), an operator selector `X-Operator-Code`
  (per-operator secret), plus ReplayGuard: `X-Timestamp` (reject > 300s old) and a
  single-use `X-Nonce` cached in Redis. All four headers are mandatory.

### Engine API (authoritative — `internal/api/router.go`)
| Method & Path                 | Purpose                                                  |
|-------------------------------|----------------------------------------------------------|
| `POST /api/v1/bet`            | Debit a wager (GC or SC family).                         |
| `POST /api/v1/win`            | Credit a win (SC wins land in SC_REDEEMABLE).            |
| `POST /api/v1/rollback`       | Reverse a committed BET by its `ledger_transaction_id`.  |
| `GET  /api/v1/session`        | Read balances (`?player_id=`).                           |
| `POST /api/v1/player/create`  | Provision a player (idempotent on `external_id`).        |
| `POST /api/v1/store/purchase` | Fiat purchase → issue GC (+ optional SC_UNPLAYED promo). |
| `POST /api/v1/store/redeem`   | Fiat redemption from SC_REDEEMABLE only.                 |

**Success:** `{ "code":"OK", "result": { operator_transaction_id, ledger_transaction_id,
player_id, transaction_type, family, amount, post_balances:{ gc, sc_unplayed,
sc_redeemable }, status:"PROCESSED"|"CACHED"|"GHOST_RECOVERED" } }` (money = strings).
**Error:** `{ "code":"…", "message":"…", "trace_id":"…" }`. Status codes drive retries:
`409`/`5xx`/timeout = retry with the same key; `4xx` = terminal.

---

## 🛡️ Zone 2: The Gateway & Cashier (Standalone Microservice)
**Status: CURRENT FOCUS (Migrating to Fastify).**

* **Stack:** Fastify, TypeScript (strict), Prisma (Singleton via PgBouncer) → Postgres (non-financial). Next.js has been strictly removed from the API layer to eliminate latency and memory bloat.

### Rule #1 — Zero Financial State
The local DB holds **identity, KYC, VIP, store catalog, the True `player_id` mapping,
and an append-only intent journal** — and absolutely **no** `gc_balance`, `sc_balance`,
`deposits`, or `withdrawals`. Balances live only in the engine.

### Rule #2 — Money is a validated decimal string
All monetary values are validated decimal strings (`^\d+(\.\d{1,4})?$`, ≤ 4 dp) and
forwarded **verbatim**. No `Number()`/`parseFloat`/`z.number()` ever touches money.

### Rule #3 — Outbound HMAC + replay headers
Every engine call carries `X-Operator-Code`, `X-Signature` (HMAC of raw body with
`ENGINE_SECRET_KEY`), a fresh `X-Timestamp`, and a fresh `X-Nonce`.

### Rule #4 — Deterministic idempotency
`operator_transaction_id` is derived from a stable upstream reference (game provider
txn id for spins, PSP `payment_ref` for purchases), generated once and reused on retry.

### Rule #5 — Strict Fail-Closed (No Local State)
The gateway relies exclusively on Redis for Rate Limiting, Replay Protection, and Circuit Breaking. There are no local memory (`Map` or `Set`) fallbacks. If Redis is unreachable, the gateway fails elegantly and returns `503 Service Unavailable` to prevent untracked traffic.

### Components
1. **Auth Service** — registers users (bcrypt + JWT), and **provisions** each user in the
   engine via `/player/create`, persisting `trueEnginePlayerId`.
2. **Cashier Service** — charges the PSP (Stripe; integer USD cents is correct *for the
   PSP only*), then instructs `/store/purchase` to issue GC + SC_UNPLAYED, journaling the
   intent for crash recovery.
3. **B2B Game Adapter (Fastify Plugin)** — **webhook receiver** for external Game Aggregators. Uses Fastify `preHandler` hooks to verify the provider's inbound HMAC + timestamp + nonce directly on the **raw body** *before* JSON parsing occurs. Translates the proprietary payload into the engine DTO, signs it, and forwards it. **Players do not call this route and cannot supply their own win amounts.**

### Identity bridge
Our `User.id` ≠ engine `player_id`. We register as the engine's `external_id` and store
the engine-issued `player_id`. Every money call uses `trueEnginePlayerId`.

### Resilience — The Intent Journal & Distributed Locks
`EngineRequestLog` (append-only, no balances) records each money intent (`operator_transaction_id`, type, status, refs). It uses 3 strict DB locking strategies to prevent double-spending:
1. **Idempotency Setup:** `UNIQUE` constraint on `operator_transaction_id` + `ON CONFLICT DO NOTHING`.
2. **State Transitions:** `SERIALIZABLE` isolation + `SELECT ... FOR UPDATE` to ensure late webhooks cannot overwrite settled intents.
3. **Outbox Claiming:** `READ COMMITTED` + `FOR UPDATE SKIP LOCKED` for lightning-fast, collision-free event polling across multiple worker nodes.

---

## 💻 Zone 3: The Showroom (Frontend)
**Status: PENDING.** Pure presentation. Never computes win/loss. Subscribes to a
real-time channel; when the engine confirms a bet/win it renders the engine's
authoritative balances. Balances are strings — render, don't arithmetic. All Next.js logic acts solely as UI (Zone 3), decoupled from the Fastify backend (Zone 2).

---

## 🚀 Execution Contract
1. **No financial mocks.** Never add a `balance` field "just to make it work."
2. **Money is a string.** Validate shape, reject > 4 dp, forward verbatim. No floats, no
   integer cents.
3. **Deterministic idempotency.** Stable `operator_transaction_id` from an upstream ref;
   fresh `X-Nonce` per attempt.
4. **Verify inbound, sign outbound.** B2B webhooks are HMAC-verified via Fastify `preHandler` before any engine call; engine calls carry all four security headers.
5. **Fail-Closed & Event-Driven.** Map engine `4xx/5xx`/timeouts to clean JSON. Never crash Node. Reconciler drops legacy `setInterval` DB polling in favor of Redis-backed Dead Letter Queues (DLQ) and distributed locks.