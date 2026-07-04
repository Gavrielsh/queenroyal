import { expect, test, type Page, type TestInfo } from "@playwright/test";

import { installGateway, type InstalledGateway } from "./fixtures/gateway-stubs";

/**
 * Baseline screenshot matrix — every UI state the styling epic will touch, captured from a
 * fully stubbed gateway (see fixtures/gateway-stubs.ts). Output:
 *   e2e/screenshots/<project>/<NN-state>.png
 * Regenerate any time with `npm run test:visual`.
 *
 * Numbering is stable so before/after diffs line up across the M3 tasks.
 */

async function capture(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await page.screenshot({
    path: `e2e/screenshots/${testInfo.project.name}/${name}.png`,
    fullPage: true,
  });
}

function assertIsolated(gateway: InstalledGateway): void {
  expect(gateway.violations, "no request may escape the stubbed gateway").toEqual([]);
}

test("01 — landing page", async ({ page, context }, testInfo) => {
  const gateway = await installGateway(context, { wallet: "synced" });

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "QueenRoyal" })).toBeVisible();

  await capture(page, testInfo, "01-landing");
  assertIsolated(gateway);
});

test("02 — casino floor: first-load syncing (wallet read in flight)", async ({ page, context }, testInfo) => {
  const gateway = await installGateway(context, { wallet: "hanging" });

  await page.goto("/casino");
  await expect(page.getByText("syncing…")).toHaveCount(2);
  await expect(page.getByText("—").first()).toBeVisible(); // honest placeholders, never zeros

  await capture(page, testInfo, "02-casino-syncing");
  // The hanging wallet read is still pending by design — it is stubbed, not escaped.
  assertIsolated(gateway);
});

test("03 — casino floor: ledger-synced (both windows, one snapshot)", async ({ page, context }, testInfo) => {
  const gateway = await installGateway(context, { wallet: "synced" });

  await page.goto("/casino");
  await expect(page.getByText("ledger-synced")).toHaveCount(2);
  await expect(page.getByText("1,000")).toHaveCount(2); // "1000.0000" rendered verbatim-formatted

  await capture(page, testInfo, "03-casino-synced");
  assertIsolated(gateway);
});

test("04 — casino floor: unauthorized wallet read (log-in state)", async ({ page, context }, testInfo) => {
  const gateway = await installGateway(context, { wallet: "unauthorized" });

  await page.goto("/casino");
  // Waits out the app's React Query retry backoff before the error phase lands.
  await expect(page.getByText("log in to see your wallet")).toHaveCount(2);

  await capture(page, testInfo, "04-casino-unauthorized");
  assertIsolated(gateway);
});

test("05 — casino floor: ledger unavailable (stale, fail-closed)", async ({ page, context }, testInfo) => {
  const gateway = await installGateway(context, { wallet: "unavailable" });

  await page.goto("/casino");
  await expect(page.getByText("stale — last sync failed")).toHaveCount(2);

  await capture(page, testInfo, "05-casino-ledger-unavailable");
  assertIsolated(gateway);
});

test("06 — casino floor: dev auto-login failed (gateway down)", async ({ page, context }, testInfo) => {
  const gateway = await installGateway(context, { wallet: "unauthorized", login: "unavailable" });

  await page.goto("/casino");
  await expect(page.getByText(/Dev auto-login failed/)).toBeVisible();

  await capture(page, testInfo, "06-casino-login-failed");
  assertIsolated(gateway);
});

test("07 — store: purchase in flight (confirm held open)", async ({ page, context }, testInfo) => {
  const gateway = await installGateway(context, { wallet: "synced", purchase: "confirm-hanging" });

  await page.goto("/casino");
  await expect(page.getByText("ledger-synced")).toHaveCount(2);

  await page.getByRole("button", { name: "BUY $5", exact: true }).click();
  await expect(page.getByRole("button", { name: "BUYING…" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "BUY $20" })).toBeDisabled();

  await capture(page, testInfo, "07-purchase-inflight");
  assertIsolated(gateway);
});

test("08 — store: purchase settled, balances credited from the ledger", async ({ page, context }, testInfo) => {
  const gateway = await installGateway(context, { wallet: "credit-after-purchase", purchase: "settled" });

  await page.goto("/casino");
  await expect(page.getByText("ledger-synced")).toHaveCount(2);

  await page.getByRole("button", { name: "BUY $5", exact: true }).click();
  // Filtered because Next.js's route announcer also carries role="alert" in a real browser.
  await expect(page.getByRole("alert").filter({ hasText: "Starter pack purchased" })).toBeVisible();
  await expect(page.getByText("6,000")).toHaveCount(2); // the credited snapshot, both windows

  await capture(page, testInfo, "08-purchase-settled");
  assertIsolated(gateway);
});

test("09 — store: purchase declined by the gateway", async ({ page, context }, testInfo) => {
  const gateway = await installGateway(context, { wallet: "synced", purchase: "declined" });

  await page.goto("/casino");
  await expect(page.getByText("ledger-synced")).toHaveCount(2);

  await page.getByRole("button", { name: "BUY $5", exact: true }).click();
  // Filtered because Next.js's route announcer also carries role="alert" in a real browser.
  await expect(page.getByRole("alert").filter({ hasText: "Purchase failed: Card declined" })).toBeVisible();

  await capture(page, testInfo, "09-purchase-declined");
  assertIsolated(gateway);
});

test("10 — game: spin animation state", async ({ page, context }, testInfo) => {
  const gateway = await installGateway(context, { wallet: "synced" });

  await page.goto("/casino");
  await expect(page.getByText("ledger-synced")).toHaveCount(2);

  await page.getByRole("button", { name: /SPIN \(settles provider-side\)/ }).click();
  await expect(page.getByRole("button", { name: "SPINNING…" })).toBeDisabled();

  await capture(page, testInfo, "10-game-spinning");
  assertIsolated(gateway);
});
