import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BalanceChip } from "@/components/wallet/BalanceChip";

afterEach(() => {
  vi.useRealTimers();
});

describe("BalanceChip — the shared money display primitive", () => {
  it("renders a skeleton (never a fabricated zero) while the value is null", () => {
    render(<BalanceChip family="gc" value={null} />);

    const skeleton = screen.getByTestId("balance-skeleton");
    expect(skeleton).toBeInTheDocument();
    expect(skeleton).toHaveRole("status");
    expect(skeleton).toHaveAccessibleName("Loading GC balance");
    expect(screen.queryByTestId("balance-value")).not.toBeInTheDocument();
  });

  it("renders the engine string formatted, in the family accent", () => {
    render(<BalanceChip family="scUnplayed" value="1000.0000" />);

    const value = screen.getByTestId("balance-value");
    expect(value).toHaveTextContent("1,000");
    expect(value.className).toContain("text-sc-unplayed");
    expect(screen.getByText("SC Unplayed")).toBeInTheDocument();
  });

  it("stale keeps the last authoritative value visible, dimmed and badged", () => {
    const { container } = render(<BalanceChip family="gc" value="1000.0000" stale />);

    expect(screen.getByTestId("balance-value")).toHaveTextContent("1,000");
    expect(screen.getByText("STALE")).toBeInTheDocument();
    expect(container.firstElementChild?.className).toContain("opacity-60");
  });

  it("pulses on a string CHANGE only — never on first paint, never for an equal string", () => {
    vi.useFakeTimers();
    const { rerender } = render(<BalanceChip family="gc" value="1000.0000" />);

    // First paint is not a change.
    expect(screen.getByTestId("balance-value").className).not.toContain("animate-pulse-glow");

    // Same string re-rendered → still no pulse (an unchanged balance is not an event).
    rerender(<BalanceChip family="gc" value="1000.0000" />);
    expect(screen.getByTestId("balance-value").className).not.toContain("animate-pulse-glow");

    // A different string IS a change → one pulse cycle…
    rerender(<BalanceChip family="gc" value="900.0000" />);
    expect(screen.getByTestId("balance-value")).toHaveTextContent("900");
    expect(screen.getByTestId("balance-value").className).toContain("animate-pulse-glow");
  });

  it("the pulse ends after its cycle (class removed)", () => {
    vi.useFakeTimers();
    const { rerender } = render(<BalanceChip family="gc" value="1000.0000" />);
    rerender(<BalanceChip family="gc" value="900.0000" />);
    expect(screen.getByTestId("balance-value").className).toContain("animate-pulse-glow");

    act(() => {
      vi.advanceTimersByTime(1_500);
    });

    expect(screen.getByTestId("balance-value").className).not.toContain("animate-pulse-glow");
  });

  it("loading → first value does not pulse (skeleton-to-value is hydration, not a change)", () => {
    const { rerender } = render(<BalanceChip family="gc" value={null} />);

    rerender(<BalanceChip family="gc" value="1000.0000" />);

    expect(screen.getByTestId("balance-value").className).not.toContain("animate-pulse-glow");
  });
});
