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

  // ────────────────────────────────────────────────────────────────────────────
  // GATE C — the celebration module is quarantined.
  //
  // A celebratory sound or animation is a claim about the player's money: this
  // round left you better off. On classic-3reel that claim is false for 10.99% of
  // paying spins, because a leading CHERRY or LEMON pair pays x1 — the stake back
  // and nothing more. The engine decides who may be congratulated and ships a
  // `feedbackClass`; what this rule prevents is a component deciding for itself,
  // which is one `winAmount !== "0.0000"` away in any file that can import a sound.
  //
  // So there is exactly one door — SpinFeedback — and this is the lock. The
  // allowance below is granted to that file ALONE, by path.
  //
  // If you are here because this rule is blocking you: the answer is almost never
  // to widen the allowlist. Render <SpinFeedback feedbackClass={...} /> instead,
  // and if you need a celebration it does not yet do, add it inside that component
  // where the engine's verdict is already in scope.
  // ────────────────────────────────────────────────────────────────────────────
  {
    files: ["src/**/*.{ts,tsx}"],
    // TWO exact paths, never a glob.
    //
    // SpinFeedback.tsx is the single door. Its own test is the second exception
    // because it has to import the module to assert the celebration did NOT
    // fire — an absence is not observable from the DOM alone, and a gate that
    // cannot see what it guards is decorative.
    //
    // These are listed by full path rather than as `**/*.test.tsx` on purpose. A
    // glob over tests would let any future test trigger real celebrations, and
    // "it was only in a test" is how a helper ends up imported into a component.
    ignores: [
      "src/components/feedback/SpinFeedback.tsx",
      "src/components/feedback/SpinFeedback.test.tsx",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "**/feedback/celebration",
                "**/feedback/celebration.ts",
                "@/components/feedback/celebration",
                "./celebration",
                "../feedback/celebration",
              ],
              message:
                "The celebration module may only be imported by src/components/feedback/SpinFeedback.tsx (Gate C: no celebratory feedback on a net-negative or net-zero round). Render <SpinFeedback feedbackClass={...} /> instead of triggering a celebration directly.",
            },
          ],
        },
      ],
    },
  },

  // NOTE: no `any` carve-out for test files. There was going to be one — the 16 findings
  // this config first reported were all in apps/financial-gateway/test/fakes/prisma.fake.ts,
  // and downgrading them to warnings in test code is the usual compromise. They were typed
  // properly instead (QueryArgs / RawQuery / AnyRow), the gateway's 146 tests still pass
  // unchanged, and so `no-explicit-any` stays an ERROR everywhere. A warning nobody has to
  // clear is a finding that accumulates.
);
