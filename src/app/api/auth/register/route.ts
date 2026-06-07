import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/http";
import { registerSchema } from "@/schemas/auth.schema";
import { AuthError, register } from "@/services/auth.service";

// bcrypt / jsonwebtoken / Prisma require the Node.js runtime (not edge).
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail({ code: "INVALID_JSON", message: "Request body must be valid JSON", status: 400 });
  }

  const parsed = registerSchema.safeParse(body);
  if (!parsed.success) {
    return fail({
      code: "VALIDATION_ERROR",
      message: "Invalid registration payload",
      status: 422,
      details: parsed.error.flatten(),
    });
  }

  try {
    const result = await register(parsed.data);
    return ok(result, 201);
  } catch (err) {
    if (err instanceof AuthError) {
      return fail({ code: err.code, message: err.message, status: err.status });
    }
    console.error("[auth/register] unexpected error", err);
    return fail({ code: "INTERNAL_ERROR", message: "Unexpected server error", status: 500 });
  }
}
