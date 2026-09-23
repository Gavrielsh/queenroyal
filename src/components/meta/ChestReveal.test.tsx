import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ChestReveal } from "./ChestReveal";

afterEach(() => {
  vi.useRealTimers();
});

describe("ChestReveal", () => {
  it("opens once and reveals the reward label the claim returned", async () => {
    vi.useFakeTimers();
    const onOpen = vi.fn().mockResolvedValue("+5,000 GC");
    render(<ChestReveal onOpen={onOpen} onClose={() => {}} preview />);

    const chest = screen.getByRole("button", { name: "Open the treasure chest" });
    fireEvent.click(chest);
    fireEvent.click(chest);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_400);
    });

    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(screen.getByText("+5,000 GC")).toBeInTheDocument();
    expect(screen.getByText("Preview only — nothing was credited.")).toBeInTheDocument();
  });
});
