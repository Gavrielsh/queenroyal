import type { Metadata } from "next";
import { Suspense } from "react";

import { LoginForm } from "@/components/auth/LoginForm";

export const metadata: Metadata = { title: "Log in — QueenRoyal" };

/** `useSearchParams` (the `?next=` destination) needs a Suspense boundary to prerender. */
export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
