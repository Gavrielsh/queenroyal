import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

/**
 * Zone 2 + Zone 3 lint configuration (M1.1-T8).
 *
 * Flat config, ESLint 9. One configuration at the repository root covers BOTH the Next.js
 * app (`src/`) and the Fastify gateway (`apps/financial-gateway/`) so a rule cannot be
 * enforced in one zone and silently absent in the other — the two are reviewed together and
 * should be linted together.
 *
 * NOT YET INCLUDED: eslint-config-next. Version 15 still loads through
 * @rushstack/eslint-patch, which refuses to patch ESLint 9 ("Failed to patch ESLint because
 * the calling module was not recognized"). Adding it would mean either pinning ESLint back
 * to 8 or routing it through FlatCompat, and neither is worth doing blind inside a CI task.
 * The Next-specific rules (next/core-web-vitals and friends) are therefore ABSENT today —
 * recorded here rather than in a commit message so the gap is visible at the config itself.
 */
export default tseslint.config(
  {
    // Build output, dependencies, and generated artifacts are never linted.
    ignores: [
      "**/node_modules/**",
      "**/.next/**",
      "**/dist/**",
      "**/coverage/**",
      "**/e2e/screenshots/**",
      "**/e2e/test-results/**",
      "**/*.tsbuildinfo",
      "next-env.d.ts",
      "apps/financial-gateway/prisma/generated/**",
      // Vendored skills library — 1365 third-party files that are not Zone 2 or Zone 3
      // application code. Linting them would bury 20 real findings under 369 imported ones.
      ".agents/**",
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    // `no-undef` is a JS-era rule: TypeScript's own compiler resolves identifiers, and the
    // ESLint rule cannot see TS types, so on a typed codebase it reports only false
    // positives (310 of them here). typescript-eslint's documentation says to turn it off.
    // Undefined identifiers still fail — in the typecheck job, which is the tool that
    // actually knows.
    files: ["**/*.{ts,tsx,mts,cts}"],
    rules: { "no-undef": "off" },
  },

  // Zone 3 — the Next.js app. Browser globals.
  {
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
  },

  // Zone 2 — the Fastify gateway, plus every Node-side script and config. Node globals.
  {
    files: [
      "apps/financial-gateway/**/*.ts",
      "apps/financial-gateway/**/*.mjs",
      "e2e/**/*.ts",
      "*.config.{ts,mjs}",
      "*.setup.ts",
    ],
    languageOptions: {
      globals: { ...globals.node },
    },
  },

  {
    // The codebase already marks deliberately-unused signature parameters with a leading
    // underscore (markSpinRetained(_gameId), pull(count, _blockMs), $transaction(fn, _opts)).
    // Those parameters exist to satisfy an interface and deleting them would change the
    // signature, so honour the convention rather than fight it. Anything NOT prefixed is
    // still an error — which is how the one real finding here, a dead `getEnv` import in
    // auth.service.ts, was caught.
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", {
        argsIgnorePattern: "^_",
        varsIgnorePattern: "^_",
        caughtErrorsIgnorePattern: "^_",
      }],
    },
  },

  // NOTE: no `any` carve-out for test files. There was going to be one — the 16 findings
  // this config first reported were all in apps/financial-gateway/test/fakes/prisma.fake.ts,
  // and downgrading them to warnings in test code is the usual compromise. They were typed
  // properly instead (QueryArgs / RawQuery / AnyRow), the gateway's 146 tests still pass
  // unchanged, and so `no-explicit-any` stays an ERROR everywhere. A warning nobody has to
  // clear is a finding that accumulates.
);
