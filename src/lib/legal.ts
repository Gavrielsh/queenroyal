import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Loads the versioned legal markdown under `content/legal/*.md` (docs/PLAN.md item 2) — the
 * lawyer-editable source of truth for every legal page. `content/legal/terms.md` and
 * `rules.md` in particular are the single source of truth for the accepted-terms version: the
 * gateway's `TERMS_VERSION` constant (registration-policy.ts) must equal their front matter
 * `version`, and a gateway test asserts that on every run.
 */

export type LegalSlug = "terms" | "rules" | "privacy" | "responsible-gaming";

export const LEGAL_SLUGS: readonly LegalSlug[] = ["terms", "rules", "privacy", "responsible-gaming"];

export interface LegalDoc {
  slug: LegalSlug;
  title: string;
  version: string;
  effectiveDate: string;
  body: string;
}

const LEGAL_CONTENT_DIR = join(process.cwd(), "content", "legal");

const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/** Parses the flat `key: value` front matter these docs use. No lists, no nesting — every field is a single-line string. */
export function parseFrontMatter(raw: string): { data: Record<string, string>; body: string } {
  const match = FRONT_MATTER.exec(raw);
  if (!match) throw new Error("Legal content file is missing '---' front matter");
  const [, header, body] = match;
  const data: Record<string, string> = {};
  for (const line of header!.split(/\r?\n/)) {
    const at = line.indexOf(":");
    if (at === -1) continue;
    const key = line.slice(0, at).trim();
    const value = line
      .slice(at + 1)
      .trim()
      .replace(/^"(.*)"$/, "$1");
    data[key] = value;
  }
  return { data, body: body!.trim() };
}

export function getLegalDoc(slug: LegalSlug): LegalDoc {
  const raw = readFileSync(join(LEGAL_CONTENT_DIR, `${slug}.md`), "utf8");
  const { data, body } = parseFrontMatter(raw);
  const { title, version, effectiveDate } = data;
  if (!title || !version || !effectiveDate) {
    throw new Error(`content/legal/${slug}.md is missing title/version/effectiveDate front matter`);
  }
  return { slug, title, version, effectiveDate, body };
}
