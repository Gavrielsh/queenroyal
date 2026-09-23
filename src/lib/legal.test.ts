import { describe, expect, it } from "vitest";

import { LEGAL_SLUGS, getLegalDoc, parseFrontMatter } from "@/lib/legal";

describe("parseFrontMatter", () => {
  it("splits a leading '---' block into key/value data and the trimmed body", () => {
    const { data, body } = parseFrontMatter('---\ntitle: Example\nversion: "1.0"\n---\nHello.\n');
    expect(data).toEqual({ title: "Example", version: "1.0" });
    expect(body).toBe("Hello.");
  });

  it("throws when the front matter delimiter is missing", () => {
    expect(() => parseFrontMatter("Hello.")).toThrow(/front matter/);
  });
});

describe("getLegalDoc", () => {
  it.each(LEGAL_SLUGS)("loads content/legal/%s.md with a title, version, effective date, and non-empty body", (slug) => {
    const doc = getLegalDoc(slug);
    expect(doc.slug).toBe(slug);
    expect(doc.title.length).toBeGreaterThan(0);
    expect(doc.version).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(doc.effectiveDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(doc.body.length).toBeGreaterThan(0);
  });

  it("throws a clear error for an unknown slug", () => {
    // @ts-expect-error — intentionally an invalid slug to exercise the file-not-found path.
    expect(() => getLegalDoc("does-not-exist")).toThrow();
  });
});
