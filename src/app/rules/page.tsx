import type { Metadata } from "next";

import { LegalPage } from "@/components/legal/LegalPage";
import { getLegalDoc } from "@/lib/legal";

export const metadata: Metadata = { title: "Official Sweepstakes Rules — QueenRoyal" };

export default function RulesPage() {
  return <LegalPage doc={getLegalDoc("rules")} />;
}
