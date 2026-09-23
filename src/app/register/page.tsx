import type { Metadata } from "next";
import { Suspense } from "react";

import { RegisterForm } from "@/components/auth/RegisterForm";

export const metadata: Metadata = { title: "Create account — QueenRoyal" };

/** `useSearchParams` (the `?next=` destination) needs a Suspense boundary to prerender. */
export default function RegisterPage() {
  return (
    <Suspense>
      <RegisterForm />
    </Suspense>
  );
}
