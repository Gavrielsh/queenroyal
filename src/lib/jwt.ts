import { randomUUID } from "node:crypto";

import jwt, { type SignOptions } from "jsonwebtoken";

import { getEnv } from "@/lib/env";

/** Claims embedded in the access token. `sub` is the canonical user_id. */
export interface AuthClaims {
  sub: string;
  email: string;
  kycStatus: string;
  vipLevel: number;
}

/**
 * Mint a SHORT-LIVED access token (default 15m). Pinned to HS256 and stamped with a
 * unique `jti`. Long-lived sessions are carried by the separate, revocable refresh token
 * (see session.service) — never by a long access-token TTL.
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
