import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/http";
import { loginSchema } from "@/schemas/auth.schema";
import { AuthError, login } from "@/services/auth.service";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail({ code: "INVALID_JSON", message: "Request body must be valid JSON", status: 400 });
  }

  const parsed = loginSchema.safeParse(body);
  if (!parsed.success) {
    return fail({
      code: "VALIDATION_ERROR",
      message: "Invalid login payload",
      status: 422,
      details: parsed.error.flatten(),
    });
  }

  try {
    const result = await login(parsed.data);
    return ok(result, 200);
  } catch (err) {
    if (err instanceof AuthError) {
      return fail({ code: err.code, message: err.message, status: err.status });
    }
    console.error("[auth/login] unexpected error", err);
    return fail({ code: "INTERNAL_ERROR", message: "Unexpected server error", status: 500 });
  }
}
