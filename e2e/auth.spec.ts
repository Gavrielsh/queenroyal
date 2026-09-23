import { expect, test, type Page } from "@playwright/test";

import { installGateway, type InstalledGateway } from "./fixtures/gateway-stubs";

/**
 * Sign-up, sign-in and sign-out, in a real browser against the stubbed gateway.
 *
 * What must hold: the forms send exactly what the gateway's schema requires, a refusal is shown
 * on the field it concerns, a new session lands the player on the casino floor with the ledger's
 * balances, and logging out leaves nothing signed in.
 */

function assertIsolated(gateway: InstalledGateway): void {
  expect(gateway.violations, "no request may escape the stubbed gateway").toEqual([]);
}

/** Form-level alert, excluding Next.js's own route announcer (also role="alert"). */
function formAlert(page: Page) {
  return page.locator('[role="alert"]:not([id="__next-route-announcer__"])');
}

async function fillRegistration(page: Page): Promise<void> {
  await page.getByLabel("Email").fill("new.player@example.test");
  await page.getByLabel("Password").fill("correct-horse-battery");
  await page.getByLabel("Date of birth").fill("1990-04-12");
  await page.getByLabel("State of residence").selectOption("NJ");
  await page.getByRole("checkbox").check();
}

test("sign up: every required field is sent, and the new player lands on the casino floor", async ({ page, context }) => {
  const gateway = await installGateway(context, { wallet: "synced", auth: "ok" });

  await page.goto("/register");
  await fillRegistration(page);
  await page.getByRole("button", { name: "Create account" }).click();

  await expect(page).toHaveURL(/\/casino$/);
  await expect(page.getByText("ledger-synced")).toHaveCount(2);
  await expect(page.getByRole("button", { name: "Log out" })).toBeVisible();
  expect(gateway.authCalls.register).toEqual([
    {
      email: "new.player@example.test",
      password: "correct-horse-battery",
      dateOfBirth: "1990-04-12",
      residenceState: "NJ",
      acceptTerms: true,
    },
  ]);
  assertIsolated(gateway);
});

test("sign up: an ineligible state is refused on that field, and no session is created", async ({ page, context }) => {
  const gateway = await installGateway(context, { wallet: "synced", auth: "state-not-eligible" });

  await page.goto("/register");
  await fillRegistration(page);
  await page.getByRole("button", { name: "Create account" }).click();

  await expect(page.getByText("QueenRoyal isn't available in your state yet.")).toBeVisible();
  await expect(page.getByLabel("State of residence")).toHaveAttribute("aria-invalid", "true");
  await expect(page).toHaveURL(/\/register$/);
  await expect(page.getByRole("link", { name: "Log in" }).first()).toBeVisible();
  assertIsolated(gateway);
});

test("log in: wrong credentials are reported and the player stays on the form", async ({ page, context }) => {
  const gateway = await installGateway(context, { wallet: "synced", auth: "invalid-credentials" });

  await page.goto("/login");
  await page.getByLabel("Email").fill("queen@example.test");
  await page.getByLabel("Password").fill("not-the-password");
  await page.getByRole("button", { name: "Log in" }).click();

  await expect(formAlert(page)).toHaveText("That email and password don't match an account.");
  await expect(page).toHaveURL(/\/login$/);
  expect(gateway.authCalls.login).toEqual([{ email: "queen@example.test", password: "not-the-password" }]);
  assertIsolated(gateway);
});

test("log in → casino floor → log out: the session is gone and the nav offers sign-in again", async ({ page, context }) => {
  const gateway = await installGateway(context, { wallet: "synced", auth: "ok", logout: true });

  await page.goto("/login?next=%2Fcasino");
  await page.getByLabel("Email").fill("queen@example.test");
  await page.getByLabel("Password").fill("correct-horse-battery");
  await page.getByRole("button", { name: "Log in" }).click();

  await expect(page).toHaveURL(/\/casino$/);
  await expect(page.getByText("ledger-synced")).toHaveCount(2);

  await page.getByRole("button", { name: "Log out" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("link", { name: "Log in" })).toBeVisible();
  expect(await page.evaluate(() => window.localStorage.getItem("qr_access_token"))).toBeNull();
  assertIsolated(gateway);
});
