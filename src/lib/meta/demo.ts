import type {
  CatalogGame,
  DailyBonusClaim,
  DailyBonusStatus,
  JackpotSnapshot,
  Mission,
  RecentWin,
  Tournament,
  VipLevelUp,
  VipStatus,
  WheelSegment,
} from "@/lib/meta/types";

/**
 * PREVIEW DATA for `featureMode(...) === "demo"` (development builds with
 * NEXT_PUBLIC_META_DEMO=1). Every value here is invented so the meta-game UI can be built and
 * reviewed before its endpoints exist. It is never shown in production (see features.ts),
 * never written to the wallet cache, and every surface that uses it carries a "Preview" badge.
 */

const SEGMENTS: readonly WheelSegment[] = [
  { id: "s1", gc: "5000", sc: "0" },
  { id: "s2", gc: "0", sc: "0.2000" },
  { id: "s3", gc: "10000", sc: "0" },
  { id: "s4", gc: "0", sc: "0.5000" },
  { id: "s5", gc: "2500", sc: "0" },
  { id: "s6", gc: "25000", sc: "1.0000", featured: true },
  { id: "s7", gc: "7500", sc: "0" },
  { id: "s8", gc: "0", sc: "0.3000" },
  { id: "s9", gc: "15000", sc: "0" },
  { id: "s10", gc: "0", sc: "1.0000" },
];

/** Stand-in for the server's weighted draw — demo only. */
const WEIGHTS = [18, 14, 14, 8, 18, 2, 12, 8, 5, 1] as const;

export const demoDailyBonus: DailyBonusStatus = {
  segments: SEGMENTS,
  streakDay: 3,
  canClaim: true,
  nextClaimAt: null,
  streak: [
    { day: 1, label: "2.5K", icon: "coin", state: "claimed" },
    { day: 2, label: "5K", icon: "coin", state: "claimed" },
    { day: 3, label: "Wheel", icon: "wheel", state: "today" },
    { day: 4, label: "0.3 SC", icon: "sc", state: "upcoming" },
    { day: 5, label: "10K", icon: "coin", state: "upcoming" },
    { day: 6, label: "0.5 SC", icon: "sc", state: "upcoming" },
    { day: 7, label: "Chest", icon: "chest", state: "upcoming" },
  ],
};

export function demoDraw(random: () => number = Math.random): DailyBonusClaim {
  const total = WEIGHTS.reduce((sum, w) => sum + w, 0);
  let roll = random() * total;
  for (let i = 0; i < SEGMENTS.length; i++) {
    roll -= WEIGHTS[i] ?? 0;
    const segment = SEGMENTS[i];
    if (roll < 0 && segment) return { segmentId: segment.id, gc: segment.gc, sc: segment.sc };
  }
  const first = SEGMENTS[0] as WheelSegment;
  return { segmentId: first.id, gc: first.gc, sc: first.sc };
}

export const demoVip: VipStatus = {
  level: 4,
  tier: "Duchess",
  nextTier: "Queen",
  points: 6400,
  nextTierPoints: 10000,
};

export const demoLevelUp: VipLevelUp = {
  fromTier: "Duchess",
  toTier: "Queen",
  level: 5,
  perks: ["+15% on every Daily Wheel prize", "Weekly Sweeps Coins bonus", "Birthday gift + priority redemptions"],
};

export const demoMissions: readonly Mission[] = [
  {
    id: "m1",
    title: "Spin 50 times on any slot",
    progress: 50,
    goal: 50,
    rewardLabel: "Treasure chest",
    rewardFamily: "chest",
    claimable: true,
    claimed: false,
  },
  {
    id: "m2",
    title: "Play 3 different games",
    progress: 1,
    goal: 3,
    rewardLabel: "+2,500 GC",
    rewardFamily: "gc",
    claimable: false,
    claimed: false,
  },
  {
    id: "m3",
    title: "Land three Bells",
    progress: 0,
    goal: 1,
    rewardLabel: "+0.3 SC",
    rewardFamily: "sc",
    claimable: false,
    claimed: false,
  },
];

export const demoChestReward = { missionId: "m1", gc: "5000", sc: "0" } as const;

export const demoTournament: Tournament = {
  id: "t1",
  name: "Purple Sprint",
  endsAt: "2099-01-01T00:00:00Z",
  rows: [
    { rank: 1, name: "Reginald_K", prizeLabel: "1,000 SC" },
    { rank: 2, name: "LuckyLyra", prizeLabel: "600 SC" },
    { rank: 3, name: "jetsetjo", prizeLabel: "400 SC" },
    { rank: 27, name: "You", prizeLabel: "25 SC", isYou: true },
  ],
};

export const demoJackpot: JackpotSnapshot = {
  family: "SC",
  pool: "12483.2700",
  tiers: [
    { name: "Grand", amount: "1204.1000" },
    { name: "Major", amount: "311.4500" },
    { name: "Mini", amount: "24.8000" },
  ],
  asOf: "2099-01-01T00:00:00Z",
};

export const demoRecentWins: readonly RecentWin[] = [
  { id: "w1", player: "Mia_R", game: "Lucky Cherries", amount: "48000", family: "GC" },
  { id: "w2", player: "dan.b", game: "Royal 7s", amount: "12.4000", family: "SC" },
  { id: "w3", player: "Kingmaker", game: "Diamond Queen", amount: "210000", family: "GC" },
  { id: "w4", player: "sassy_sue", game: "Golden Bells", amount: "3.7500", family: "SC" },
  { id: "w5", player: "TheDuke", game: "Crown Bonanza", amount: "96500", family: "GC" },
  { id: "w6", player: "Nora77", game: "Lemon Twist", amount: "25.0000", family: "SC" },
];

/**
 * The first entry is the REAL game (`classic-3reel`, the only paytable the engine registers);
 * it launches the live, ledger-backed slot. The others are preview tiles that open a "coming
 * soon" card — the live catalog must never list a game the engine rejects.
 */
export const demoCatalog: readonly CatalogGame[] = [
  { gameId: "classic-3reel", title: "Queen Royal Classic", studio: "QueenRoyal", category: "Slots", art: "crown", palette: ["#A855F7", "#4C1D95"], badge: "HOT", playable: true },
  { gameId: "preview-cherries", title: "Lucky Cherries", studio: "Preview", category: "Slots", art: "cherry", palette: ["#FF7AB8", "#B0105A"], badge: "NEW", playable: false },
  { gameId: "preview-diamond", title: "Diamond Queen", studio: "Preview", category: "Slots", art: "diamond", palette: ["#38BDF8", "#1E3A8A"], playable: false },
  { gameId: "preview-sevens", title: "Royal 7s", studio: "Preview", category: "Jackpots", art: "seven", palette: ["#8B5CF6", "#3B0F7A"], badge: "JACKPOT", playable: false },
  { gameId: "preview-bells", title: "Golden Bells", studio: "Preview", category: "Classic", art: "bell", palette: ["#FDBA74", "#C2410C"], playable: false },
  { gameId: "preview-lemon", title: "Lemon Twist", studio: "Preview", category: "Slots", art: "lemon", palette: ["#FDE047", "#A16207"], badge: "NEW", playable: false },
];
