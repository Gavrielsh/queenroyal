import { timingSafeEqual } from "node:crypto";

import type { NextRequest } from "next/server";

import { getEnv } from "@/lib/env";
import { ok, fail } from "@/lib/http";
import { reconcileEngineRequests } from "@/services/reconciliation.service";

export const runtime = "nodejs";
// Reconciliation must never be statically cached/optimized.
export const dynamic = "force-dynamic";

/**
 * Internal reconciliation trigger for serverless schedulers (Vercel Cron, AWS
 * EventBridge, etc.). Runs ONE batch of {@link reconcileEngineRequests} and returns the
 * summary. Authenticated by a shared `CRON_SECRET`, supplied either as
 * `Authorization: Bearer <secret>` (Vercel Cron default) or `X-Cron-Secret: <secret>`.
 *
 * Fails CLOSED: if `CRON_SECRET` is not configured the endpoint is disabled (503), so it
 * can never run unauthenticated.
 */
async function handle(req: NextRequest) {
  const configured = getEnv().CRON_SECRET;
  if (!configured) {
    return fail({ code: "CRON_DISABLED", message: "CRON_SECRET is not configured", status: 503 });
  }

  const provided = extractSecret(req);
  if (!provided || !constantTimeEquals(provided, configured)) {
    return fail({ code: "UNAUTHORIZED", message: "invalid or missing cron secret", status: 401 });
  }

  try {
    const summary = await reconcileEngineRequests();
    return ok(summary, 200);
  } catch (err) {
    console.error("[cron/reconcile] error", err);
    return fail({ code: "INTERNAL_ERROR", message: "reconciliation run failed", status: 500 });
  }
}

// Vercel Cron issues GET; allow POST too for other schedulers.
export const GET = handle;
export const POST = handle;

function extractSecret(req: NextRequest): string | null {
  const auth = req.headers.get("authorization");
  if (auth && auth.startsWith("Bearer ")) return auth.slice("Bearer ".length).trim();
  return req.headers.get("x-cron-secret");
}

function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
