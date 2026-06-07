import type { NextRequest } from "next/server";

import { verifyToken, type AuthClaims } from "@/lib/jwt";

export class UnauthorizedError extends Error {
  constructor(message = "Authentication required") {
    super(message);
    this.name = "UnauthorizedError";
  }
}

/**
 * Extract and verify the Bearer token from a request, returning the player's claims.
 * Throws {@link UnauthorizedError} on any missing/malformed/invalid token.
 *
 * Runs on the Node runtime (not edge middleware) because token verification uses
 * `jsonwebtoken`, which depends on Node's crypto.
 */
export function requireAuth(req: NextRequest): AuthClaims {
  const header = req.headers.get("authorization");
  if (!header || !header.startsWith("Bearer ")) {
    throw new UnauthorizedError("Missing or malformed Authorization header");
  }

  const token = header.slice("Bearer ".length).trim();
  if (!token) {
    throw new UnauthorizedError("Empty bearer token");
  }

  try {
    return verifyToken(token);
  } catch {
    throw new UnauthorizedError("Invalid or expired token");
  }
}
