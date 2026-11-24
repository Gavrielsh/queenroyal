import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { demoDailyBonus } from "@/lib/meta/demo";

import { DailyWheel } from "./DailyWheel";

afterEach(() => {
  vi.useRealTimers();
});

describe("DailyWheel", () => {
  it("asks the server for the draw and shows ITS amounts verbatim, marked as a preview", async () => {
    vi.useFakeTimers();
    const onClaim = vi.fn().mockResolvedValue({ segmentId: "s6", gc: "25000", sc: "1.0000" });
    render(<DailyWheel status={demoDailyBonus} onClaim={onClaim} onClose={() => {}} preview />);

    fireEvent.click(screen.getByRole("button", { name: "SPIN!" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6_000);
    });

    expect(onClaim).toHaveBeenCalledTimes(1);
    expect(screen.getByText("+25,000 GC")).toBeInTheDocument();
    expect(screen.getByText("+1 SC")).toBeInTheDocument();
    expect(screen.getByText("Preview only — nothing was credited.")).toBeInTheDocument();
    // The wheel turned to the claimed slice (index 5 of 10), never a slice of its own choosing.
    const rotation = Number(screen.getByTestId("wheel-face").getAttribute("data-rotation"));
    expect(Math.abs((((rotation % 360) + 360) % 360) - 180)).toBeLessThan(18);
  });

  it("spins only once, and reports a failed claim honestly without showing a prize", async () => {
    vi.useFakeTimers();
    const onClaim = vi.fn().mockRejectedValue(new Error("503"));
    render(<DailyWheel status={demoDailyBonus} onClaim={onClaim} onClose={() => {}} preview={false} />);

    const spin = screen.getByRole("button", { name: "SPIN!" });
    fireEvent.click(spin);
    fireEvent.click(spin);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(onClaim).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("alert")).toHaveTextContent("Nothing was claimed");
    expect(screen.queryByText(/\+.* GC/)).not.toBeInTheDocument();
  });

  it("cannot be spun when today's claim is used", () => {
    render(
      <DailyWheel status={{ ...demoDailyBonus, canClaim: false }} onClaim={vi.fn()} onClose={() => {}} preview />,
    );
    expect(screen.getByRole("button", { name: "SPIN!" })).toBeDisabled();
    expect(screen.getByText(/come back tomorrow/)).toBeInTheDocument();
  });
});
