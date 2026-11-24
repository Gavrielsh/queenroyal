import { expect, test, type Page } from "@playwright/test";

import { installGateway } from "./fixtures/gateway-stubs";

/**
 * End-to-end coverage for the cashier redemption journey. Every gateway call is stubbed — the
 * network layer aborts and records any unrouted origin — so these tests exercise the REAL
 * browser code path (React Query cache, the idempotency token, the KYC gate, the notice
 * policy) against verified wire shapes, without a gateway, engine, or network.
 */

function notice(page: Page) {
  return page.locator('[role="alert"]:not([id="__next-route-announcer__"])');
}

async function openRedeem(page: Page): Promise<void> {
  await page.goto("/redeem");
  await expect(page.getByText("Available to redeem")).toBeVisible();
}

test("happy path: a VERIFIED player redeems and sees the request land in their history", async ({
  page,
  context,
}) => {
  const gateway = await installGateway(context, { wallet: "synced", redemption: "eligible" });

  await openRedeem(page);
  await expect(page.getByText("Minimum")).toBeVisible();
  await expect(page.getByText("No redemption requests yet.")).toBeVisible();

  await page.getByLabel("Amount (SC)").fill("50");
  await page.getByRole("button", { name: "Redeem" }).click();

  await expect(notice(page)).toContainText("Redemption of 50 SC submitted for review.");
  await expect(page.getByText("Under review")).toBeVisible();
  // The wallet re-read went through the same choke point a settled purchase/spin uses.
  await expect(page.getByText("1,000").first()).toBeVisible();

  expect(gateway.violations, "no unstubbed network calls").toEqual([]);
});

test("KYC required: a non-VERIFIED player is pointed at /kyc and cannot submit", async ({ page, context }) => {
  const gateway = await installGateway(context, { wallet: "synced", redemption: "kyc-required" });

  await openRedeem(page);

  await expect(page.getByText("Verify your identity to redeem")).toBeVisible();
  const kycLink = page.getByRole("link", { name: "Verify now" });
  await expect(kycLink).toHaveAttribute("href", "/kyc");

  await expect(page.getByLabel("Amount (SC)")).toBeDisabled();
  await expect(page.getByRole("button", { name: "Redeem" })).toBeDisabled();

  await kycLink.click();
  await expect(page).toHaveURL(/\/kyc$/);
  await expect(page.getByRole("heading", { name: "Identity verification" })).toBeVisible();

  expect(gateway.violations).toEqual([]);
});
