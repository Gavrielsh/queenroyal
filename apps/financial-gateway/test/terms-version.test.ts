import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { TERMS_VERSION } from "../src/lib/registration-policy";

/**
 * `content/legal/{terms,rules}.md` front matter is the single source of truth for the
 * accepted-terms version a lawyer edits (docs/PLAN.md item 2, web app root). The sign-up
 * checkbox (RegisterForm.tsx) covers BOTH documents under this one `TERMS_VERSION`, so if
 * either markdown file's `version` drifts from the constant a registration would record an
 * acceptance that doesn't match what the player actually read. This test fails the moment
 * that happens, since the two live in separately deployable apps and nothing else would catch
 * a mismatch at build time.
 */
function frontMatterVersion(slug: "terms" | "rules"): string {
  const path = fileURLToPath(new URL(`../../../content/legal/${slug}.md`, import.meta.url));
  const raw = readFileSync(path, "utf8");
  const header = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
  if (!header) throw new Error(`content/legal/${slug}.md is missing front matter`);
  const line = header[1]!.split(/\r?\n/).find((l) => l.startsWith("version:"));
  if (!line) throw new Error(`content/legal/${slug}.md front matter has no version`);
  return line
    .slice("version:".length)
    .trim()
    .replace(/^"(.*)"$/, "$1");
}

describe("TERMS_VERSION matches content/legal", () => {
  it.each(["terms", "rules"] as const)("content/legal/%s.md front matter version equals TERMS_VERSION", (slug) => {
    expect(frontMatterVersion(slug)).toBe(TERMS_VERSION);
  });
});
