/**
 * Feature switches for the meta-game UI.
 *
 * Every meta feature has three possible modes:
 *   "off"  — not rendered at all. The default everywhere. A production build reaches only
 *            "off" or "live" — never "demo".
 *   "demo" — rendered with the canned preview data in `demo.ts`, clearly labelled as a
 *            preview. Development builds only, opt-in with NEXT_PUBLIC_META_DEMO=1.
 *   "live" — rendered from the real gateway. Needs BOTH: the feature's client exists
 *            (`LIVE_CAPABLE` below — added in the change that ships its endpoint), AND the
 *            operator switched it on with NEXT_PUBLIC_META_LIVE (comma-separated feature names,
 *            e.g. "dailyWheel,streak,entrance") once the gateway and engine are deployed.
 *            Live wins over demo; it is the only mode that may render in production.
 *
 * Why the production lock: G4 forbids fabricated balances "not even in dev fixtures", and the
 * landing page's trust strip was already stripped of claims the product could not back. A
 * wheel that shows "+10,000 GC" without crediting it, or a jackpot/"recent wins" feed of
 * invented numbers, is exactly that — so demo data can never reach a production bundle, and
 * demo UI never writes to the wallet cache (the balance chips keep showing ledger truth).
 */

export type MetaFeature =
  | "entrance"
  | "dailyWheel"
  | "streak"
  | "vip"
  | "missions"
  | "tournament"
  | "jackpot"
  | "recentWins"
  | "lobby";

export type FeatureMode = "off" | "demo" | "live";

export const META_FEATURES: readonly MetaFeature[] = [
  "entrance",
  "dailyWheel",
  "streak",
  "vip",
  "missions",
  "tournament",
  "jackpot",
  "recentWins",
  "lobby",
];

/**
 * Features whose gateway endpoint, wire parser and tests exist. Add a feature here only in the
 * change that ships all three. The entrance splash shows no data, so it needs no endpoint.
 *   dailyWheel + streak — GET /api/bonus/daily, POST /api/bonus/daily/claim (dailyBonusClient)
 */
const LIVE_CAPABLE: ReadonlySet<MetaFeature> = new Set<MetaFeature>(["entrance", "dailyWheel", "streak"]);

export interface FeatureEnv {
  nodeEnv: string | undefined;
  metaDemo: string | undefined;
  metaLive?: string | undefined;
}

function currentEnv(): FeatureEnv {
  // Literal `process.env.X` reads so Next.js inlines them at build time.
  return {
    nodeEnv: process.env.NODE_ENV,
    metaDemo: process.env.NEXT_PUBLIC_META_DEMO,
    metaLive: process.env.NEXT_PUBLIC_META_LIVE,
  };
}

function liveSwitched(feature: MetaFeature, env: FeatureEnv): boolean {
  return (env.metaLive ?? "")
    .split(",")
    .map((name) => name.trim())
    .includes(feature);
}

export function featureMode(feature: MetaFeature, env: FeatureEnv = currentEnv()): FeatureMode {
  if (LIVE_CAPABLE.has(feature) && liveSwitched(feature, env)) return "live";
  if (env.nodeEnv !== "production" && env.metaDemo === "1") return "demo";
  return "off";
}

/** True when any meta feature renders (used to pick the casino page layout). */
export function anyMetaFeatureOn(env: FeatureEnv = currentEnv()): boolean {
  return META_FEATURES.some((feature) => featureMode(feature, env) !== "off");
}
