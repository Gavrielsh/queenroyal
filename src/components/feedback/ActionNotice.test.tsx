import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ActionNotice, useActionNotice } from "@/components/feedback/ActionNotice";

/** Driver exposing the hook through buttons, mirroring how the windows consume it. */
function Harness() {
  const { notice, showNotice, dismissNotice } = useActionNotice();
  return (
    <div>
      <button type="button" onClick={() => showNotice({ kind: "success", message: "it worked" })}>
        trigger-success
      </button>
      <button type="button" onClick={() => showNotice({ kind: "error", message: "it failed" })}>
        trigger-error
      </button>
      <ActionNotice notice={notice} onDismiss={dismissNotice} />
    </div>
  );
}

afterEach(() => {
  vi.useRealTimers();
});

describe("ActionNotice — success is transient, errors persist", () => {
  it("a success notice auto-dismisses after its window", () => {
    vi.useFakeTimers();
    render(<Harness />);

    fireEvent.click(screen.getByText("trigger-success"));
    expect(screen.getByRole("alert")).toHaveTextContent("it worked");
    // Success carries no dismiss affordance — it takes care of itself.
    expect(screen.queryByRole("button", { name: "Dismiss notification" })).not.toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(4_000);
    });

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("an error notice persists far beyond the success window", () => {
    vi.useFakeTimers();
    render(<Harness />);

    fireEvent.click(screen.getByText("trigger-error"));

    act(() => {
      vi.advanceTimersByTime(60_000);
    });

    expect(screen.getByRole("alert")).toHaveTextContent("it failed");
  });

  it("an error notice clears on explicit dismissal", () => {
    render(<Harness />);

    fireEvent.click(screen.getByText("trigger-error"));
    fireEvent.click(screen.getByRole("button", { name: "Dismiss notification" }));

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("a new error replaces a pending success WITHOUT inheriting its auto-dismiss timer", () => {
    vi.useFakeTimers();
    render(<Harness />);

    fireEvent.click(screen.getByText("trigger-success"));
    act(() => {
      vi.advanceTimersByTime(2_000); // half-way through the success window
    });
    fireEvent.click(screen.getByText("trigger-error"));

    act(() => {
      vi.advanceTimersByTime(60_000); // the stale success timer must NOT clear the error
    });

    expect(screen.getByRole("alert")).toHaveTextContent("it failed");
  });

  it("unmounting with a pending timer leaks nothing (cleanup)", () => {
    vi.useFakeTimers();
    const { unmount } = render(<Harness />);
    fireEvent.click(screen.getByText("trigger-success"));

    unmount();

    expect(() => vi.runAllTimers()).not.toThrow();
  });
});
