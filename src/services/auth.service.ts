import bcrypt from "bcryptjs";

import { prisma } from "@/lib/prisma";
import { signToken, type AuthClaims } from "@/lib/jwt";
import type { LoginInput, RegisterInput } from "@/schemas/auth.schema";

const BCRYPT_ROUNDS = 12;
// Pre-computed bcrypt hash used to equalize timing when an email is not found,
// reducing the user-enumeration signal on login.
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
  token: string;
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

function issue(user: SafeUser): AuthResult {
  const claims: AuthClaims = {
    sub: user.id,
    email: user.email,
    kycStatus: user.kycStatus,
    vipLevel: user.vipLevel,
  };
  return { user, token: signToken(claims) };
}

export async function register(input: RegisterInput): Promise<AuthResult> {
  const existing = await prisma.user.findUnique({ where: { email: input.email } });
  if (existing) {
    throw new AuthError("EMAIL_TAKEN", "An account with this email already exists", 409);
  }

  const passwordHash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);
  const user = await prisma.user.create({
    data: { email: input.email, passwordHash },
  });

  return issue(toSafeUser(user));
}

export async function login(input: LoginInput): Promise<AuthResult> {
  const user = await prisma.user.findUnique({ where: { email: input.email } });

  // Always run a compare (real or dummy hash) so timing doesn't reveal account existence.
  const hashToCompare = user?.passwordHash ?? DUMMY_HASH;
  const passwordValid = await bcrypt.compare(input.password, hashToCompare);

  if (!user || !passwordValid) {
    throw new AuthError("INVALID_CREDENTIALS", "Invalid email or password", 401);
  }

  return issue(toSafeUser(user));
}
