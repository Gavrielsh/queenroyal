import { create } from "zustand";

/**
 * Client-side mirror of the player's wallet (Zone 3 ONLY).
 *
 * NON-NEGOTIABLE: this store never computes money. The single source of truth is the Go
 * double-entry ledger behind the financial gateway; balances arrive as 4-decimal-place
 * decimal STRINGS (e.g. "1234.5000") and are stored and rendered VERBATIM. There is no
 * arithmetic in this store — no optimistic deduction, no win crediting, no allocation
 * logic. The only mutation is overwriting the whole mirror with what the gateway last
 * reported, plus a sync-status flag so the UI can show staleness honestly.
 */

/** Sweeps-model currencies: Gold Coins (play) and Sweeps Coins (promotional). */
export type Currency = "GC" | "SC";

/** Engine-authoritative balances, kept as the engine's decimal strings. */
export interface WalletBalances {
  /** Gold Coin balance (entertainment currency), e.g. "1000.0000". */
  gc: string;
  /** Sweeps Coins that still carry a playthrough requirement. */
  scUnplayed: string;
  /** Sweeps Coins eligible for prize redemption. */
  scRedeemable: string;
}

export type WalletSyncStatus =
  /** Nothing fetched yet — render placeholders, never zeros (a zero is a claim). */
  | "empty"
  /** A fetch is in flight; the displayed values may be stale. */
  | "syncing"
  /** The mirror equals the gateway's last authoritative response. */
  | "synced"
  /** The last fetch failed — the mirror is stale and the UI must say so. */
  | "error";

export interface WalletActions {
  /** Mark a fetch as started (UI shows the stale/loading state). */
  beginSync: () => void;
  /** Overwrite the mirror with authoritative balances from the gateway, verbatim. */
  setBalances: (balances: WalletBalances) => void;
  /** Mark the last fetch as failed; existing values are kept but flagged stale. */
  failSync: () => void;
  /** Drop everything (logout). */
  reset: () => void;
}

export interface WalletState {
  balances: WalletBalances | null;
  status: WalletSyncStatus;
}

export type WalletStore = WalletState & WalletActions;

const initialState: WalletState = {
  balances: null,
  status: "empty",
};

export const useWalletStore = create<WalletStore>()((set) => ({
  ...initialState,

  beginSync: () => set({ status: "syncing" }),

  setBalances: (balances) => set({ balances, status: "synced" }),

  failSync: () => set({ status: "error" }),

  reset: () => set(initialState),
}));
