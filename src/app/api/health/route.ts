import { NextResponse } from "next/server";

export const runtime = "nodejs";

export function GET() {
  return NextResponse.json({ success: true, data: { status: "ok", service: "gateway-cashier" } });
}
