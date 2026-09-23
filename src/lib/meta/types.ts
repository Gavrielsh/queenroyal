/**
 * Data contracts for the meta-game UI (ROADMAP Phase 3: daily bonus, VIP, missions,
 * leaderboards, jackpots) and the lobby catalog (Phase 1.2).
 *
 * These are the shapes the UI renders. They are written ahead of the gateway endpoints so the
 * components can be built now; when an endpoint ships, its client parses the wire envelope
 * into exactly these types (the way `apiClient.ts` does for spins) and the component does not
 * change. Money fields are validated decimal STRINGS, never numbers (G2). Points, counts and
 * ranks are not money and are plain numbers.
 */

/** A money amount as the engine/gateway serializes it: `"5000"`, `"0.2000"`. */
export type MoneyString = string;

// ── Daily wheel + streak ────────────────────────────────────────────────────────────────────

export interface WheelSegment {
  id: string;
  /** Gold Coins this slice grants ("0" when none). */
  gc: MoneyString;
  /** Sweeps Coins this slice grants ("0" when none). */
  sc: MoneyString;
  /** The rare top slice; drawn in gold. */
  featured?: boolean;
}

export interface StreakDay {
  day: number;
  /** Short reward label as the server words it ("5K GC", "Wheel", "0.3 SC"). */
  label: string;
  icon: "coin" | "sc" | "wheel" | "chest";
  state: "claimed" | "today" | "upcoming";
}

export interface DailyBonusStatus {
  segments: readonly WheelSegment[];
  streak: readonly StreakDay[];
  /** Current streak length including today. */
  streakDay: number;
  canClaim: boolean;
  /** ISO timestamp of the next claim window when `canClaim` is false. */
  nextClaimAt: string | null;
}

/**
 * The server's draw. The wheel animates to `segmentId`; it never picks a slice itself. The
 * grant has already been written to the ledger when this arrives (`POST /store/purchase`
 * under a `bonus:daily:<user>:<date>` anchor, per ROADMAP Phase 3).
 */
export interface DailyBonusClaim {
  segmentId: string;
  gc: MoneyString;
  sc: MoneyString;
}

// ── VIP ─────────────────────────────────────────────────────────────────────────────────────

export interface VipStatus {
  level: number;
  tier: string;
  nextTier: string | null;
  points: number;
  nextTierPoints: number | null;
}

export interface VipLevelUp {
  fromTier: string;
  toTier: string;
  level: number;
  perks: readonly string[];
}

// ── Missions ────────────────────────────────────────────────────────────────────────────────

export interface Mission {
  id: string;
  title: string;
  progress: number;
  goal: number;
  /** Reward as the server words it ("+5,000 GC", "Treasure chest"). */
  rewardLabel: string;
  rewardFamily: "gc" | "sc" | "chest";
  claimable: boolean;
  claimed: boolean;
}

export interface MissionReward {
  missionId: string;
  gc: MoneyString;
  sc: MoneyString;
}

// ── Leaderboard / tournament ────────────────────────────────────────────────────────────────

export interface LeaderboardRow {
  rank: number;
  name: string;
  /** Prize for this rank, e.g. "1,000 SC". Display copy from the server. */
  prizeLabel: string;
  isYou?: boolean;
}

export interface Tournament {
  id: string;
  name: string;
  endsAt: string;
  rows: readonly LeaderboardRow[];
}

// ── Jackpot + social proof ──────────────────────────────────────────────────────────────────

export interface JackpotSnapshot {
  family: "GC" | "SC";
  pool: MoneyString;
  tiers: ReadonlyArray<{ name: string; amount: MoneyString }>;
  asOf: string;
}

export interface RecentWin {
  id: string;
  player: string;
  game: string;
  amount: MoneyString;
  family: "GC" | "SC";
}

// ── Lobby catalog ───────────────────────────────────────────────────────────────────────────

export type GameArt = "cherry" | "seven" | "diamond" | "crown" | "bell" | "lemon";

export interface CatalogGame {
  /** Engine game id; the catalog must never list a game the engine rejects. */
  gameId: string;
  title: string;
  studio: string;
  category: string;
  art: GameArt;
  /** Two gradient stops for the tile. */
  palette: readonly [string, string];
  badge?: "HOT" | "NEW" | "JACKPOT";
  rtpDisplay?: string;
  /** False when the game is listed but cannot be launched in this build. */
  playable: boolean;
}
