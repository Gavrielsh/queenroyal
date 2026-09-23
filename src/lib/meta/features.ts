/**
 * Feature switches for the meta-game UI.
 *
 * Every meta feature has three possible modes:
 *   "off"  — not rendered at all. The default everywhere, and the ONLY mode a production
 *            build can reach today, because none of these features has a gateway endpoint.
 *   "demo" — rendered with the canned preview data in `demo.ts`, clearly labelled as a
 *            preview. Development builds only, opt-in with NEXT_PUBLIC_META_DEMO=1.
 *   "live" — rendered from the real gateway. Reserved: a feature becomes live by adding its
 *            client to `LIVE_READY` below in the same change that ships its endpoint.
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
 * Features whose gateway endpoint and client exist. Empty today — add a feature here only in
 * the change that ships its endpoint, its wire parser, and its tests.
 */
const LIVE_READY: ReadonlySet<MetaFeature> = new Set<MetaFeature>([]);

export interface FeatureEnv {
  nodeEnv: string | undefined;
  metaDemo: string | undefined;
}

function currentEnv(): FeatureEnv {
  // Literal `process.env.X` reads so Next.js inlines them at build time.
  return { nodeEnv: process.env.NODE_ENV, metaDemo: process.env.NEXT_PUBLIC_META_DEMO };
}

export function featureMode(feature: MetaFeature, env: FeatureEnv = currentEnv()): FeatureMode {
  if (LIVE_READY.has(feature)) return "live";
  if (env.nodeEnv !== "production" && env.metaDemo === "1") return "demo";
  return "off";
}

/** True when any meta feature renders (used to pick the casino page layout). */
export function anyMetaFeatureOn(env: FeatureEnv = currentEnv()): boolean {
  return META_FEATURES.some((feature) => featureMode(feature, env) !== "off");
}
