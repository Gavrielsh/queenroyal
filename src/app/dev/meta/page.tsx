import { notFound } from "next/navigation";

import { MetaShowcase } from "@/components/meta/MetaShowcase";
import { featureMode } from "@/lib/meta/features";

/**
 * /dev/meta — design review of the meta-game UI with demo data. A 404 everywhere except a
 * development build started with NEXT_PUBLIC_META_DEMO=1 (the same switch as the casino
 * floor's preview mode), so it can never ship to players.
 */
export default function MetaShowcasePage() {
  if (featureMode("lobby") !== "demo") notFound();
  return <MetaShowcase />;
}
