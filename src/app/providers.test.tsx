import { useQuery } from "@tanstack/react-query";
import { screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/apiClient";
import { makeQueryClient } from "@/lib/queryClient";
import { walletKeys } from "@/lib/queryKeys";
import { renderWithClient } from "@/test/renderWithClient";

describe("query-client policy", () => {
  it("applies the money-appropriate query defaults", () => {
    const queries = makeQueryClient().getDefaultOptions().queries;
    expect(queries?.staleTime).toBe(5_000);
    expect(queries?.retry).toBe(3);
    expect(queries?.refetchOnWindowFocus).toBe(true);
    expect(queries?.refetchOnReconnect).toBe(true);
  });

  it("lets test overrides win while leaving untouched defaults intact", () => {
    const queries = makeQueryClient({ queries: { retry: false, gcTime: 0 } }).getDefaultOptions().queries;
    expect(queries?.retry).toBe(false);
    expect(queries?.gcTime).toBe(0);
    expect(queries?.staleTime).toBe(5_000);
  });
});

describe("renderWithClient", () => {
  it("provides a QueryClient so a component can read an injected query", async () => {
    function Probe() {
      const { data } = useQuery({ queryKey: walletKeys.balances(), queryFn: async () => "balance-ok" });
      return <span>{data ?? "loading"}</span>;
    }

    renderWithClient(<Probe />);

    expect(await screen.findByText("balance-ok")).toBeInTheDocument();
  });
});

describe("QueryCache onError telemetry", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("emits wallet.query.error (warn-level) with the failing query's code + scope", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    function FailingProbe() {
      useQuery({
        queryKey: walletKeys.balances(),
        queryFn: async () => {
          throw new ApiError(503, "LEDGER_REJECTED", "down");
        },
      });
      return <span>failing-probe</span>;
    }

    // retry:false in the test client → the query fails on the first attempt, no backoff wait.
    renderWithClient(<FailingProbe />);

    await waitFor(() => expect(warn).toHaveBeenCalled());
    const emitted = warn.mock.calls
      .map((call) => call[1] as Record<string, unknown> | undefined)
      .find((record) => record?.evt === "wallet.query.error");
    expect(emitted).toMatchObject({ evt: "wallet.query.error", code: "LEDGER_REJECTED", scope: "wallet" });
  });
});
