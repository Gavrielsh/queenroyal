import jwt, { type SignOptions } from "jsonwebtoken";

import { getEnv } from "@/lib/env";

/** Claims embedded in the access token. `sub` is the canonical user_id. */
export interface AuthClaims {
  sub: string;
  email: string;
  kycStatus: string;
  vipLevel: number;
}

export function signToken(claims: AuthClaims): string {
  const env = getEnv();
  const options: SignOptions = {
    // Pin the algorithm to HS256 so a token can never be verified under an
    // attacker-chosen alg (algorithm-confusion defense).
    algorithm: "HS256",
    // env value is validated as a string ("7d", "3600", ...); cast to jwt's expiry type.
    expiresIn: env.JWT_EXPIRES_IN as SignOptions["expiresIn"],
  };
  return jwt.sign(claims, env.JWT_SECRET, options);
}

/** Verify + decode a token into typed claims. Throws on any invalid/expired token. */
export function verifyToken(token: string): AuthClaims {
  const env = getEnv();
  // Strictly accept ONLY HS256; reject "none" and any asymmetric alg outright.
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
