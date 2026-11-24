"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { type FormEvent, useState } from "react";

import { AuthShell, Field, FormError } from "@/components/auth/AuthShell";
import { AuthFormError, login, safeNextPath } from "@/lib/auth/session";

export function LoginForm() {
  const router = useRouter();
  const next = safeNextPath(useSearchParams().get("next"));
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<{ email?: string; password?: string }>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fieldErrors: typeof errors = {};
    if (!email.trim().includes("@")) fieldErrors.email = "Enter your email address.";
    if (password === "") fieldErrors.password = "Enter your password.";
    setErrors(fieldErrors);
    setFormError(null);
    if (Object.keys(fieldErrors).length > 0) return;

    setPending(true);
    try {
      await login(email.trim(), password);
      router.replace(next);
    } catch (err) {
      setFormError(err instanceof AuthFormError ? err.message : "Something went wrong. Please try again.");
      setPending(false);
    }
  }

  return (
    <AuthShell
      title="Welcome back"
      subtitle="Log in to your QueenRoyal account."
      footer={
        <>
          New to QueenRoyal?{" "}
          <Link href={`/register?next=${encodeURIComponent(next)}`} className="font-extrabold text-gc hover:underline">
            Create an account
          </Link>
        </>
      }
    >
      <form noValidate onSubmit={onSubmit} className="space-y-4" aria-busy={pending}>
        <FormError message={formError} />
        <Field id="login-email" label="Email" error={errors.email}>
          {(props) => (
            <input
              {...props}
              type="email"
              name="email"
              autoComplete="email"
              inputMode="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          )}
        </Field>
        <Field id="login-password" label="Password" error={errors.password}>
          {(props) => (
            <input
              {...props}
              type="password"
              name="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          )}
        </Field>
        <button type="submit" disabled={pending} className="btn-candy btn-gold mt-2 w-full py-4 text-lg">
          {pending ? "Logging in…" : "Log in"}
        </button>
      </form>
    </AuthShell>
  );
}
