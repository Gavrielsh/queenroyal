import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { WalletStatusBanner } from "@/components/wallet/WalletStatusBanner";

afterEach(() => {
  vi.useRealTimers();
});

describe("WalletStatusBanner — honest sync-state readout", () => {
  it("synced: shows ledger-synced with the relative age of the snapshot", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-04T12:00:10Z"));

    render(
      <WalletStatusBanner
        phase="synced"
        errorStatus={null}
        lastSyncedAt={new Date("2026-07-04T12:00:07Z").getTime()}
      />,
    );

    expect(screen.getByText("ledger-synced")).toBeInTheDocument();
    expect(screen.getByTestId("synced-ago")).toHaveTextContent("3s ago");
  });

  it("formats minute-old snapshots as minutes", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-04T12:02:00Z"));

    render(
      <WalletStatusBanner
        phase="synced"
        errorStatus={null}
        lastSyncedAt={new Date("2026-07-04T12:00:00Z").getTime()}
      />,
    );

    expect(screen.getByTestId("synced-ago")).toHaveTextContent("2m ago");
  });

  it("syncing and empty phases render their status copy", () => {
    const { rerender } = render(
      <WalletStatusBanner phase="syncing" errorStatus={null} lastSyncedAt={null} />,
    );
    expect(screen.getByText("syncing…")).toBeInTheDocument();

    rerender(<WalletStatusBanner phase="empty" errorStatus={null} lastSyncedAt={null} />);
    expect(screen.getByText("not synced")).toBeInTheDocument();
  });

  it("401 renders the persistent log-in banner — as status, NEVER a second alert", () => {
    render(<WalletStatusBanner phase="error" errorStatus={401} lastSyncedAt={null} />);

    expect(screen.getByText("log in to see your wallet")).toBeInTheDocument();
    expect(screen.getByTestId("wallet-status-banner")).toHaveRole("status");
    // Action toasts own the alert channel; the banner must not double-announce.
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("transport failure renders the persistent stale banner", () => {
    render(<WalletStatusBanner phase="error" errorStatus={503} lastSyncedAt={null} />);

    expect(screen.getByText("stale — last sync failed")).toBeInTheDocument();
    expect(screen.getByTestId("wallet-status-banner")).toHaveRole("status");
  });
});

describe("WalletStatusBanner — reconcile lifecycle (M4-T3)", () => {
  it("PRECEDENCE: reconciling outranks the stale banner — a pending credit is not a failure", () => {
    render(
      <WalletStatusBanner phase="error" errorStatus={503} lastSyncedAt={null} reconcilePhase="reconciling" />,
    );

    expect(screen.getByText("balance update pending…")).toBeInTheDocument();
    expect(screen.queryByText("stale — last sync failed")).not.toBeInTheDocument();
    // Still the polite status channel — never a second alert.
    expect(screen.getByTestId("wallet-status-banner")).toHaveRole("status");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("reconciling also outranks the healthy status line", () => {
    render(
      <WalletStatusBanner phase="synced" errorStatus={null} lastSyncedAt={Date.now()} reconcilePhase="reconciling" />,
    );

    expect(screen.getByText("balance update pending…")).toBeInTheDocument();
    expect(screen.queryByText("ledger-synced")).not.toBeInTheDocument();
  });

  it("exhausted renders CALM (status role, no danger tone) with the Check-again affordance", () => {
    const onRecheck = vi.fn();
    render(
      <WalletStatusBanner
        phase="synced"
        errorStatus={null}
        lastSyncedAt={Date.now()}
        reconcilePhase="exhausted"
        onRecheck={onRecheck}
      />,
    );

    const banner = screen.getByTestId("wallet-status-banner");
    expect(banner).toHaveRole("status");
    expect(banner).toHaveTextContent("settled — taking longer than usual");
    expect(banner.className).not.toMatch(/danger|stale|warning/);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    expect(onRecheck).toHaveBeenCalledTimes(1);
  });

  it("exhausted without an onRecheck handler renders no button", () => {
    render(
      <WalletStatusBanner phase="synced" errorStatus={null} lastSyncedAt={null} reconcilePhase="exhausted" />,
    );

    expect(screen.getByText("settled — taking longer than usual")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
