import { create } from "zustand";

/**
 * Client-side mirror of the player's wallet (Zone 3 ONLY).
 *
 * The single source of truth is the Go double-entry ledger behind the financial
 * gateway — this store never *computes* a balance, it only mirrors what the
 * gateway last reported, plus short-lived optimistic deductions for instant UI
 * feedback. Every settled response from the gateway must overwrite this mirror
 * via `setBalances`.
 */

/** Sweeps-model currencies: Gold Coins (play) and Sweeps Coins (promotional). */
export type Currency = "GC" | "SC";

export interface WalletBalances {
  /** Gold Coin balance (entertainment currency). */
  gcBalance: number;
  /** Sweeps Coins that still carry a playthrough requirement. */
  scUnplayed: number;
  /** Sweeps Coins eligible for prize redemption. */
  scRedeemable: number;
}

/**
 * Undo handle returned by `optimisticDeduct`. Calling it restores the exact
 * pre-deduction snapshot — used when the gateway rejects the bet.
 */
export type RollbackFn = () => void;

export interface WalletActions {
  /** Overwrite the mirror with authoritative balances from the gateway. */
  setBalances: (gc: number, scUnplayed: number, scRedeemable: number) => void;
  /**
   * Instantly deduct a wager from the local mirror while the gateway settles
   * the bet. GC comes out of `gcBalance`; SC drains `scUnplayed` first, then
   * `scRedeemable` (standard sweeps playthrough order).
   *
   * Throws if the mirror shows insufficient funds — callers should not even
   * send the bet in that case. Returns a rollback to undo on server rejection.
   */
  optimisticDeduct: (amount: number, currency: Currency) => RollbackFn;
}

export type WalletStore = WalletBalances & WalletActions;

export class InsufficientFundsError extends Error {
  constructor(public readonly currency: Currency, public readonly requested: number) {
    super(`Insufficient ${currency} balance for wager of ${requested}`);
    this.name = "InsufficientFundsError";
  }
}

const initialBalances: WalletBalances = {
  gcBalance: 0,
  scUnplayed: 0,
  scRedeemable: 0,
};

export const useWalletStore = create<WalletStore>()((set, get) => ({
  ...initialBalances,

  setBalances: (gc, scUnplayed, scRedeemable) =>
    set({ gcBalance: gc, scUnplayed, scRedeemable }),

  optimisticDeduct: (amount, currency) => {
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new RangeError(`Wager must be a positive finite number, got ${amount}`);
    }

    const snapshot: WalletBalances = {
      gcBalance: get().gcBalance,
      scUnplayed: get().scUnplayed,
      scRedeemable: get().scRedeemable,
    };

    if (currency === "GC") {
      if (snapshot.gcBalance < amount) throw new InsufficientFundsError("GC", amount);
      set({ gcBalance: snapshot.gcBalance - amount });
    } else {
      const totalSc = snapshot.scUnplayed + snapshot.scRedeemable;
      if (totalSc < amount) throw new InsufficientFundsError("SC", amount);
      const fromUnplayed = Math.min(snapshot.scUnplayed, amount);
      set({
        scUnplayed: snapshot.scUnplayed - fromUnplayed,
        scRedeemable: snapshot.scRedeemable - (amount - fromUnplayed),
      });
    }

    // Restores the pre-bet snapshot. Only call when the gateway REJECTED the
    // bet — on success, sync with the server's balances instead.
    return () => set(snapshot);
  },
}));
