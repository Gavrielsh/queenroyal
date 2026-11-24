import type { SpinLine } from "@/lib/apiClient";

/**
 * Which celebration a settled round earns. PRESENTATION ONLY.
 *
 * The tier is read from the engine's own outcome record — the line it evaluated and the
 * symbol that paid — never from the win amount. Money is not parsed or compared here (G2):
 * the celebration shows the engine's `winAmount` string verbatim; it only decides how loud
 * to be about it.
 *
 * The mapping follows the classic-3reel paytable (True: internal/game/paytable.go), where a
 * three-of-a-kind pays CHERRY 5×, LEMON 10×, BELL 20×, DIAMOND 50×, SEVEN 130×, CROWN 400×.
 * Two-of-a-kind and the low three-of-a-kinds get the ordinary in-window win notice.
 */
export type WinTier = "big" | "mega" | "epic";

const THREE_OF_A_KIND_TIERS: Readonly<Record<string, WinTier>> = {
  BELL: "big",
  DIAMOND: "mega",
  SEVEN: "epic",
  CROWN: "epic",
};

export function winTierFor(line: SpinLine, winSymbol: string | null): WinTier | null {
  if (line !== "THREE_OF_A_KIND" || winSymbol === null) return null;
  return THREE_OF_A_KIND_TIERS[winSymbol] ?? null;
}

/** Headlines in escalation order; a tier reveals every headline up to and including its own. */
export const TIER_STEPS: ReadonlyArray<{ tier: WinTier; label: string }> = [
  { tier: "big", label: "BIG WIN" },
  { tier: "mega", label: "MEGA WIN" },
  { tier: "epic", label: "EPIC WIN" },
];
