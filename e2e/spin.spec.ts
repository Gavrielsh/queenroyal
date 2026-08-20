import { expect, test, type Page } from "@playwright/test";

import { installGateway } from "./fixtures/gateway-stubs";

/**
 * End-to-end coverage of the server-authoritative spin journey.
 *
 * Every gateway call is stubbed at the network layer and any unrouted origin is aborted and
 * recorded, so these tests exercise the REAL browser code path (React Query cache, the
 * validation gate, the idempotency token, the notice policy) against verified wire shapes
 * without a gateway, a Go engine, or a network.
 *
 * The property under test throughout: the player is never shown an outcome the ledger did not
 * produce, and a failed wager never leaves a fabricated result on the reels.
 */

/**
 * The window's ActionNotice.
 *
 * Next.js injects its own `role="alert"` route announcer into every page, so a bare
 * `getByRole("alert")` is ambiguous under Playwright's strict mode. Excluding it by id targets
 * the component's alert channel and nothing else.
 */
function notice(page: Page) {
  return page.locator('[role="alert"]:not([id="__next-route-announcer__"])');
}

/** Symbols currently rendered, read from the reels' data attributes. */
async function reelSymbols(page: Page): Promise<string[]> {
  return page.locator('[data-testid="reel"]').evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute("data-symbol") ?? ""),
  );
}

/** Wait for the casino floor to finish its authenticated wallet hydration. */
async function openCasino(page: Page): Promise<void> {
  await page.goto("/casino");
  await expect(page.getByRole("button", { name: /SPIN ·/ })).toBeEnabled();
}

test("spin settles: the ledger's reels render and the balance re-reads", async ({ page, context }) => {
  const gateway = await installGateway(context, { wallet: "settle-after-spin", spin: "settled" });

  await openCasino(page);
  await expect(page.getByText("1,000").first()).toBeVisible();

  await page.getByRole("button", { name: /SPIN ·/ }).click();

  // The engine's symbols — not a local draw.
  await expect
    .poll(() => reelSymbols(page), { message: "reels must show the engine's outcome" })
    .toEqual(["BELL", "BELL", "BELL"]);

  // The win figure is the engine's decimal string, verbatim.
  await expect(notice(page)).toContainText("you won 20.0000 GC");
  // The balance came from the wallet RE-READ, not from the spin response.
  await expect(page.getByText("1,019").first()).toBeVisible();

  expect(gateway.violations, "no unstubbed network calls").toEqual([]);
});

test("insufficient funds: warns, charges nothing, and leaves the reels untouched", async ({ page, context }) => {
  const gateway = await installGateway(context, { wallet: "synced", spin: "insufficient-funds" });

  await openCasino(page);
  const before = await reelSymbols(page);

  await page.getByRole("button", { name: /SPIN ·/ }).click();

  await expect(notice(page)).toContainText("Not enough GC");
  await expect(notice(page)).toContainText("Nothing was charged.");
  // No fabricated outcome survived the rejection.
  await expect.poll(() => reelSymbols(page)).toEqual(before);
  // A business decline is not an outage: the affordance returns immediately.
  await expect(page.getByRole("button", { name: /SPIN ·/ })).toBeEnabled();

  expect(gateway.violations).toEqual([]);
});

test("engine outage: honest copy, spin locked out, then recovers on its own", async ({ page, context }) => {
  const gateway = await installGateway(context, { wallet: "synced", spin: "unavailable" });

  await openCasino(page);
  const before = await reelSymbols(page);

  await page.getByRole("button", { name: /SPIN ·/ }).click();

  await expect(notice(page)).toContainText("Service temporarily unavailable");
  // Deliberately does NOT claim the round failed — it may have settled with the response lost.
  await expect(notice(page)).toContainText("recovers it rather than spinning again");
  await expect.poll(() => reelSymbols(page)).toEqual(before);

  // The lockout is real…
  await expect(page.getByRole("button", { name: /UNAVAILABLE/ })).toBeDisabled();
  // …and bounded: the UI recovers without a reload.
  await expect(page.getByRole("button", { name: /SPIN ·/ })).toBeEnabled({ timeout: 15_000 });

  expect(gateway.violations).toEqual([]);
});

test("409 in-flight: reports the round as still settling, with no lockout", async ({ page, context }) => {
  const gateway = await installGateway(context, { wallet: "synced", spin: "in-flight" });

  await openCasino(page);
  await page.getByRole("button", { name: /SPIN ·/ }).click();

  await expect(notice(page)).toContainText("still settling");
  await expect(page.getByRole("button", { name: /SPIN ·/ })).toBeEnabled();

  expect(gateway.violations).toEqual([]);
});

test("ghost recovery: a replayed round is labelled, not passed off as fresh", async ({ page, context }) => {
  const gateway = await installGateway(context, { wallet: "settle-after-spin", spin: "ghost-recovered" });

  await openCasino(page);
  await page.getByRole("button", { name: /SPIN ·/ }).click();

  await expect.poll(() => reelSymbols(page)).toEqual(["BELL", "BELL", "BELL"]);
  await expect(notice(page)).toContainText("you were not charged twice");

  expect(gateway.violations).toEqual([]);
});

test("a wager in flight blocks the button, so a double-click cannot double-spend", async ({ page, context }) => {
  const gateway = await installGateway(context, { wallet: "synced", spin: "hanging" });

  await openCasino(page);

  const spinRequests: string[] = [];
  page.on("request", (req) => {
    if (req.method() === "POST" && req.url().endsWith("/api/spin")) spinRequests.push(req.url());
  });

  const button = page.getByRole("button", { name: /SPIN ·/ });
  await button.click();

  // The stub never resolves, so the money window stays open and the affordance stays locked.
  await expect(page.getByRole("button", { name: /SPINNING…/ })).toBeDisabled();
  await page.getByRole("button", { name: /SPINNING…/ }).click({ force: true });

  await expect.poll(() => spinRequests.length, { timeout: 5_000 }).toBe(1);

  expect(gateway.violations).toEqual([]);
});

test("the browser never sends an outcome — only a stake, a currency, a game and a key", async ({ page, context }) => {
  const gateway = await installGateway(context, { wallet: "settle-after-spin", spin: "settled" });

  await openCasino(page);

  const bodies: Array<Record<string, unknown>> = [];
  page.on("request", (req) => {
    if (req.method() === "POST" && req.url().endsWith("/api/spin")) {
      const raw = req.postData();
      if (raw) bodies.push(JSON.parse(raw) as Record<string, unknown>);
    }
  });

  await page.getByRole("button", { name: /SPIN ·/ }).click();
  await expect(notice(page)).toContainText("you won");

  expect(bodies).toHaveLength(1);
  const body = bodies[0] ?? {};
  // The security property, asserted on the wire: no win-shaped field can reach the gateway.
  expect(Object.keys(body).sort()).toEqual(["betAmount", "currency", "gameId", "idempotencyKey"]);
  expect(body).toMatchObject({ betAmount: "1.0000", currency: "GC", gameId: "classic-3reel" });
  expect(String(body.idempotencyKey).length).toBeGreaterThanOrEqual(8);

  expect(gateway.violations).toEqual([]);
});
