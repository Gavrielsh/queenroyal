import { randomUUID } from "node:crypto";

import jwt, { type SignOptions } from "jsonwebtoken";

import { getEnv } from "../config/env";

/** Claims embedded in the access token. `sub` is the canonical user_id. */
export interface AuthClaims {
  sub: string;
  email: string;
  kycStatus: string;
  vipLevel: number;
}

/**
 * Mint a SHORT-LIVED access token (default 15m). Pinned to HS256 and stamped with a unique
 * `jti`. Long-lived sessions are carried by the separate, revocable refresh token (see
 * session.service) — never by a long access-token TTL.
 */
export function signAccessToken(claims: AuthClaims): string {
  const env = getEnv();
  const options: SignOptions = {
    algorithm: "HS256",
    expiresIn: env.JWT_ACCESS_TTL as SignOptions["expiresIn"],
    jwtid: randomUUID(),
  };
  return jwt.sign(claims, env.JWT_SECRET, options);
}

/** Verify + decode an access token into typed claims. Strictly HS256 only. */
export function verifyAccessToken(token: string): AuthClaims {
  const env = getEnv();
  const decoded = jwt.verify(token, env.JWT_SECRET, { algorithms: ["HS256"] });
  if (typeof decoded === "string") {
    throw new Error("Unexpected string token payload");
  }

  const { sub, email, kycStatus, vipLevel } = decoded as Record<string, unknown>;
  if (typeof sub !== "string" || typeof email !== "string") {
    throw new Error("Malformed token claims");
  }

  return {
    sub,
    email,
    kycStatus: typeof kycStatus === "string" ? kycStatus : "PENDING",
    vipLevel: typeof vipLevel === "number" ? vipLevel : 0,
  };
}

// ── Admin tokens (Day-2 ops API) ────────────────────────────────────────────────────
// Signed with the DEDICATED ADMIN_JWT_SECRET — never the player-facing JWT_SECRET — so a
// compromised player signing key can never mint admin access, and a (role-less) player
// access token can never verify against the admin surface.

/** Claims embedded in an admin token. `sub` identifies the operator (for the audit trail). */
export interface AdminClaims {
  sub: string;
  role: "admin";
}

/** Thrown when the admin surface has no signing secret configured (surface is locked). */
export class AdminAuthDisabledError extends Error {
  constructor() {
    super("ADMIN_JWT_SECRET is not configured; admin surface is locked");
    this.name = "AdminAuthDisabledError";
  }
}

/** Thrown when a token verifies cryptographically but does NOT carry the admin role. */
export class AdminRoleError extends Error {
  constructor() {
    super("Token does not carry the admin role");
    this.name = "AdminRoleError";
  }
}

/**
 * Mint a SHORT-LIVED admin token (default 15m via ADMIN_JWT_TTL). Pinned to HS256 and stamped
 * with a unique `jti`. Used by operator tooling/tests; the gateway itself only verifies.
 */
export function signAdminToken(claims: { sub: string }): string {
  const env = getEnv();
  if (!env.ADMIN_JWT_SECRET) throw new AdminAuthDisabledError();
  const options: SignOptions = {
    algorithm: "HS256",
    expiresIn: env.ADMIN_JWT_TTL as SignOptions["expiresIn"],
    jwtid: randomUUID(),
  };
  return jwt.sign({ sub: claims.sub, role: "admin" }, env.ADMIN_JWT_SECRET, options);
}

/**
 * Verify + decode an admin token. Strictly HS256 against ADMIN_JWT_SECRET, then asserts the
 * `role: "admin"` claim. Throws {@link AdminAuthDisabledError} when no secret is configured
 * (fail closed), {@link AdminRoleError} on a valid-but-not-admin token, and the underlying
 * jsonwebtoken error on anything cryptographically invalid/expired.
 */
export function verifyAdminToken(token: string): AdminClaims {
  const env = getEnv();
  if (!env.ADMIN_JWT_SECRET) throw new AdminAuthDisabledError();

  const decoded = jwt.verify(token, env.ADMIN_JWT_SECRET, { algorithms: ["HS256"] });
  if (typeof decoded === "string") {
    throw new Error("Unexpected string token payload");
  }

  const { sub, role } = decoded as Record<string, unknown>;
  if (typeof sub !== "string" || sub === "") {
    throw new Error("Malformed admin token claims");
  }
  if (role !== "admin") {
    throw new AdminRoleError();
  }

  return { sub, role: "admin" };
}
