"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { type FormEvent, useMemo, useState } from "react";

import { AuthShell, Field, FormError } from "@/components/auth/AuthShell";
import { ageOn, latestEligibleBirthDate, MIN_AGE } from "@/lib/auth/eligibility";
import { AuthFormError, register, type RegisterForm as RegisterFields, safeNextPath } from "@/lib/auth/session";
import { US_STATE_OPTIONS } from "@/lib/auth/usStates";

type FieldErrors = Partial<Record<keyof RegisterFields, string>>;

export function validateRegistration(form: RegisterFields, now: Date): FieldErrors {
  const errors: FieldErrors = {};
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) errors.email = "Enter a valid email address.";
  if (form.password.length < 8) errors.password = "Use at least 8 characters.";
  else if (form.password.length > 128) errors.password = "Use at most 128 characters.";
  const age = ageOn(form.dateOfBirth, now);
  if (age === null) errors.dateOfBirth = "Enter your date of birth.";
  else if (age < MIN_AGE) errors.dateOfBirth = `You must be ${MIN_AGE} or older to play.`;
  if (form.residenceState === "") errors.residenceState = "Choose the state you live in.";
  if (!form.acceptTerms) errors.acceptTerms = "Please accept the terms to continue.";
  return errors;
}

export function RegisterForm() {
  const router = useRouter();
  const next = safeNextPath(useSearchParams().get("next"));
  const maxBirthDate = useMemo(() => latestEligibleBirthDate(new Date()), []);
  const [form, setForm] = useState<RegisterFields>({
    email: "",
    password: "",
    dateOfBirth: "",
    residenceState: "",
    acceptTerms: false,
  });
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const set = <K extends keyof RegisterFields>(key: K, value: RegisterFields[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fieldErrors = validateRegistration(form, new Date());
    setErrors(fieldErrors);
    setFormError(null);
    if (Object.keys(fieldErrors).length > 0) return;

    setPending(true);
    try {
      await register({ ...form, email: form.email.trim() });
      router.replace(next);
    } catch (err) {
      const e = err instanceof AuthFormError ? err : new AuthFormError("Something went wrong. Please try again.", null);
      if (e.field) setErrors({ [e.field]: e.message });
      else setFormError(e.message);
      setPending(false);
    }
  }

  return (
    <AuthShell
      title="Join QueenRoyal"
      subtitle="Create your free account and start spinning."
      footer={
        <>
          Already have an account?{" "}
          <Link href={`/login?next=${encodeURIComponent(next)}`} className="font-extrabold text-gc hover:underline">
            Log in
          </Link>
        </>
      }
    >
      <form noValidate onSubmit={onSubmit} className="space-y-4" aria-busy={pending}>
        <FormError message={formError} />
        <Field id="register-email" label="Email" error={errors.email}>
          {(props) => (
            <input
              {...props}
              type="email"
              name="email"
              autoComplete="email"
              inputMode="email"
              value={form.email}
              onChange={(e) => set("email", e.target.value)}
            />
          )}
        </Field>
        <Field id="register-password" label="Password" error={errors.password} hint="At least 8 characters.">
          {(props) => (
            <input
              {...props}
              type="password"
              name="password"
              autoComplete="new-password"
              value={form.password}
              onChange={(e) => set("password", e.target.value)}
            />
          )}
        </Field>
        <Field id="register-dob" label="Date of birth" error={errors.dateOfBirth} hint={`You must be ${MIN_AGE} or older.`}>
          {(props) => (
            <input
              {...props}
              type="date"
              name="dateOfBirth"
              autoComplete="bday"
              max={maxBirthDate}
              value={form.dateOfBirth}
              onChange={(e) => set("dateOfBirth", e.target.value)}
            />
          )}
        </Field>
        <Field id="register-state" label="State of residence" error={errors.residenceState}>
          {(props) => (
            <select
              {...props}
              name="residenceState"
              autoComplete="address-level1"
              value={form.residenceState}
              onChange={(e) => set("residenceState", e.target.value)}
            >
              <option value="">Choose your state</option>
              {US_STATE_OPTIONS.map((s) => (
                <option key={s.code} value={s.code}>
                  {s.name}
                </option>
              ))}
            </select>
          )}
        </Field>

        <div>
          <label className="flex min-h-11 cursor-pointer items-start gap-3 text-sm font-semibold text-[#ede4ff]">
            <input
              type="checkbox"
              name="acceptTerms"
              checked={form.acceptTerms}
              onChange={(e) => set("acceptTerms", e.target.checked)}
              aria-invalid={Boolean(errors.acceptTerms)}
              aria-describedby={errors.acceptTerms ? "register-terms-error" : undefined}
              className="mt-0.5 h-5 w-5 shrink-0 accent-[#ffc83d]"
            />
            <span>
              I am {MIN_AGE} or older and I accept the{" "}
              <Link
                href="/terms"
                target="_blank"
                rel="noopener noreferrer"
                className="font-extrabold text-gc hover:underline"
              >
                Terms of Service
              </Link>{" "}
              and the{" "}
              <Link
                href="/rules"
                target="_blank"
                rel="noopener noreferrer"
                className="font-extrabold text-gc hover:underline"
              >
                Official Sweepstakes Rules
              </Link>
              .
            </span>
          </label>
          {errors.acceptTerms ? (
            <p id="register-terms-error" className="mt-1 text-xs font-bold text-danger">
              {errors.acceptTerms}
            </p>
          ) : null}
        </div>

        <button type="submit" disabled={pending} className="btn-candy btn-gold mt-2 w-full py-4 text-lg">
          {pending ? "Creating account…" : "Create account"}
        </button>
      </form>
    </AuthShell>
  );
}
