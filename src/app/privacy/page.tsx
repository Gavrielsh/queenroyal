import type { Metadata } from "next";

import { LegalPage } from "@/components/legal/LegalPage";
import { getLegalDoc } from "@/lib/legal";

export const metadata: Metadata = { title: "Privacy Policy — QueenRoyal" };

export default function PrivacyPage() {
  return <LegalPage doc={getLegalDoc("privacy")} />;
}
