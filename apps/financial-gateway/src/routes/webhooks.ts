import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";

import { getPaymentProvider } from "../lib/payments";
import {
  PaymentProviderNotConfiguredError,
  type PspWebhookEvent,
  PspWebhookSignatureError,
} from "../lib/payments/types";
import { errBody, okBody } from "../lib/reply";
import { type HeaderGetter, verifyProviderWebhook, WebhookVerificationError } from "../lib/webhook-security";
import { providerSpinSchema } from "../schemas/game.schema";
import { processProviderSpin } from "../services/game-adapter.service";
import { handlePspWebhookEvent } from "../services/psp-webhook.service";

/** Per-request verification context, populated by the preHandler BEFORE the controller runs. */
interface WebhookCtx {
  providerCode?: string;
  pspEvent?: PspWebhookEvent;
}

declare module "fastify" {
  interface FastifyRequest {
    webhookCtx: WebhookCtx | null;
  }
}

// Stripe sends `Stripe-Signature`; accept a generic `X-PSP-Signature` too.
const PSP_SIGNATURE_HEADERS = ["stripe-signature", "x-psp-signature"];

/** Build a single-value header getter from a Fastify request (header names are lowercased). */
function headerGetter(req: FastifyRequest): HeaderGetter {
  return (name) => {
    const v = req.headers[name];
    return Array.isArray(v) ? v[0] : v;
  };
}

/** The raw body captured by the content-type parser (string), or "" if absent. */
function rawBodyOf(req: FastifyRequest): string {
  return typeof req.body === "string" ? req.body : "";
}

/**
 * Webhook perimeter plugin. ENCAPSULATED so its raw-body content-type parser applies ONLY to
 * these routes — every other route keeps Fastify's default JSON parsing.
 *
 * The parser captures the raw bytes WITHOUT JSON-parsing them; the preHandler verifies the
 * signature over those exact bytes and fails fast (401/503) BEFORE the controller — and before
 * any JSON.parse ever runs. Only a verified request is translated and forwarded to the ledger.
 */
export const webhookRoutes: FastifyPluginAsync = async (app) => {
  // Drop the inherited JSON parser in THIS context and capture every content-type's raw body
  // as a string instead. HMAC must run on the exact received bytes, so we never parse first.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser("*", { parseAs: "string" }, (_req, body, done) => {
    done(null, body);
  });

  app.decorateRequest("webhookCtx", null);

  // ── B2B game-aggregator spin webhook ──────────────────────────────────────────
  app.post("/api/webhooks/provider/spin", { preHandler: verifyProviderSpinPerimeter }, providerSpinHandler);

  // ── PSP settlement webhook ────────────────────────────────────────────────────
  app.post("/api/webhooks/psp", { preHandler: verifyPspPerimeter }, pspHandler);
};

// ── preHandlers: the zero-trust perimeter (run BEFORE the controller / any JSON parse) ──

async function verifyProviderSpinPerimeter(req: FastifyRequest, reply: FastifyReply) {
  try {
    const verified = await verifyProviderWebhook(headerGetter(req), rawBodyOf(req));
    req.webhookCtx = { providerCode: verified.providerCode };
  } catch (err) {
    if (err instanceof WebhookVerificationError) {
      req.log.warn({ err_code: err.code, status: err.status }, "webhook verification rejected");
      return reply.code(err.status).send(errBody(err.code, err.message));
    }
    req.log.error({ err }, "webhook verification error");
    return reply.code(500).send(errBody("INTERNAL_ERROR", "Unexpected server error"));
  }
}

async function verifyPspPerimeter(req: FastifyRequest, reply: FastifyReply) {
  const getHeader = headerGetter(req);
  const signature = PSP_SIGNATURE_HEADERS.map((h) => getHeader(h)).find((v): v is string => Boolean(v)) ?? "";
  try {
    const event = getPaymentProvider().parseWebhook(rawBodyOf(req), signature);
    req.webhookCtx = { pspEvent: event };
  } catch (err) {
    if (err instanceof PspWebhookSignatureError) {
      req.log.warn("psp webhook signature rejected");
      return reply.code(401).send(errBody(err.code, "invalid signature"));
    }
    if (err instanceof PaymentProviderNotConfiguredError) {
      req.log.error({ err }, "psp provider not configured");
      return reply.code(503).send(errBody(err.code, "PSP not configured"));
    }
    req.log.error({ err }, "psp webhook parse error");
    return reply.code(500).send(errBody("INTERNAL_ERROR", "Unexpected server error"));
  }
}

// ── handlers: only reached once the perimeter has verified the request ──────────

async function providerSpinHandler(req: FastifyRequest, reply: FastifyReply) {
  const providerCode = req.webhookCtx?.providerCode;
  if (!providerCode) {
    return reply.code(500).send(errBody("INTERNAL_ERROR", "verification context missing"));
  }

  // Parse the verified raw body (HMAC already passed in the preHandler).
  let body: unknown;
  try {
    body = JSON.parse(rawBodyOf(req));
  } catch {
    return reply.code(400).send(errBody("INVALID_JSON", "Request body must be valid JSON"));
  }

  const parsed = providerSpinSchema.safeParse(body);
  if (!parsed.success) {
    return reply.code(422).send(errBody("VALIDATION_ERROR", "Invalid spin webhook payload", parsed.error.flatten()));
  }

  try {
    const outcome = await processProviderSpin(providerCode, parsed.data, { traceId: req.id });
    if (!outcome.ok) {
      return reply.code(outcome.status).send(errBody(outcome.error.code, outcome.error.message, outcome.error.details));
    }
    return reply.code(200).send(okBody(outcome.data));
  } catch (err) {
    req.log.error({ err, provider_transaction_id: parsed.data.provider_transaction_id }, "unexpected error processing spin");
    return reply.code(500).send(errBody("INTERNAL_ERROR", "Unexpected server error"));
  }
}

async function pspHandler(req: FastifyRequest, reply: FastifyReply) {
  const event = req.webhookCtx?.pspEvent;
  if (!event) {
    return reply.code(500).send(errBody("INTERNAL_ERROR", "verification context missing"));
  }
  try {
    const result = await handlePspWebhookEvent(event, req.id);
    // Always 200 once verified+received so the PSP stops retrying; the body reports the action.
    return reply.code(200).send(okBody({ received: true, ...result }));
  } catch (err) {
    req.log.error({ err, payment_intent_id: event.paymentIntentId }, "psp webhook handling failed");
    return reply.code(500).send(errBody("INTERNAL_ERROR", "Webhook handling failed"));
  }
}
