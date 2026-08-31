#!/usr/bin/env node
/**
 * Post-build assertion: the production artifact must contain no dev-only affordance.
 *
 * tsconfig.build.json excludes `src/dev`, but an exclusion is a configuration line — it can be
 * dropped in a merge, or bypassed by someone building with the wrong project file. This script
 * checks the OUTPUT rather than the intent, so the guarantee is verified where it matters: in
 * the bytes that ship.
 *
 * It fails the build if dist/ contains the dev directory, the mock-login route path, or any
 * write of kycStatus: "VERIFIED" — the state that unlocks purchases and redemptions, and which
 * no production code path is allowed to grant.
 */
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const DIST = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");

if (!existsSync(DIST)) {
  console.error("✖ dist/ does not exist — run the build first.");
  process.exit(1);
}

/** Every emitted .js file, recursively. */
function jsFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...jsFiles(full));
    else if (entry.endsWith(".js")) out.push(full);
  }
  return out;
}

const failures = [];

// 1. The dev directory must not have been emitted at all.
if (existsSync(join(DIST, "dev"))) {
  failures.push("dist/dev/ exists — src/dev was compiled into the production build");
}

// 2. No emitted file may REGISTER the route or GRANT verified status.
//
//    These match behaviour, not mentions. routes/auth.js legitimately names the dev module
//    and its registrar — that is the guarded dynamic import whose whole purpose is to FAIL
//    in this build — and its warning string names the path. Banning the bare substring would
//    flag the loader that enforces the rule, so the patterns below target the two things that
//    would actually be dangerous: a live route registration, and a write of VERIFIED.
//
//    tsconfig.build.json sets removeComments, so what is scanned here is code.
const BANNED = [
  {
    pattern: /\.(post|route)\s*\(\s*["'`]\/api\/auth\/mock-login/,
    why: "a REGISTRATION of the dev-only mock-login route",
  },
  {
    pattern: /kycStatus\s*:\s*["'`]VERIFIED["'`]/,
    why: 'a write of kycStatus: "VERIFIED" — the state that unlocks purchases and redemptions',
  },
];

for (const file of jsFiles(DIST)) {
  const text = readFileSync(file, "utf8");
  for (const { pattern, why } of BANNED) {
    if (pattern.test(text)) {
      failures.push(`${relative(DIST, file)} contains ${why}`);
    }
  }
}

if (failures.length > 0) {
  console.error("\n  ✖ PRODUCTION BUILD CONTAINS DEV-ONLY CODE\n");
  for (const f of failures) console.error(`    • ${f}`);
  console.error(
    [
      "",
      "  POST /api/auth/mock-login mints a KYC-VERIFIED session with no credentials, and is",
      "  the only code path that grants VERIFIED. It must not exist in a production artifact.",
      "",
      "  Build with tsconfig.build.json (which excludes src/dev), and keep dev-only code in",
      "  src/dev/ rather than behind a runtime conditional.",
      "",
    ].join("\n"),
  );
  process.exit(1);
}

console.log("✓ production build contains no dev-only routes and no VERIFIED grant");
