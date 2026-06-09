# QueenRoyal — Gateway & Cashier

The **"Dumb but Secure" middleman** between frontend players and the Go **"True Engine"**
ledger for a US Social Sweepstakes Casino. This service is an **auth layer, API gateway, and
B2B adapter**. It holds **zero financial state** — the Go engine is the single source of truth
for all GC / SC balances.

## Architecture — three zones

The backend has been fully extracted out of Next.js. The API surface is no longer served by
Next.js route handlers; it lives in a standalone, long-running **Fastify microservice**.

| Zone | Runtime | Responsibility |
| --- | --- | --- |
| **Zone 1 — True Engine** | Go service | The ledger. Sole authority for money. Addressed only over signed HMAC calls. |
| **Zone 2 — Financial Gateway** | **Fastify** (`apps/financial-gateway`) | ALL backend APIs: auth, cashier/store, B2B + PSP webhooks, and the event-driven reconciler worker. Stateless, fail-closed. |
| **Zone 3 — Web UI** | **Next.js 15** (`src/app`) | **UI ONLY.** No backend API routes whatsoever — `src/app/api` has been deleted. The browser talks to the gateway. |

> The gateway is now **100% self-contained**: every backend module (auth, sessions, cashier,
> webhooks, the event-driven reconciler worker, and their tests) lives under
> `apps/financial-gateway`. The Next.js `src/` tree holds only the UI (`src/app`) — the legacy
> `src/lib`, `src/services`, `src/schemas`, and `src/workers` have been removed.

## Architectural guarantees

| Rule | How it's enforced |
| --- | --- |
| **Zero financial state** | The `User` schema holds only `email`, `passwordHash`, `kycStatus`, `vipLevel` (+ the `trueEnginePlayerId` identity bridge). No `gc_balance`/`sc_balance` anywhere (`prisma/schema.prisma`). |
| **Zero-trust / HMAC** | Every outbound engine call signs `HMAC-SHA256` over the exact serialized bytes; every inbound B2B/PSP webhook is HMAC-verified in a Fastify `preHandler` BEFORE the body is parsed. |
| **Idempotency** | Every financial intent carries a deterministic `operator_transaction_id`, journaled in the `engine_request_log` outbox before the call so a crash mid-flight is recoverable. |
| **Decimal money as strings** | Money is a validated decimal **string** (`NUMERIC(18,4)` wire format). JS `number` coercion is forbidden (`apps/financial-gateway/src/lib/money.ts`). |
| **Strict fail-closed (no local state)** | Rate limiting, refresh sessions, replay nonces, and the circuit breaker are Redis-backed. If Redis is down they return **503** — there is no in-memory fallback and no "degraded" mode. |
| **No DB polling** | Reconciliation is **event-driven** (Redis Streams). There are no `setInterval`/cron loops scanning Postgres. |
| **Graceful ledger failure** | The engine client returns a typed `TrueEngineResult` instead of throwing; transport faults map to clean JSON, never a process crash. |

## Reconciliation — event-driven, with a Dead Letter Queue (Phase 5)

The database poller and its `CRON_SECRET`-gated Next.js cron route have been **retired**.
Recovery is now driven entirely by events on Redis Streams:

- **Producers** (`store.service`, `game-adapter.service`, `psp-webhook.service`) emit a
  reconcile event the instant an intent needs attention (`reconcile:events` stream). Emission
  is best-effort: the durable `engine_request_log` row is the source of truth, so a broker
  hiccup only delays recovery — it never loses a transaction.
- **Lost-webhook backstop** — opening a deposit schedules a *delayed* event in a Redis ZSET
  (`reconcile:scheduled`) instead of polling Postgres for stale `PENDING` rows. If the
  `succeeded` webhook arrives first the event is a harmless no-op.
- **Consumer** — `npm run worker:reconcile` (from `apps/financial-gateway`) runs a long-lived
  worker that BLOCKS on `XREADGROUP`, claims each journal row with `READ COMMITTED` + `SELECT …
  FOR UPDATE SKIP LOCKED`, re-drives it, and `XACK`s. A crashed consumer's in-flight messages
  are recovered via `XAUTOCLAIM`. The producer queue and this consumer are both owned by the
  gateway package.
- **Dead Letter Queue** — an intent that exhausts its attempt budget (or a poison message past
  its redelivery budget) is parked in `reconcile:dlq` for manual/admin review. **Zero
  transaction loss.**

## Endpoints (served by the Fastify gateway)

All bodies are JSON; the uniform envelope is `{ success, data }` / `{ success, error }`.

| Method + path | Auth | Purpose |
| --- | --- | --- |
| `GET /api/health` | — | Dependency-free liveness probe. |
| `POST /api/auth/register` · `POST /api/auth/login` | Redis rate-limit (fail-closed) | Create / authenticate an account; returns `{ user, accessToken }` and sets the HttpOnly refresh cookie. |
| `POST /api/auth/refresh` | refresh cookie | Rotate the single-use refresh token, mint a fresh access token. |
| `POST /api/auth/logout` | refresh cookie | Revoke the refresh session; clears the cookie (idempotent). |
| `POST /api/store/purchase` | Bearer access token | Open a PSP PaymentIntent (no capture) → journal a `PENDING` deposit → return `clientSecret`; the ledger is credited asynchronously by the verified PSP webhook. |
| `POST /api/webhooks/provider/spin` | provider HMAC | B2B game-aggregator settlement (bet/win). |
| `POST /api/webhooks/psp` | PSP HMAC | Drives the idempotent deposit credit on `payment_intent.succeeded`. |

Access tokens are short-lived HS256 JWTs (`Authorization: Bearer …`). Long-lived sessions are
carried by an opaque, single-use, Redis-backed refresh token delivered ONLY as an HttpOnly
cookie scoped to `/api/auth`.

## Layout

```
apps/financial-gateway/        # Zone 2 — the standalone, self-contained Fastify backend
├── src/
│   ├── app.ts, server.ts      # app assembly + process bootstrap
│   ├── routes/                # health · webhooks · auth · store
│   ├── services/              # auth · session · store · deposit · psp-webhook · game-adapter · reconciliation
│   ├── workers/reconciler.ts  # event-driven reconciliation consumer (npm run worker:reconcile)
│   ├── lib/                   # jwt · auth · rate-limit · reconcile-queue · circuit-breaker · …
│   └── schemas/, config/      # Zod boundaries + the store-package catalog
├── test/                      # gateway test suite (perimeter + crash/recovery + DLQ + psp)
└── prisma/                    # schema (identity + outbox only) · seed · sql

src/                           # Zone 3 — Next.js UI (no API routes, no backend modules)
└── app/                       # UI pages only (src/app/api and all backend src/ removed)
```

## Getting started

The Fastify gateway is its own workspace:

```bash
# Zone 2 — the Fastify gateway (serves every HTTP API)
cd apps/financial-gateway
cp ../../.env.example .env      # fill in secrets (DATABASE_URL, REDIS_URL, JWT_SECRET, ENGINE_*)
npm install
npm run prisma:generate
npm run dev                     # boots the gateway on $PORT (default 8080)

# The event-driven reconciler worker (requires REDIS_URL) — same gateway workspace:
npm run worker:reconcile        # long-lived consumer; blocks on the Redis Stream
npm run db:seed                 # (optional) seed the store-package catalog
```

Required env (gateway fails closed without them): `DATABASE_URL`, `JWT_SECRET`,
`ENGINE_BASE_URL`, `ENGINE_SECRET_KEY` (`ENGINE_SECRET` accepted as an alias),
`ENGINE_OPERATOR_CODE`, and `REDIS_URL` for the fail-closed limiter / sessions / reconciler.
See `.env.example`.

## Error envelope

```json
{ "success": false, "error": { "code": "LEDGER_REJECTED", "message": "…", "details": {} } }
```

Engine codes pass through (`INSUFFICIENT_FUNDS`, `UNAUTHORIZED_SIGNATURE`, …). Redis-outage
paths fail closed with `RATE_LIMITER_UNAVAILABLE` / `SESSION_STORE_UNAVAILABLE` (HTTP 503).
