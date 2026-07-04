import { existsSync } from "node:fs";

import { defineConfig } from "@playwright/test";

/**
 * Visual verification harness (M3) — deterministic by construction:
 *   - The gateway is fully stubbed at the network layer (e2e/fixtures/gateway-stubs.ts). No
 *     real gateway, Go engine, Redis, or external network is EVER contacted: every non-app
 *     origin is aborted, and any unrouted gateway call fails the test loudly.
 *   - Animations are frozen via `reducedMotion: "reduce"` so captures are stable.
 *   - Screenshots land in e2e/screenshots/<project>/<NN-state>.png — a gitignored review
 *     artifact regenerated on demand with `npm run test:visual`.
 *
 * Browser resolution: in the hosted container the pre-installed Chromium build differs from
 * the one this @playwright/test version downloads, so we pin the provided symlink when it
 * exists; on a normal dev machine (after `npx playwright install chromium`) the default
 * resolution is used.
 */
const CONTAINER_CHROMIUM = "/opt/pw-browsers/chromium";
const executablePath = existsSync(CONTAINER_CHROMIUM) ? CONTAINER_CHROMIUM : undefined;

export default defineConfig({
  testDir: "./e2e",
  outputDir: "./e2e/test-results",
  // One shared dev server; sequential execution keeps captures + stub state deterministic.
  fullyParallel: false,
  workers: 1,
  // One retry absorbs transient dev-server pauses (e.g. a recompile racing a 4s toast).
  // Retried tests are reported as "flaky" in the summary — visible, never silent.
  retries: 1,
  timeout: 60_000,
  // Error-state waits must outlast the app's React Query retry backoff (3 tries ≈ 7s).
  expect: { timeout: 20_000 },
  use: {
    baseURL: "http://localhost:3000",
    // Freeze CSS animations/transitions for stable captures (context-level emulation).
    contextOptions: { reducedMotion: "reduce" },
    ...(executablePath ? { launchOptions: { executablePath } } : {}),
  },
  projects: [
    { name: "desktop", use: { viewport: { width: 1280, height: 800 } } },
    { name: "mobile", use: { viewport: { width: 390, height: 844 } } },
  ],
  webServer: {
    command: "npm run dev",
    url: "http://localhost:3000",
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
