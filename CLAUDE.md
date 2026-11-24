# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Read first

- **What to build next:** `docs/PLAN.md`. The `True` repo has an identical copy, so make any
  change in both repos in the same session. `ROADMAP.md` is out of date.
- **Rules:** `.claude-instructions` (G1–G4). Read it before any change to money, wallet or
  engine calls. G1–G4 at the top are current. Some later sections were written before the
  gateway was split out and still name Next.js route handlers, `src/services/*` and
  `src/lib/true-engine.ts`. Those now live under `apps/financial-gateway/src/`.
- **Workflow:** feature branch, one PR per plan item, tick the item in `docs/PLAN.md`.

## Architecture (three zones, two repos)

| Zone | Where | Stack | Role |
|---|---|---|---|
| 1 — Engine | separate `True` repo (Go) | Gin, Postgres, Redis | The ledger; sole authority for money |
| 2 — Gateway | `apps/financial-gateway/` | Fastify 5, Prisma, Postgres, Redis | Every backend API: auth, cashier, webhooks, workers |
| 3 — Web | `src/` | Next.js 15, React 19, TanStack Query | UI only, with no API routes (`src/app/api` was deleted) |

- The root and the gateway are **separate npm packages with separate lockfiles**, not a
  workspace. Run `npm install` / `npm ci` in each. Root `tsconfig` and `vitest.config.ts`
  exclude `apps/`.
- Gateway → engine calls are HMAC-signed (`X-Operator-Code`, `X-Signature` over the exact body
  bytes, `X-Timestamp`, a fresh `X-Nonce` per attempt). They go only through
  `apps/financial-gateway/src/lib/true-engine.ts`, which returns a typed `TrueEngineResult`
  rather than throwing. Inbound provider/PSP webhooks are HMAC-verified in a `preHandler`
  before the body is parsed (`lib/webhook-security.ts`).
- Gateway layering: `routes/` (parse, auth, validate, respond) → `services/` (logic) →
  `lib/true-engine.ts` / `repositories/`. Zod boundaries are in `schemas/`, and money strings
  are validated by `lib/money.ts` (`MONEY_REGEX`).
- Prisma holds identity, KYC, the store catalog, the `trueEnginePlayerId` mapping and the
  append-only intent journal (`EngineRequestLog`). It never holds balances.
- Recovery is event-driven on Redis Streams, with no DB polling or cron. Producers emit to
  `reconcile:events`. Lost-webhook backstops go in a delayed ZSET (`reconcile:scheduled`).
  `workers/reconciler.ts` consumes via `XREADGROUP` and claims journal rows with
  `FOR UPDATE SKIP LOCKED`. Exhausted intents go to `reconcile:dlq`. `workers/redemption.ts`
  runs the redemption queue the same way.
- Redis-backed security (rate limit, refresh sessions, replay nonces, circuit breaker) **fails
  closed with 503** and has no in-memory fallback.
- Web: the wallet balance lives in exactly one React Query entry (`walletKeys.balances()`), and
  only `src/lib/walletQueryFn.ts` writes to it. Mutations and realtime events only invalidate
  it. `src/lib/apiClient.ts` is the gateway client (`MONEY_STRING_REGEX`). Mutation hooks in
  `src/hooks/` keep one idempotency key per attempt across retries (G3).
- `apps/financial-gateway/src/dev/` (mock login) is dev-only. `tsconfig.build.json` excludes
  it, and `scripts/verify-no-dev-routes.mjs` checks that `dist/` contains no dev route and no
  write of `kycStatus: "VERIFIED"`.

## Commands

Root (web, Zone 3):
```bash
npm run dev                 # Next dev server on :3000
npm run typecheck           # tsc --noEmit
npm test                    # vitest (jsdom), src/**/*.test.{ts,tsx}
npx vitest run src/lib/walletReconcile.test.ts      # single file
npx vitest run -t "name substring"                  # single test by name
npx eslint . --max-warnings=0   # lints BOTH zones; there is no `npm run lint` script
npx playwright test         # E2E/visual (also `npm run test:visual`); starts `npm run dev` itself
npx playwright test e2e/spin.spec.ts --project=desktop
```
Playwright stubs the gateway at the network layer (`e2e/fixtures/gateway-stubs.ts`). Any
unrouted call fails the test, so a new gateway endpoint the UI uses needs a stub.

Gateway (`cd apps/financial-gateway`):
```bash
npm run prisma:generate     # required before typecheck/tests
npm run dev                 # tsx watch, $PORT (default 8080)
npm run typecheck
npm test                    # vitest (node), test/**/*.test.ts
npx vitest run test/redeem.route.test.ts
npm run worker:reconcile    # long-lived reconciler consumer
npm run build && node scripts/verify-no-dev-routes.mjs
```
- `test/setup.ts` sets safe test env defaults, including `GEO_ENFORCEMENT_DISABLED`.
- The `*.integration.test.ts` suites need a real Redis. They use `REDIS_TEST_URL` (default
  `redis://127.0.0.1:6380`). Without it they skip silently, which fails CI's count assertion.
  With it set but unreachable, they throw.
- Schema changes need a committed migration in `prisma/migrations/`. CI checks for drift with
  `prisma migrate diff --exit-code`. Don't use `prisma db push`: `scripts/forbid-db-push.mjs`
  blocks it, even though `prisma/MIGRATIONS.md` still mentions it.

**Before commit:** typecheck + `npm test` in both packages, `npx eslint . --max-warnings=0` at
the root, and `npx playwright test` for user-facing changes.

## CI gotchas (`.github/workflows/app.yml`)

- CI asserts **exact** test counts: Zone 3 files/tests, gateway files/tests, and the E2E total
  (tests × 2 viewport projects). Adding or removing a test means updating the numbers in
  `app.yml` in the same commit. Skipped tests fail CI.
- ESLint runs with zero warnings allowed. `eslint-config-next` is intentionally not enabled
  (ESLint 9 incompatibility).
- `npm audit` fails only on critical advisories.

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- When graphify-out/graph.json exists, run `graphify query "<question>"` before your first grep, search or source-file read for a codebase question, and put this rule in every subagent prompt that explores code. Read raw files only for lines the graph or an earlier read already located. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. When the answer is under a Markdown heading, `graphify section "<heading>"` prints that section's text, so the .md need not be opened. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
- A committed graphify-out/graph.json is rewritten whole on every build, so a large diff to it in a pull request is expected. Do not flag it as churn or suggest skipping the graph rebuild or its hooks.
