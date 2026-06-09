# financial-gateway

A standalone **Fastify** microservice carved out of the Next.js Cashier. It is the security
perimeter and B2B adapter in front of the Go **"True Engine"** ledger — and it holds **zero
financial state**. It authenticates, validates, signs, and forwards money intents; it never
computes, stores, or mutates a balance. The engine remains the single source of truth for
money. There is deliberately **no local ledger here** — a second source of truth for the same
money is exactly the failure mode this architecture exists to prevent.

> **Status: Phase 2 — connection pooling & DB isolation.** On top of the Phase 1 process
> scaffold (server bootstrap, Helmet + CORS perimeter, PCI-redacted Pino logging, strict
> Zod-validated env, dependency-free liveness), this adds the database layer: a strict
> long-running Prisma singleton with PgBouncer transaction-pooling config, and the
> intent-journal / idempotency-outbox isolation patterns (unique-key idempotent create,
> SERIALIZABLE + `FOR UPDATE` status transitions, `FOR UPDATE SKIP LOCKED` outbox claim).
> Route/webhook migration, the fail-closed Redis limiter, and the event-driven reconciler
> arrive in later phases.

## Design invariants (carried over from the gateway architecture)

- **Zero financial state.** No balances, no money math. Ever.
- **Fail closed.** Security/financial dependencies (Redis-backed rate limiting, replay nonces)
  must reject with `503` when unavailable — never degrade to in-process `Map` state. (Lands
  with the route migration.)
- **No DB polling.** Reconciliation is event-driven (Redis Stream / queue consumer), not a
  `setInterval` + `findMany` loop. (Lands with the reconciler migration.)
- **No test seams in prod.** No exported `__reset*` helpers in the shipped service.
- **Strict Zod at every boundary.** Starting with the environment (`src/config/env.ts`).

## Layout

```
prisma/
├── schema.prisma      # gateway datastore (identity / journal / catalog — NO balances)
└── MIGRATIONS.md      # PgBouncer pooling, directUrl, apply notes
src/
├── server.ts          # process entrypoint: bootstrap + graceful shutdown (+ Prisma disconnect)
├── app.ts             # buildApp(): Fastify instance + perimeter + routes (injectable in tests)
├── config/env.ts      # strict, fail-closed Zod env contract
├── lib/
│   ├── logger.ts      # Pino options + PCI-DSS/PII redaction paths
│   ├── prisma.ts      # strict long-running singleton + PgBouncer/directUrl config
│   └── db/transaction.ts        # runSerializable/runInTransaction + serialization-retry
├── repositories/
│   └── engine-journal.repository.ts  # idempotent create + FOR UPDATE (SKIP LOCKED) outbox
└── routes/health.ts   # GET /api/health — liveness, touches NOTHING external
test/
├── setup.ts           # fail-closed env defaults for tests
├── health.test.ts     # inject()-based smoke tests (no socket / DB / Redis)
└── transaction.test.ts # serialization-retry + error-classifier unit tests
```

## Run

```bash
cd apps/financial-gateway
cp .env.example .env
npm install
npm run dev          # tsx watch (hot reload)
# or
npm run build && npm start
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
