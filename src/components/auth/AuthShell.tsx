import Link from "next/link";
import type { ReactNode } from "react";

import { CandyIcon } from "@/components/art/CandyIcon";

/** The card that frames the login and sign-up forms. */
export function AuthShell({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
  footer: ReactNode;
}) {
  return (
    <main className="mx-auto grid w-full max-w-md grid-cols-[minmax(0,1fr)] px-4 py-10 sm:py-14">
      <div className="rounded-[2rem] border-2 border-white/10 bg-[radial-gradient(circle_at_50%_0%,#7c3aed_0%,#4c1d95_45%,#2e1065_100%)] p-6 shadow-glow-brand sm:p-8">
        <div className="text-center">
          <CandyIcon name="crown" className="mx-auto h-14 w-14 drop-shadow-[0_0_12px_rgba(255,200,61,0.5)]" />
          <h1 className="mt-3 font-display text-3xl font-semibold tracking-tight text-ink">{title}</h1>
          <p className="mt-1.5 text-sm font-semibold text-[#ede4ff]">{subtitle}</p>
        </div>
        <div className="mt-7">{children}</div>
      </div>
      <p className="mt-6 text-center text-sm font-semibold text-ink-mute">{footer}</p>
      <p className="mt-3 text-center text-xs font-bold uppercase tracking-wider text-ink-faint">
        18+ · No purchase necessary · Void where prohibited
      </p>
      <p className="mt-2 text-center">
        <Link href="/" className="inline-flex min-h-11 items-center text-xs font-semibold text-ink-faint hover:text-ink">
          ← Back to home
        </Link>
      </p>
    </main>
  );
}

const INPUT =
  "block w-full min-h-12 rounded-control border-2 bg-surface-0/70 px-4 text-base text-ink placeholder:text-ink-faint transition focus:border-gc focus:outline-none focus:ring-2 focus:ring-gc/40";

/** A labelled input with an inline error that is announced and linked for screen readers. */
export function Field({
  id,
  label,
  error,
  hint,
  children,
}: {
  id: string;
  label: string;
  error?: string | null;
  hint?: string;
  children: (props: { id: string; className: string; "aria-invalid": boolean; "aria-describedby"?: string }) => ReactNode;
}) {
  const describedBy = [error ? `${id}-error` : null, hint ? `${id}-hint` : null].filter(Boolean).join(" ");
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-sm font-bold text-ink">
        {label}
      </label>
      {children({
        id,
        className: `${INPUT} ${error ? "border-danger" : "border-edge-strong"}`,
        "aria-invalid": Boolean(error),
        ...(describedBy ? { "aria-describedby": describedBy } : {}),
      })}
      {hint && !error ? (
        <p id={`${id}-hint`} className="mt-1 text-xs font-semibold text-ink-faint">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={`${id}-error`} className="mt-1 text-xs font-bold text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** Form-level failure (credentials, rate limit, gateway down). */
export function FormError({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p role="alert" className="rounded-control border-2 border-danger/50 bg-black/30 px-4 py-3 text-sm font-bold text-danger">
      {message}
    </p>
  );
}
