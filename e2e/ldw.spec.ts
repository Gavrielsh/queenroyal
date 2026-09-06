import { expect, test } from "@playwright/test";

import { installGateway } from "./fixtures/gateway-stubs";

/**
 * Gate C, Zone 3 — the losses-disguised-as-wins ban, end to end in a browser.
 *
 * WHAT THIS ADDS OVER THE UNIT TEST
 *
 * SpinFeedback.test.tsx renders the component in isolation and proves it cannot
 * celebrate a NEUTRAL round. That leaves the wiring untested: whether the app
 * actually passes the engine's class through, and whether some OTHER part of the
 * page — the notice copy, a stray animation — celebrates anyway.
 *
 * So these run the real page against a stubbed gateway returning a real
 * stake-returning round, and assert on what the player would actually see.
 *
 * THE ROUND UNDER TEST
 *
 * A leading CHERRY pair pays x1. The stake comes back, nothing is gained, and
 * `net_position` is exactly zero. With the LEMON pair it is 10.99% of all spins
 * on classic-3reel — not an edge case, the eighth-most-likely thing to happen.
 */

/** Copy that asserts a gain. None of it may render for a non-WIN round. */
const POSITIVE_FRAMING = [/you won/i, /congratulations/i, /nice win/i, /winner/i, /you win\b/i];

/** The celebration class, mirroring src/components/feedback/celebration.ts. */
const WIN_CELEBRATION_CLASS = "animate-pulse-glow";

/**
 * Fails the test if the page ever constructs an Audio element.
 *
 * "No win sound is emitted" cannot be observed from the DOM, so the constructor
 * is instrumented before any application script runs. Any attempt to build audio
 * during a non-WIN round is recorded and asserted against.
 */
async function trapAudio(page: import("@playwright/test").Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __audioSrcs: string[] };
    w.__audioSrcs = [];
    class TrappedAudio {
      volume = 0;
      constructor(src?: string) {
        w.__audioSrcs.push(src ?? "(no src)");
      }
      play(): Promise<void> {
        return Promise.resolve();
      }
    }
    Object.defineProperty(window, "Audio", { value: TrappedAudio, writable: true });
  });
}

async function audioConstructed(page: import("@playwright/test").Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __audioSrcs: string[] }).__audioSrcs);
}

const STAKE_RETURNING_SCENARIOS = [
  { name: "CHERRY pair pays x1", scenario: "stake-returned" as const },
  { name: "LEMON pair pays x1", scenario: "stake-returned-lemon" as const },
];

for (const { name, scenario } of STAKE_RETURNING_SCENARIOS) {
  test(`LDW: ${name} — no sound, no win animation, no positive copy`, async ({ page, context }) => {
    await trapAudio(page);
    await installGateway(context, { wallet: "synced", spin: scenario });

    await page.goto("/casino");
    await expect(page.getByText("ledger-synced")).toHaveCount(2);

    await page.getByRole("button", { name: /^SPIN/ }).click();

    // The round settled and the engine classified it NEUTRAL.
    const feedback = page.getByTestId("spin-feedback");
    await expect(feedback).toBeVisible();
    await expect(feedback).toHaveAttribute("data-feedback", "NEUTRAL");

    // 1. NO WIN SOUND.
    expect(
      await audioConstructed(page),
      "a stake-returning round constructed an audio element",
    ).toEqual([]);

    // 2. NO WIN ANIMATION anywhere on the page.
    await expect(page.locator(`.${WIN_CELEBRATION_CLASS}`)).toHaveCount(0);

    // 3. NO POSITIVE-FRAMING COPY anywhere on the page — not in the feedback
    //    line, and not in the notice either. The notice is where this defect
    //    actually lived: it rendered "CHERRY pays — you won 1.0000 GC".
    const body = (await page.locator("body").textContent()) ?? "";
    for (const pattern of POSITIVE_FRAMING) {
      expect(pattern.test(body), `page rendered positive framing: ${pattern}`).toBe(false);
    }

    // 4. The payout is still stated honestly. Hiding it would be its own
    //    dishonesty — the player watched a pair land and is owed the figure.
    expect(/returned|broke even/i.test(body)).toBe(true);

    // 5. And the celebratory notice styling is not used.
    await expect(page.locator('[data-notice-kind="success"]')).toHaveCount(0);
  });
}

test("LDW: a losing round is not celebrated either", async ({ page, context }) => {
  await trapAudio(page);
  await installGateway(context, { wallet: "synced", spin: "lost" });

  await page.goto("/casino");
  await expect(page.getByText("ledger-synced")).toHaveCount(2);
  await page.getByRole("button", { name: /^SPIN/ }).click();

  await expect(page.getByTestId("spin-feedback")).toHaveAttribute("data-feedback", "LOSS");
  expect(await audioConstructed(page)).toEqual([]);
  await expect(page.locator(`.${WIN_CELEBRATION_CLASS}`)).toHaveCount(0);

  const body = (await page.locator("body").textContent()) ?? "";
  for (const pattern of POSITIVE_FRAMING) {
    expect(pattern.test(body)).toBe(false);
  }
});

/**
 * THE COUNTER-CASE.
 *
 * Without it, every assertion above would still pass if the app had simply
 * stopped celebrating anything at all — which is a different bug, and one this
 * suite would otherwise report as a success. A genuine win must still sound, still
 * animate, and still say so.
 */
test("a genuine win IS celebrated, so the assertions above are not vacuous", async ({
  page,
  context,
}) => {
  await trapAudio(page);
  await installGateway(context, { wallet: "synced", spin: "settled" });

  await page.goto("/casino");
  await expect(page.getByText("ledger-synced")).toHaveCount(2);
  await page.getByRole("button", { name: /^SPIN/ }).click();

  await expect(page.getByTestId("spin-feedback")).toHaveAttribute("data-feedback", "WIN");
  await expect(page.locator(`.${WIN_CELEBRATION_CLASS}`)).toHaveCount(1);

  const srcs = await audioConstructed(page);
  expect(srcs.length, "a genuine win produced no sound").toBeGreaterThan(0);

  const body = (await page.locator("body").textContent()) ?? "";
  expect(POSITIVE_FRAMING.some((p) => p.test(body))).toBe(true);
});
