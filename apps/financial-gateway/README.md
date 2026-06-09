# financial-gateway

A standalone **Fastify** microservice carved out of the Next.js Cashier. It is the security
perimeter and B2B adapter in front of the Go **"True Engine"** ledger — and it holds **zero
financial state**. It authenticates, validates, signs, and forwards money intents; it never
computes, stores, or mutates a balance. The engine remains the single source of truth for
money. There is deliberately **no local ledger here** — a second source of truth for the same
money is exactly the failure mode this architecture exists to prevent.

> **Status: Phase 1 — the Fastify amputation.** This commit scaffolds the standalone process:
> server bootstrap, security perimeter (Helmet + CORS), PCI-redacted Pino logging, strict
> Zod-validated env, and a dependency-free liveness probe. Route/webhook migration, the
> fail-closed Redis limiter, and the event-driven reconciler arrive in later phases.

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
src/
├── server.ts          # process entrypoint: bootstrap + graceful shutdown
├── app.ts             # buildApp(): Fastify instance + perimeter + routes (injectable in tests)
├── config/env.ts      # strict, fail-closed Zod env contract
├── lib/logger.ts      # Pino options + PCI-DSS/PII redaction paths
└── routes/health.ts   # GET /api/health — liveness, touches NOTHING external
test/
└── health.test.ts     # inject()-based smoke tests (no socket / DB / Redis)
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
