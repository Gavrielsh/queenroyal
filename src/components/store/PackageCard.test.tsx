import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { type DisplayPackage, PackageCard } from "@/components/store/PackageCard";

const PKG: DisplayPackage = {
  id: "pkg_value_20",
  name: "Value",
  price: "$20",
  gc: "20,000 GC",
  sc: "+20 SC bonus",
  highlight: true,
};

function renderCard(overrides: Partial<Parameters<typeof PackageCard>[0]> = {}) {
  const onBuy = vi.fn();
  render(
    <ul>
      <PackageCard pkg={PKG} buying={false} disabled={false} justSettled={false} onBuy={onBuy} {...overrides} />
    </ul>,
  );
  return { onBuy };
}

describe("PackageCard — merchandising over display copy only", () => {
  it("renders the preformatted strings verbatim (no client-side price math)", () => {
    renderCard();

    expect(screen.getByText("Value")).toBeInTheDocument();
    expect(screen.getByText("20,000 GC")).toBeInTheDocument();
    expect(screen.getByText("+20 SC bonus")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "BUY $20" })).toBeEnabled();
  });

  it("shows the Popular ribbon only for highlighted tiers", () => {
    renderCard();
    expect(screen.getByText("Popular")).toBeInTheDocument();

    render(
      <ul>
        <PackageCard
          pkg={{ ...PKG, id: "pkg_starter_5", name: "Starter", highlight: false }}
          buying={false}
          disabled={false}
          justSettled={false}
          onBuy={vi.fn()}
        />
      </ul>,
    );
    expect(screen.getAllByText("Popular")).toHaveLength(1); // only the highlighted card carries it
  });

  it("buying state: in-button spinner, BUYING… label, and the click surface locked", () => {
    renderCard({ buying: true, disabled: true });

    const button = screen.getByRole("button", { name: "BUYING…" });
    expect(button).toBeDisabled();
  });

  it("justSettled renders the transient check badge with an accessible confirmation", () => {
    renderCard({ justSettled: true });

    expect(screen.getByTestId("package-settled-badge")).toBeInTheDocument();
    expect(screen.getByText("Purchase settled")).toBeInTheDocument(); // sr-only confirmation
  });

  it("fires onBuy when idle, never when disabled", () => {
    const { onBuy } = renderCard();
    fireEvent.click(screen.getByRole("button", { name: "BUY $20" }));
    expect(onBuy).toHaveBeenCalledTimes(1);

    const locked = vi.fn();
    render(
      <ul>
        <PackageCard pkg={{ ...PKG, id: "pkg_pro_50" }} buying={false} disabled justSettled={false} onBuy={locked} />
      </ul>,
    );
    const buttons = screen.getAllByRole("button", { name: "BUY $20" });
    fireEvent.click(buttons[1] as HTMLElement);
    expect(locked).not.toHaveBeenCalled();
  });
});
