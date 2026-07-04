import { render, screen } from "@testing-library/react";
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
