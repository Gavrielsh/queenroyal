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

## Migration history

This app has a committed migration history under `prisma/migrations/`. The baseline
(`..._init`) describes the full schema — `users`, `engine_request_log`, `store_packages` and
the three enums — and is verified to reproduce `schema.prisma` exactly.

The table DDL matches the hand-written `prisma/sql/gateway_outbox_identity.sql` column for
column and index for index; that file is retained only as a historical record of the
incremental change and is **not** the way to apply the schema.

## `db push` is forbidden outside your own machine

`prisma db push` writes no migration file, records nothing in `_prisma_migrations`, and
resolves drift by DROPPING whatever the schema does not describe. Two environments that ran
it at different times are silently different, with no artifact stating what changed or when —
and against a database shared with the legacy app it can destroy columns that app owns.

`npm run db:push` is therefore wrapped by `scripts/forbid-db-push.mjs`, which exits non-zero
when it detects CI (`CI`, `GITHUB_ACTIONS`, `GITLAB_CI`, …) or a deployed environment
(`NODE_ENV=production`, `VERCEL_ENV=production`, …). There is deliberately no override flag.

The guard cannot intercept a bare `npx prisma db push`. Do not write one into a Dockerfile,
compose file, or deploy script — the staging init container used to, and now runs
`prisma migrate deploy`.

## Apply the schema

```bash
# Point DIRECT_DATABASE_URL at Postgres directly (NOT PgBouncer — a transaction pooler
# cannot run DDL or advisory locks), then:

npm run db:migrate:deploy     # apply committed migrations (CI, staging, production)
npm run db:migrate:status     # what is applied, what is pending
```

## Change the schema

```bash
# On your own machine only. Generates a migration file, applies it, and updates the client.
npm run db:migrate -- --name describe_the_change
```

Commit the generated `prisma/migrations/<timestamp>_<name>/migration.sql` with the schema
change in the SAME commit — a schema edit without its migration is the drift this history
exists to prevent.

`npm run db:migrate:diff` exits non-zero when `schema.prisma` and the committed migrations
disagree, which makes it usable as a CI gate.

## Baselining a database that already has these tables

An existing database (staging, or any environment provisioned before this history existed)
already contains the tables, so `migrate deploy` would try to create them and fail. Mark the
baseline as already applied ONCE per such database, against the DIRECT connection:

```bash
npx prisma migrate resolve --applied <the _init migration directory name>
npm run db:migrate:status     # confirm: no pending migrations
```

Run this only where the schema genuinely matches the baseline. If it does not, reconcile the
difference with a new migration rather than forcing the baseline over it.
