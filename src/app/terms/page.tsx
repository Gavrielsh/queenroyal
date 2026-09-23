import type { Metadata } from "next";

import { LegalPage } from "@/components/legal/LegalPage";
import { getLegalDoc } from "@/lib/legal";

export const metadata: Metadata = { title: "Terms of Service — QueenRoyal" };

export default function TermsPage() {
  return <LegalPage doc={getLegalDoc("terms")} />;
}
