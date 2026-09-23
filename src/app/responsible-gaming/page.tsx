import type { Metadata } from "next";

import { LegalPage } from "@/components/legal/LegalPage";
import { getLegalDoc } from "@/lib/legal";

export const metadata: Metadata = { title: "Responsible Gaming — QueenRoyal" };

export default function ResponsibleGamingPage() {
  return <LegalPage doc={getLegalDoc("responsible-gaming")} />;
}
