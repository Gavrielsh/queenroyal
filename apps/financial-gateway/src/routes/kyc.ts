import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";

import { getEnv } from "../config/env";
import { requireAuth, UnauthorizedError } from "../lib/auth";
import { RateLimiterUnavailableError, rateLimit } from "../lib/rate-limit";
import { errBody, okBody } from "../lib/reply";
import { kycDocumentUploadSchema } from "../schemas/kyc.schema";
import { requestDocumentUpload } from "../services/kyc.service";

/**
 * Identity-verification perimeter.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS ROUTE HANDS OUT
 * ─────────────────────────────────────────────────────────────────────────────
 * Not a place to send a document — a PRESIGNED URL the client uploads to directly. The file
 * travels browser → provider and never enters this process, so there is nothing here to
 * buffer, log or persist.
 *
 * That makes the URL itself the sensitive artifact: a bearer write-handle to an
 * identity-document store, valid for minutes. It is returned once, in the response body, and
 * is never logged — only the opaque `upload_ref` is, which is enough to correlate and useless
 * to anyone who obtains it.
 *
 * The rate limit is therefore about handle minting rather than load. A genuine applicant needs
 * a handful of tickets; a caller asking for hundreds is either a confused client in a retry
 * loop or someone harvesting URLs, and both should be stopped. FAIL CLOSED like every other
 * limiter in the gateway.
 *
 * NOT behind the jurisdiction fence, deliberately. Verifying your identity is not a wager and
 * not a prize claim — it is the compliance step that PRECEDES being allowed either, and a
 * player who has travelled, or whose geo lookup is wrong, must still be able to complete it.
 * The fence guards money movement; it should not be able to strand somebody's account in an
 * unverifiable state. Every route that actually moves money stays fenced.
 */
export const kycRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    "/api/kyc/documents",
    { preHandler: [requireAuthPreHandler, uploadRateLimit] },
    documentUploadHandler,
  );
};

async function requireAuthPreHandler(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    req.authClaims = requireAuth(req);
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      await reply.code(401).send(errBody("UNAUTHORIZED", err.message));
      return;
    }
    throw err;
  }
}

/** Per-account fixed window, fail closed. Runs AFTER auth so the key is a verified subject. */
async function uploadRateLimit(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const env = getEnv();
  const user = req.authClaims;
  // Unreachable in the configured chain (auth 401s first), but the limiter must not silently
  // become a no-op if that order is ever changed.
  if (!user) {
    await reply.code(401).send(errBody("UNAUTHORIZED", "Authentication required"));
    return;
  }

  try {
    const result = await rateLimit(
      `kyc:upload:user:${user.sub}`,
      env.KYC_UPLOAD_RATE_LIMIT_MAX,
      env.KYC_UPLOAD_RATE_LIMIT_WINDOW_SECONDS,
    );
    if (!result.allowed) {
      reply.header("retry-after", String(result.retryAfterSeconds));
      await reply.code(429).send(errBody("RATE_LIMITED", "Too many upload requests; please slow down"));
    }
  } catch (err) {
    if (err instanceof RateLimiterUnavailableError) {
      req.log.error({ user_id: user.sub }, "kyc upload rate limiter unavailable (Redis down) — failing closed");
      await reply.code(503).send(errBody("RATE_LIMITER_UNAVAILABLE", "Service temporarily unavailable"));
      return;
    }
    throw err;
  }
}

async function documentUploadHandler(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const user = req.authClaims;
  if (!user) {
    await reply.code(401).send(errBody("UNAUTHORIZED", "Authentication required"));
    return;
  }

  const parsed = kycDocumentUploadSchema.safeParse(req.body);
  if (!parsed.success) {
    // A body carrying `file` or `content` lands HERE, refused by `.strict()`, rather than
    // being silently stripped — a client whose upload field was quietly dropped would wait
    // for a decision on a document nobody has.
    //
    // The flattened Zod error names the offending KEYS, never their values, so a base64
    // document in a rejected payload is not echoed back into the response or the logs.
    await reply.code(422).send(errBody("VALIDATION_ERROR", "Invalid document upload request", parsed.error.flatten()));
    return;
  }

  try {
    const outcome = await requestDocumentUpload(user, parsed.data, { traceId: req.id });
    if (!outcome.ok) {
      await reply.code(outcome.status).send(errBody(outcome.error.code, outcome.error.message, outcome.error.details));
      return;
    }
    await reply.code(201).send(okBody(outcome.data));
  } catch (err) {
    req.log.error({ err, user_id: user.sub }, "unexpected error issuing a kyc upload ticket");
    await reply.code(500).send(errBody("INTERNAL_ERROR", "Unexpected server error"));
  }
}
