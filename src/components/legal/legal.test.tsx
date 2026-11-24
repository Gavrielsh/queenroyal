import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { LegalMarkdown } from "@/components/legal/LegalMarkdown";
import { LegalPage } from "@/components/legal/LegalPage";
import { LEGAL_SLUGS, getLegalDoc } from "@/lib/legal";

describe("LegalMarkdown", () => {
  it("renders headings, paragraphs, bold spans, and lists", () => {
    render(
      <LegalMarkdown
        markdown={["## A heading", "", "A **bold** paragraph.", "", "- one", "- two"].join("\n")}
      />,
    );
    expect(screen.getByRole("heading", { level: 2, name: "A heading" })).toBeInTheDocument();
    expect(screen.getByText("bold")).toBeInTheDocument();
    expect(screen.getByText("one")).toBeInTheDocument();
    expect(screen.getByText("two")).toBeInTheDocument();
  });
});

describe("LegalPage", () => {
  it.each(LEGAL_SLUGS)("renders the %s document's title, version, and body", (slug) => {
    const doc = getLegalDoc(slug);
    render(<LegalPage doc={doc} />);
    expect(screen.getByRole("heading", { level: 1, name: doc.title })).toBeInTheDocument();
    expect(screen.getByText(new RegExp(`Version ${doc.version}`))).toBeInTheDocument();
    expect(screen.getByText("Draft — not legal advice")).toBeInTheDocument();
  });
});
