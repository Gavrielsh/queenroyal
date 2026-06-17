# financial-gateway

A standalone **Fastify** microservice carved out of the Next.js Cashier. It is the security
perimeter and B2B adapter in front of the Go **"True Engine"** ledger — and it holds **zero
financial state**. It authenticates, validates, signs, and forwards money intents; it never
computes, stores, or mutates a balance. The engine remains the single source of truth for
money. There is deliberately **no local ledger here** — a second source of truth for the same
money is exactly the failure mode this architecture exists to prevent.

> **Status: complete — the self-contained financial backend.** The gateway now owns the entire
> backend surface extracted from Next.js: the Helmet + CORS perimeter with PCI-redacted Pino
> logging and Zod-validated env; the long-running Prisma singleton with PgBouncer pooling and
> the intent-journal / idempotency-outbox isolation patterns (unique-key idempotent create,
> SERIALIZABLE + `FOR UPDATE` status transitions, `FOR UPDATE SKIP LOCKED` outbox claim); the
> fail-closed Redis rate limiter / sessions / replay nonces; the auth, cashier, and B2B + PSP
> webhook routes; and the **event-driven reconciler** (producer queue + long-lived consumer
> worker, `npm run worker:reconcile`) with its Dead Letter Queue.

## Design invariants (carried over from the gateway architecture)

- **Zero financial state.** No balances, no money math. Ever.
- **Fail closed.** Security/financial dependencies (Redis-backed rate limiting, replay nonces,
  refresh sessions) reject with `503` when unavailable — never degrade to in-process `Map` state.
- **No DB polling.** Reconciliation is event-driven (Redis Stream / queue consumer), not a
  `setInterval` + `findMany` loop. The producer queue and the consumer worker
  (`src/workers/reconciler.ts`) both live here.
- **No test seams in prod.** No exported `__reset*` helpers in the shipped service.
- **Strict Zod at every boundary.** Starting with the environment (`src/config/env.ts`).

## Layout

```
prisma/
├── schema.prisma      # gateway datastore (identity / journal / catalog — NO balances)
├── seed.ts            # store-package catalog seed (npm run db:seed)
├── sql/               # hand-authored migrations (outbox identity columns/indexes)
└── MIGRATIONS.md      # PgBouncer pooling, directUrl, apply notes
src/
├── server.ts          # process entrypoint: bootstrap + graceful shutdown (+ Prisma disconnect)
├── app.ts             # buildApp(): Fastify instance + perimeter + routes (injectable in tests)
├── config/env.ts      # strict, fail-closed Zod env contract
├── routes/            # health · webhooks (provider/spin, provider/rollback, psp) · auth · store
├── services/          # auth · session · store · deposit · psp-webhook · game-adapter · reconciliation
├── workers/
│   └── reconciler.ts  # event-driven reconciliation consumer (npm run worker:reconcile)
├── lib/               # logger · prisma · jwt · auth · rate-limit · reconcile-queue · db/transaction · …
├── repositories/
│   └── engine-journal.repository.ts  # idempotent create + FOR UPDATE (SKIP LOCKED) outbox
└── schemas/, config/  # Zod boundaries + the store-package catalog
test/
├── setup.ts                 # fail-closed env defaults for tests
├── fakes/                   # in-memory prisma / engine / reconcile-queue doubles
├── health.test.ts           # inject()-based smoke tests (no socket / DB / Redis)
├── transaction.test.ts      # serialization-retry + error-classifier unit tests
├── webhook-security.test.ts # HMAC/replay perimeter
├── webhooks.route.test.ts   # provider/spin + provider/rollback + psp route perimeter
├── auth-store.route.test.ts # auth/store fail-closed perimeter (503/401/422)
├── psp-webhook.test.ts      # async PSP settlement (idempotent credit, signature, failure)
├── provider-rollback.test.ts # aggregator rollback adapter (reverse/idempotent-void/defer/compensate)
└── recovery.test.ts         # crash/recovery saga: ghost spin, compensation, DLQ, reclaim
```

## Run

```bash
cd apps/financial-gateway
cp .env.example .env
npm install
npm run dev               # tsx watch (hot reload)
# or
npm run build && npm start

npm run worker:reconcile  # long-lived event-driven reconciliation consumer (requires REDIS_URL)
npm run db:seed           # (optional) seed the store-package catalog
```

```bash
curl -s localhost:8080/api/health
# {"status":"ok","service":"financial-gateway","uptime_s":3,"timestamp":"..."}
```

## Test / typecheck

```bash
npm run typecheck
npm test
```
