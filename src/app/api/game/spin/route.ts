import type { NextRequest } from "next/server";

import { requireAuth, UnauthorizedError } from "@/lib/auth-guard";
import { ok, fail } from "@/lib/http";
import { spinSchema } from "@/schemas/game.schema";
import { processSpin } from "@/services/game-adapter.service";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  let user;
  try {
    user = requireAuth(req);
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return fail({ code: "UNAUTHORIZED", message: err.message, status: 401 });
    }
    throw err;
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail({ code: "INVALID_JSON", message: "Request body must be valid JSON", status: 400 });
  }

  const parsed = spinSchema.safeParse(body);
  if (!parsed.success) {
    return fail({
      code: "VALIDATION_ERROR",
      message: "Invalid spin payload",
      status: 422,
      details: parsed.error.flatten(),
    });
  }

  try {
    const outcome = await processSpin(user, parsed.data);
    if (!outcome.ok) {
      return fail({
        code: outcome.error.code,
        message: outcome.error.message,
        status: outcome.status,
        details: outcome.error.details,
      });
    }
    return ok(outcome.data, 200);
  } catch (err) {
    console.error("[game/spin] unexpected error", err);
    return fail({ code: "INTERNAL_ERROR", message: "Unexpected server error", status: 500 });
  }
}
