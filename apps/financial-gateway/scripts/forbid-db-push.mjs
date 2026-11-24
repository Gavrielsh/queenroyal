#!/usr/bin/env node
/**
 * Refuses `prisma db push` outside a developer's own machine (Milestone 0.4).
 *
 * WHY: `db push` reconciles the database to schema.prisma with no migration
 * file, no history, and no record in _prisma_migrations. Two environments that
 * ran it at different times are silently different, nothing states what changed
 * or when, and there is no artifact to review or roll back. For a regulated
 * platform that is not a deployment mechanism — it is undocumented drift.
 *
 * Worse, `db push` resolves drift by DROPPING whatever the schema does not
 * describe. Against a shared database it can destroy columns and tables another
 * app owns, and it will happily discard data to make the schema match.
 *
 * The supported path is `prisma migrate deploy`, which applies reviewed,
 * committed migrations and records them.
 *
 * There is deliberately NO override flag. An escape hatch on a guard like this
 * is used exactly once, under deadline pressure, at which point the guard has
 * bought nothing. If a schema change is genuinely needed, it needs a migration.
 */

// Detected CI providers set one of these unconditionally.
const CI_VARS = [
  "CI",
  "GITHUB_ACTIONS",
  "GITLAB_CI",
  "BUILDKITE",
  "CIRCLECI",
  "JENKINS_URL",
  "TEAMCITY_VERSION",
  "TF_BUILD", // Azure Pipelines
];

// Deployed-environment markers.
const PROD_VARS = [
  ["NODE_ENV", "production"],
  ["APP_ENV", "production"],
  ["VERCEL_ENV", "production"],
  ["RAILWAY_ENVIRONMENT", "production"],
];

const reasons = [];

for (const name of CI_VARS) {
  const raw = process.env[name];
  // Providers set CI to "true"/"1"; an explicit "false"/"0" is not CI.
  if (raw !== undefined && raw !== "" && !["false", "0"].includes(raw.toLowerCase())) {
    reasons.push(`${name}=${raw} (continuous integration)`);
  }
}

for (const [name, value] of PROD_VARS) {
  const raw = process.env[name];
  if (raw !== undefined && raw.trim().toLowerCase() === value) {
    reasons.push(`${name}=${raw} (deployed environment)`);
  }
}

if (reasons.length > 0) {
  console.error(
    [
      "",
      "  ✖ REFUSING TO RUN `prisma db push`",
      "",
      "  Blocked because:",
      ...reasons.map((r) => `    • ${r}`),
      "",
      "  `db push` writes no migration file and leaves no history, so environments",
      "  drift apart silently and no artifact records what changed. It also DROPS",
      "  anything the schema does not describe, which can destroy data and columns",
      "  another application owns in a shared database.",
      "",
      "  Use the migration path instead:",
      "",
      "    npm run db:migrate:deploy      # apply committed migrations",
      "    npm run db:migrate:status      # check what is pending",
      "",
      "  To change the schema, generate a migration on your own machine and commit it:",
      "",
      "    npm run db:migrate -- --name <describe_the_change>",
      "",
      "  See apps/financial-gateway/prisma/MIGRATIONS.md.",
      "",
    ].join("\n"),
  );
  process.exit(1);
}
