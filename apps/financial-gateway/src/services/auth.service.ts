import bcrypt from "bcryptjs";

import { signAccessToken, type AuthClaims } from "../lib/jwt";
import { log } from "../lib/logger";
import { getPrisma } from "../lib/prisma";
import type { LoginInput, RegisterInput } from "../schemas/auth.schema";
import { provisionTrueEnginePlayer } from "./player-provisioning.service";
import { issueRefreshToken } from "./session.service";

const BCRYPT_ROUNDS = 12;
// Pre-computed bcrypt hash used to equalize timing when an email is not found, reducing the
// user-enumeration signal on login.
const DUMMY_HASH = "$2a$12$CwTycUXWue0Thq9StjUM0uJ8Dvm9k2x9p8jWz4z1qkq1qkq1qkq1";

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

  // Always run a compare (real or dummy hash) so timing doesn't reveal account existence.
  const hashToCompare = user?.passwordHash ?? DUMMY_HASH;
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
