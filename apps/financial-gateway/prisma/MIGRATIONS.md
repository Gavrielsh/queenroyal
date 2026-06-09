# financial-gateway — database

Postgres via Prisma. This schema describes the **same physical tables** as the legacy Next.js
app during the migration (identical table/column names) and introduces **no structural
change**, so both Prisma clients can read the shared database until the legacy DB layer is
retired. Do **not** run conflicting migrations from both apps.

> Holds identity, compliance, the store catalog, and the append-only intent journal —
> **never** balances. The Go True Engine owns all money.

## Connections (PgBouncer transaction pooling)

- `DATABASE_URL` — runtime / pooled. Behind PgBouncer (transaction mode) it MUST include
  `?pgbouncer=true` (Prisma then avoids server-side prepared statements). Keep Prisma's own
  per-instance pool small with `connection_limit` and let PgBouncer pool, e.g.
  `postgresql://user:pass@pgbouncer:6432/db?pgbouncer=true&connection_limit=1`.
- `DIRECT_DATABASE_URL` — direct, session-mode connection used ONLY by the commands below (a
  transaction pooler cannot run migrations / introspection). Never read at runtime.

## Generate the client

```bash
cd apps/financial-gateway
npm run prisma:generate
```

## Apply schema (only where this app owns the schema)

```bash
# Point DIRECT_DATABASE_URL at Postgres directly (NOT PgBouncer), then:
npx prisma db push          # quick sync (this repo's no-history setup)
# or, with migration history:
npx prisma migrate deploy
```

The table DDL is unchanged from the repo-root `prisma/sql/gateway_outbox_identity.sql`
(`users`, `engine_request_log`, the `EngineRequestType` / `EngineRequestStatus` enums). No new
columns or enum values are introduced here — the row-level locking in
`src/repositories/engine-journal.repository.ts` works against the existing structure.
