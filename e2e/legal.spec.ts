import { expect, test } from "@playwright/test";

import { installGateway } from "./fixtures/gateway-stubs";

/**
 * The four static legal pages (docs/PLAN.md item 2) and the links that reach them: the
 * omnipresent footer (every page) and the sign-up checkbox (RegisterForm.tsx). None of these
 * pages call the gateway, so `installGateway`'s catch-all is only here to prove that: any
 * request escaping to a non-app origin fails the test.
 */

const LEGAL_ROUTES: Array<{ path: string; heading: string }> = [
  { path: "/terms", heading: "Terms of Service" },
  { path: "/rules", heading: "Official Sweepstakes Rules" },
  { path: "/privacy", heading: "Privacy Policy" },
  { path: "/responsible-gaming", heading: "Responsible Gaming" },
];

for (const { path, heading } of LEGAL_ROUTES) {
  test(`legal page ${path} loads and renders its heading`, async ({ page, context }) => {
    const gateway = await installGateway(context, { wallet: "synced" });

    const response = await page.goto(path);
    expect(response?.status()).toBe(200);
    await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();

    expect(gateway.violations).toEqual([]);
  });
}

test("footer legal links on the landing page reach the real pages", async ({ page, context }) => {
  const gateway = await installGateway(context, { wallet: "synced" });

  await page.goto("/");

  const links: Array<[label: string, path: string]> = [
    ["Sweepstakes Rules", "/rules"],
    ["Terms of Service", "/terms"],
    ["Privacy Policy", "/privacy"],
    ["Responsible Play", "/responsible-gaming"],
  ];

  for (const [label, path] of links) {
    await expect(page.locator("footer").getByRole("link", { name: label })).toHaveAttribute("href", path);
  }

  expect(gateway.violations).toEqual([]);
});

test("the sign-up checkbox links to the Terms of Service and the Official Sweepstakes Rules", async ({
  page,
  context,
}) => {
  const gateway = await installGateway(context, { wallet: "synced" });

  await page.goto("/register");

  // Scoped to <main>: the omnipresent footer also links to these pages by the same names.
  const main = page.getByRole("main");
  await expect(main.getByRole("link", { name: "Terms of Service" })).toHaveAttribute("href", "/terms");
  await expect(main.getByRole("link", { name: "Official Sweepstakes Rules" })).toHaveAttribute("href", "/rules");

  expect(gateway.violations).toEqual([]);
});
