import { LegalMarkdown } from "@/components/legal/LegalMarkdown";
import type { LegalDoc } from "@/lib/legal";

/** Shared shell for the four static legal routes (/terms, /rules, /privacy, /responsible-gaming). */
export function LegalPage({ doc }: { doc: LegalDoc }) {
  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-10 sm:py-14">
      <header>
        <p className="text-xs font-black uppercase tracking-wider text-warning">Draft — not legal advice</p>
        <h1 className="mt-2 font-display text-3xl font-semibold tracking-tight text-ink sm:text-4xl">
          {doc.title}
        </h1>
        <p className="mt-2 text-xs font-semibold text-ink-faint">
          Version {doc.version} · Effective {doc.effectiveDate}
        </p>
      </header>
      <div className="mt-8">
        <LegalMarkdown markdown={doc.body} />
      </div>
    </main>
  );
}
