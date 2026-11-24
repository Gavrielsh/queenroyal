import type { ReactNode } from "react";

/**
 * Minimal renderer for the legal docs in `content/legal/*.md`: headings (`##`, `###`),
 * bulleted lists (`- `), paragraphs, and inline `**bold**`. Deliberately not a general-purpose
 * markdown engine — these files are hand-written and only ever use this small subset, so a
 * hand-rolled parser keeps the dependency-light lib/ style used elsewhere (e.g. money.ts,
 * registration-policy.ts) instead of pulling in a full markdown library for four static pages.
 */

type Block = { type: "h2" | "h3" | "p"; text: string } | { type: "ul"; items: string[] };

function parseBlocks(markdown: string): Block[] {
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  let list: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length > 0) {
      blocks.push({ type: "p", text: paragraph.join(" ") });
      paragraph = [];
    }
  };
  const flushList = () => {
    if (list.length > 0) {
      blocks.push({ type: "ul", items: list });
      list = [];
    }
  };

  for (const rawLine of markdown.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "") {
      flushParagraph();
      flushList();
    } else if (line.startsWith("### ")) {
      flushParagraph();
      flushList();
      blocks.push({ type: "h3", text: line.slice(4) });
    } else if (line.startsWith("## ")) {
      flushParagraph();
      flushList();
      blocks.push({ type: "h2", text: line.slice(3) });
    } else if (line.startsWith("- ")) {
      flushParagraph();
      list.push(line.slice(2));
    } else {
      flushList();
      paragraph.push(line);
    }
  }
  flushParagraph();
  flushList();
  return blocks;
}

/** Splits on `**bold**` spans. Every other character stays literal text, so React escapes it — markdown input can never inject markup. */
function renderInline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
    part.startsWith("**") && part.endsWith("**") ? (
      <strong key={i} className="text-ink">
        {part.slice(2, -2)}
      </strong>
    ) : (
      part
    ),
  );
}

export function LegalMarkdown({ markdown }: { markdown: string }) {
  const blocks = parseBlocks(markdown);
  return (
    <div className="space-y-4 text-sm leading-relaxed text-ink-mute">
      {blocks.map((block, i) => {
        if (block.type === "h2") {
          return (
            <h2 key={i} className="pt-4 text-xl font-bold text-ink first:pt-0">
              {renderInline(block.text)}
            </h2>
          );
        }
        if (block.type === "h3") {
          return (
            <h3 key={i} className="pt-2 text-lg font-bold text-ink">
              {renderInline(block.text)}
            </h3>
          );
        }
        if (block.type === "ul") {
          return (
            <ul key={i} className="list-disc space-y-1 pl-6">
              {block.items.map((item, j) => (
                <li key={j}>{renderInline(item)}</li>
              ))}
            </ul>
          );
        }
        return <p key={i}>{renderInline(block.text)}</p>;
      })}
    </div>
  );
}
