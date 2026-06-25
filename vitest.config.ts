import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

/**
 * Zone 3 (Next.js UI) test harness.
 *
 * Deliberately scoped to `src/` so it can NEVER pull in the standalone Fastify gateway
 * (`apps/`), which is a separate workspace with its own toolchain — this mirrors the boundary
 * tsconfig already enforces via `exclude: ["apps"]`.
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    // Mirror tsconfig's `@/* -> ./src/*` alias so imports resolve identically under test.
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./vitest.setup.ts"],
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    // Never traverse the gateway workspace, the build output, or dependencies.
    exclude: ["node_modules/**", "apps/**", ".next/**", "dist/**"],
    // vitest fails the run on unhandled rejections by default; this is the documented
    // guarantee (M1-T1 protocol step 2) that silent async errors surface as test failures.
    clearMocks: true,
    restoreMocks: true,
  },
});
