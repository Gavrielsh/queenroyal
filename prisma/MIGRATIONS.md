# Database migration — gateway outbox & identity bridge

This change adds, to the **gateway** database (identity/routing only — never balances):

- `User.trueEnginePlayerId` — the True Engine `player_id` mapping.
- `engine_request_log` — the append-only intent journal / outbox (with `requestPayload`,
  `retryable`, `attempts`, `lastError`, and the `PENDING/SUCCEEDED/FAILED/COMPENSATED/ABANDONED` states).
- Enums `EngineRequestType`, `EngineRequestStatus`.

The exact SQL is in [`prisma/sql/gateway_outbox_identity.sql`](./sql/gateway_outbox_identity.sql).

> Run every command from the `queenroyal/` directory. Ensure `DATABASE_URL` is set.

---

## Option A — Quick sync (this repo's current setup: no migration history)

`prisma db push` reconciles the database to `schema.prisma` (adds the column, table, and
enums) and regenerates the client. Best for dev and for environments previously created
with `db push`.

```bash
# from queenroyal/
npx prisma db push          # apply schema changes to the DB
npx prisma generate         # regenerate the typed client (db push usually runs this)
npm run db:seed             # optional: upsert the store-package catalog
```

## Option B — Adopt migration history (recommended for production)

Create a versioned migration from the current schema, then deploy it in prod.

```bash
# DEV (a dev/shadow database must be reachable): creates prisma/migrations/<ts>_init_gateway
# and applies it. With an empty history this first migration captures the full schema,
# including engine_request_log and User.trueEnginePlayerId.
npx prisma migrate dev --name init_gateway

# PRODUCTION / CI: apply committed migrations only (no schema drift, no prompts).
npx prisma migrate deploy
npx prisma generate
```

If the production database already contains `users` / `store_packages` (created earlier
via `db push`) and you are adopting migrations now, baseline the existing objects first so
`migrate deploy` does not try to recreate them:

```bash
# 1) Generate the baseline migration for what's ALREADY in the DB:
mkdir -p prisma/migrations/0000_baseline
npx prisma migrate diff \
  --from-empty \
  --to-schema-datamodel prisma/schema.prisma \
  --script > prisma/migrations/0000_baseline/migration.sql
# 2) Mark it as already applied (does not run it):
npx prisma migrate resolve --applied 0000_baseline
# 3) From here on, `prisma migrate dev` / `migrate deploy` manage changes normally.
```

## Option C — Manual / out-of-band

Apply the reviewed SQL directly, then sync Prisma's client:

```bash
psql "$DATABASE_URL" -f prisma/sql/gateway_outbox_identity.sql
npx prisma generate
```

---

## After migrating — runtime prerequisites

- `ENGINE_OPERATOR_CODE`, `ENGINE_SECRET_KEY`, `ENGINE_BASE_URL` — outbound to the engine.
- `PROVIDER_WEBHOOK_SECRETS` — inbound B2B webhook HMAC secrets.
- `REDIS_URL` — required for multi-instance replay protection.
- `CRON_SECRET` — enables `POST/GET /api/internal/cron/reconcile`.
- Reconciliation: either run the worker (`npm run worker:reconcile`) or schedule the cron
  endpoint (e.g. Vercel Cron hitting `/api/internal/cron/reconcile` with
  `Authorization: Bearer $CRON_SECRET`).
