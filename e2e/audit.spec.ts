import { expect, test, type Page } from "@playwright/test";

import { installGateway } from "./fixtures/gateway-stubs";

/**
 * M3-T7 audit — objective measurements, not opinions:
 *   1. No horizontal overflow on any page at any project viewport (360-class included).
 *   2. Primary interactive controls present ≥44px tap targets (WCAG 2.5.5 / Tier-1 floor).
 *   3. Keyboard focus is VISIBLE (the global :focus-visible ring computes a real outline).
 */

async function assertNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(
    overflow.scrollWidth,
    "the page must never scroll horizontally",
  ).toBeLessThanOrEqual(overflow.clientWidth + 1);
}

async function assertTapTarget(page: Page, selector: string, label: string): Promise<void> {
  const box = await page.locator(selector).first().boundingBox();
  expect(box, `${label} must be visible`).not.toBeNull();
  expect(box!.height, `${label} height ≥ 44px`).toBeGreaterThanOrEqual(44);
}

test("audit: landing — overflow, tap targets, visible focus", async ({ page, context }) => {
  const gateway = await installGateway(context, { wallet: "synced" });

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "QueenRoyal" })).toBeVisible();

  await assertNoHorizontalOverflow(page);
  await assertTapTarget(page, 'a[href="/casino"]:has-text("Enter the Casino Floor")', "hero CTA");
  await assertTapTarget(page, 'header a[href="/casino"]', "nav Casino Floor link");
  await assertTapTarget(page, 'footer a:has-text("Sweepstakes Rules")', "footer legal link");

  // Keyboard focus must produce a computed outline (the global :focus-visible ring).
  // Next.js's dev overlay can steal the first tabstop, so walk Tabs until focus reaches OUR
  // chrome (the brand link), then measure the ring on it.
  await page.waitForLoadState("networkidle");
  let reachedBrand = false;
  for (let press = 0; press < 6 && !reachedBrand; press += 1) {
    await page.keyboard.press("Tab");
    reachedBrand = await page.evaluate(
      () => document.activeElement?.getAttribute("aria-label") === "QueenRoyal home",
    );
  }
  expect(reachedBrand, "the brand link must be reachable by keyboard").toBe(true);
  // Poll the computed ring. KNOWN DEV-ONLY ARTIFACT: `next dev` occasionally serves a state
  // where the focused element computes `outline: solid 0px` for the whole page session
  // (verified: the healthy state computes the full 2px token ring, and production CSS is a
  // single compiled stylesheet where this cannot occur). The config's retries:1 absorbs it
  // as a VISIBLE "flaky" marker rather than weakening this assertion.
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const style = getComputedStyle(document.activeElement as HTMLElement);
          return `${style.outlineStyle} ${style.outlineWidth}`;
        }),
      { timeout: 5_000 },
    )
    .toBe("solid 2px");

  expect(gateway.violations).toEqual([]);
});

test("audit: casino floor — overflow and money-action tap targets", async ({ page, context }) => {
  const gateway = await installGateway(context, { wallet: "synced" });

  await page.goto("/casino");
  await expect(page.getByText("ledger-synced")).toHaveCount(2);

  await assertNoHorizontalOverflow(page);
  await assertTapTarget(page, 'button:has-text("SPIN")', "SPIN button");
  await assertTapTarget(page, 'button:has-text("BUY $5")', "BUY button");

  expect(gateway.violations).toEqual([]);
});

test("audit: dismiss control on a persistent error meets the tap floor", async ({ page, context }) => {
  const gateway = await installGateway(context, { wallet: "synced", purchase: "declined" });

  await page.goto("/casino");
  await expect(page.getByText("ledger-synced")).toHaveCount(2);
  await page.getByRole("button", { name: "BUY $5", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Purchase failed" })).toBeVisible();

  // Wait for the notice to finish animating before measuring it.
  //
  // `animate-settle-pop` is declared with `both`, so its BACKWARDS fill — transform:
  // scale(0.92) — applies from the moment the element is styled until the animation
  // actually advances a frame. Measuring in that window returns 0.92 x 44px = 40.48px and
  // fails a check the control genuinely passes once settled. Playwright's reducedMotion
  // does reach the page and collapses the duration to 0.01ms, but it cannot help here:
  // the backwards fill is applied BEFORE the (now instant) animation starts.
  //
  // Scoped to this element's own animations rather than document.getAnimations() so an
  // unrelated looping animation elsewhere on the page can never hang the wait.
  //
  // The 44px floor itself is unchanged — this only measures the settled state, which is
  // the state a user actually taps.
  const notice = page.getByRole("alert").filter({ hasText: "Purchase failed" });
  await notice.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));

  const box = await page.getByRole("button", { name: "Dismiss notification" }).boundingBox();
  expect(box).not.toBeNull();
  expect(box!.height, "dismiss height ≥ 44px").toBeGreaterThanOrEqual(44);
  expect(box!.width, "dismiss width ≥ 44px").toBeGreaterThanOrEqual(44);

  await assertNoHorizontalOverflow(page);
  expect(gateway.violations).toEqual([]);
});
