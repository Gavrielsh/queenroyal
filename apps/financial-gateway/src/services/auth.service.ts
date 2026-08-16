import { randomUUID } from "node:crypto";

import bcrypt from "bcryptjs";

import { getEnv } from "../config/env";
import { signAccessToken, type AuthClaims } from "../lib/jwt";
import { log } from "../lib/logger";
import { getPrisma } from "../lib/prisma";
import type { LoginInput, RegisterInput } from "../schemas/auth.schema";
import { provisionTrueEnginePlayer } from "./player-provisioning.service";
import { issueRefreshToken } from "./session.service";

const BCRYPT_ROUNDS = 12;

/**
 * Decoy hash compared against when an email is not found, so the unknown-account path
 * costs the same as the known-account path and login cannot be used to enumerate users.
 *
 * WHY IT IS DERIVED RATHER THAN HARDCODED
 *
 * The previous constant was a 59-character string. A bcrypt digest is exactly 60:
 * 7 for "$2a$12$", 22 of salt, 31 of hash. bcryptjs could not parse the malformed salt,
 * so `compare` returned false IMMEDIATELY without ever running the key derivation —
 * measured at 0.10ms against 330ms for a real cost-12 compare. A ~3200x gap: the exact
 * signal the decoy exists to suppress, and trivially observable over the network.
 *
 * Hardcoding a valid hash fixes the parse failure but introduces a subtler version of the
 * same bug: a literal pinned at one cost factor drifts the moment BCRYPT_ROUNDS changes.
 * A cost-10 decoy against cost-12 accounts still leaves a ~4x gap.
 *
 * Deriving it from BCRYPT_ROUNDS makes the two paths cost the same BY CONSTRUCTION, and
 * keeps them equal if the work factor is ever raised. The input is a throwaway random
 * UUID, so no password on earth verifies against it.
 *
 * Computed lazily and memoized: one cost-12 hash per process, on the first login that
 * needs it, rather than on every module import (which would tax test startup).
 */
let dummyHash: string | null = null;
function decoyHash(): string {
  if (dummyHash === null) dummyHash = bcrypt.hashSync(randomUUID(), BCRYPT_ROUNDS);
  return dummyHash;
}

export class AuthError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "AuthError";
  }
}

export interface SafeUser {
  id: string;
  email: string;
  kycStatus: string;
  vipLevel: number;
  createdAt: string;
}

export interface AuthResult {
  user: SafeUser;
  accessToken: string;
  refreshToken: string;
}

type UserRecord = {
  id: string;
  email: string;
  kycStatus: string;
  vipLevel: number;
  createdAt: Date;
};

function toSafeUser(u: UserRecord): SafeUser {
  return {
    id: u.id,
    email: u.email,
    kycStatus: u.kycStatus,
    vipLevel: u.vipLevel,
    createdAt: u.createdAt.toISOString(),
  };
}

function claimsFor(user: SafeUser): AuthClaims {
  return { sub: user.id, email: user.email, kycStatus: user.kycStatus, vipLevel: user.vipLevel };
}

async function issue(user: SafeUser): Promise<AuthResult> {
  const accessToken = signAccessToken(claimsFor(user));
  const refreshToken = await issueRefreshToken(user.id);
  return { user, accessToken, refreshToken };
}

export async function register(input: RegisterInput): Promise<AuthResult> {
  const prisma = getPrisma();
  const existing = await prisma.user.findUnique({ where: { email: input.email } });
  if (existing) {
    throw new AuthError("EMAIL_TAKEN", "An account with this email already exists", 409);
  }

  const passwordHash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);
  const user = await prisma.user.create({
    data: { email: input.email, passwordHash },
  });

  // Provision the player in the True Engine and persist its player_id. Non-fatal: the account
  // is created and `resolveTransactingPlayer()` will lazily (idempotently) provision on first
  // transaction. We never block account creation on the ledger.
  try {
    await provisionTrueEnginePlayer(user.id, user.email);
  } catch (err) {
    log().warn({ err, user_id: user.id }, "deferred engine provisioning at registration");
  }

  return issue(toSafeUser(user));
}

export async function login(input: LoginInput): Promise<AuthResult> {
  const user = await getPrisma().user.findUnique({ where: { email: input.email } });

  // Always run a FULL compare — real hash or decoy — so the response time does not
  // reveal whether the account exists. The decoy carries the same cost factor as a real
  // hash, so both paths run the identical amount of key-derivation work.
  const hashToCompare = user?.passwordHash ?? decoyHash();
  const passwordValid = await bcrypt.compare(input.password, hashToCompare);

  if (!user || !passwordValid) {
    throw new AuthError("INVALID_CREDENTIALS", "Invalid email or password", 401);
  }

  return issue(toSafeUser(user));
}

/**
 * Load CURRENT claims for a user (used when minting a new access token on refresh) so a
 * refreshed token always reflects the latest KYC/VIP state rather than a stale snapshot.
 */
export async function loadClaims(userId: string): Promise<AuthClaims> {
  const user = await getPrisma().user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, kycStatus: true, vipLevel: true },
  });
  if (!user) throw new AuthError("USER_NOT_FOUND", "User no longer exists", 401);
  return { sub: user.id, email: user.email, kycStatus: user.kycStatus, vipLevel: user.vipLevel };
}

/** Mint a new short-lived access token from claims (refresh flow). */
export function mintAccessToken(claims: AuthClaims): string {
  return signAccessToken(claims);
}

// ── Dev-only mock session ──────────────────────────────────────────────────────

/**
 * Fixed identity for the dev mock session. The id is STABLE so the engine player mapping,
 * journal rows, and ledger history accumulate on ONE player across restarts and re-logins.
 */
const MOCK_USER_ID = "00000000-0000-0000-0000-000000000001";
const MOCK_USER_EMAIL = "mock-player@queenroyal.dev";

export interface MockLoginResult {
  user: SafeUser;
  accessToken: string;
}

/**
 * DEV-ONLY frictionless login: upsert the fixed mock user and mint a REAL access token with
 * the standard signer — downstream auth (wallet, cashier) sees a token indistinguishable from
 * a credentialed login's, so no verification path is weakened or special-cased.
 *
 * Guarded twice: the route is not registered in production (routes/auth.ts) AND this service
 * throws there, as defense in depth. The user's password hash is bcrypt of a thrown-away
 * random UUID, so the account can never be entered through the credentialed login flow. KYC
 * is VERIFIED so the cashier's purchase gate passes in dev. No refresh session is issued (it
 * would drag in the fail-closed Redis store); the client simply calls this route again when
 * the short-lived access token lapses.
 */
export async function mockLogin(): Promise<MockLoginResult> {
  if (getEnv().NODE_ENV === "production") {
    throw new AuthError("NOT_FOUND", "Route not found", 404);
  }

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
