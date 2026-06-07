import { NextResponse } from "next/server";

/** Standard success envelope: `{ success: true, data }`. */
export function ok<T>(data: T, status = 200): NextResponse {
  return NextResponse.json({ success: true, data }, { status });
}

export interface ApiErrorOptions {
  code: string;
  message: string;
  status: number;
  details?: unknown;
}

/** Standard error envelope: `{ success: false, error: { code, message, details? } }`. */
export function fail({ code, message, status, details }: ApiErrorOptions): NextResponse {
  return NextResponse.json(
    {
      success: false,
      error: { code, message, ...(details !== undefined ? { details } : {}) },
    },
    { status },
  );
}
