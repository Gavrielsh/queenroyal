import { randomUUID } from "node:crypto";

import bcrypt from "bcryptjs";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { errBody, okBody } from "../lib/reply";
import { signAccessToken } from "../lib/jwt";
import { getPrisma } from "../lib/prisma";
import { claimsFor, toSafeUser, type SafeUser } from "../services/auth.service";

/**
 * DEV-ONLY session bootstrap. THIS ENTIRE MODULE IS EXCLUDED FROM THE PRODUCTION BUILD.
 *
 * ─── Why this file exists at all ──────────────────────────────────────────────────
 *
 * `POST /api/auth/mock-login` mints a real, fully-valid session for a fixed user whose
 * `kycStatus` is VERIFIED — the state that unlocks purchases and redemptions. It is the
 * ONLY code path in the gateway that writes `kycStatus: "VERIFIED"`; every other route
 * leaves KYC where the compliance flow put it. Anyone who can reach this endpoint can
 * therefore mint a KYC-passed identity without presenting a single credential.
 *
 * ─── Why it is a separate module rather than an `if` ──────────────────────────────
 *
 * It used to live in auth.service.ts / routes/auth.ts behind two `NODE_ENV !== "production"`
 * checks. Both were DENYLIST tests, and `NODE_ENV` is parsed with `.default("development")`.
 * An unset or misspelled NODE_ENV — a stray container spec, a process manager that does not
 * forward it, "Production" with a capital P — therefore resolved to "development" and the
 * route registered itself. The guard failed OPEN on exactly the misconfiguration it existed
 * to survive.
 *
 * Being a separate file makes the protection structural instead of conditional:
 * tsconfig.build.json excludes `src/dev`, so `npm run build` never emits this module. A
 * production artifact does not contain the handler, the upsert, or the VERIFIED literal,
 * and `scripts/verify-no-dev-routes.mjs` fails the build if any of them appear in dist/.
 * No environment variable can restore code that was never compiled.
 *
 * The runtime gate in routes/auth.ts (an ALLOWLIST plus an explicit opt-in flag) still
 * applies wherever this module does ship — dev and test — so the two layers are
 * independent: one removes the code, the other refuses to wire it up.
 */

/**
 * Fixed identity for the dev mock session. The id is STABLE so the engine player mapping,
 * journal rows, and ledger history accumulate on ONE player across restarts and re-logins.
 */
const MOCK_USER_ID = "00000000-0000-0000-0000-000000000001";
const MOCK_USER_EMAIL = "mock-player@queenroyal.dev";
const BCRYPT_ROUNDS = 12;

export interface MockLoginResult {
  user: SafeUser;
  accessToken: string;
}

/**
 * Upsert the fixed mock user and mint a REAL access token with the standard signer —
 * downstream auth (wallet, cashier) sees a token indistinguishable from a credentialed
 * login's, so no verification path is weakened or special-cased.
 *
 * The password hash is bcrypt of a thrown-away random UUID, so the account can never be
 * entered through the credentialed login flow. No refresh session is issued (it would drag
 * in the fail-closed Redis store); the client simply calls this route again when the
 * short-lived access token lapses.
 */
export async function mockLogin(): Promise<MockLoginResult> {
  const user = await getPrisma().user.upsert({
    where: { email: MOCK_USER_EMAIL },
    create: {
      id: MOCK_USER_ID,
      email: MOCK_USER_EMAIL,
      passwordHash: await bcrypt.hash(randomUUID(), BCRYPT_ROUNDS),
      kycStatus: "VERIFIED",
    },
    // Re-assert VERIFIED so a hand-edited dev row can't strand the mock user behind KYC.
    update: { kycStatus: "VERIFIED" },
  });

  const safe = toSafeUser(user);
  return { user: safe, accessToken: signAccessToken(claimsFor(safe)) };
}

async function mockLoginHandler(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    const result = await mockLogin();
    req.log.warn({ user_id: result.user.id }, "DEV MOCK LOGIN issued — a KYC-VERIFIED session was minted without credentials");
    await reply.code(200).send(okBody({ user: result.user, accessToken: result.accessToken }));
  } catch (err) {
    req.log.error({ err }, "unexpected error during mock-login");
    await reply.code(500).send(errBody("INTERNAL_ERROR", "Unexpected server error"));
  }
}

/**
 * Register the dev route. Called ONLY from the guarded dynamic import in routes/auth.ts,
 * which has already checked the allowlist and the explicit opt-in flag.
 *
 * Deliberately exempt from the fail-closed Redis rate limiter — that limiter guards real
 * credentials against brute force and this route accepts none, so dev auto-login works with
 * no Redis running. The global per-IP limiter still applies.
 */
export function registerDevMockLogin(app: FastifyInstance): void {
  app.post("/api/auth/mock-login", mockLoginHandler);
}
