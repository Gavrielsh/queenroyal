import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app";
import { signAccessToken } from "../src/lib/jwt";
import { engineCalls, resetEngine, setEngineHandler } from "./fakes/engine.fake";
import { resetDb, seedUser } from "./fakes/prisma.fake";

vi.mock("../src/lib/prisma", async () => {
  const mod = await import("./fakes/prisma.fake");
  return { getPrisma: () => mod.prismaFake };
});

/**
 * GET /api/wallet — the Zone 3 balance mirror. The contract under test:
 *   - the auth guard runs BEFORE anything else (401 with no/bad bearer token);
 *   - balances come from the engine's signed POST /api/v1/session and are forwarded
 *     VERBATIM as decimal strings (never parsed into floats, never recomputed);
 *   - engine timeout / 5xx FAILS CLOSED with 503 — the gateway never serves a balance
 *     the ledger did not just vouch for.
 */
describe("GET /api/wallet", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(() => {
    resetDb();
    resetEngine();
  });

  function bearerFor(userId: string): string {
    return `Bearer ${signAccessToken({ sub: userId, email: "p@q.io", kycStatus: "VERIFIED", vipLevel: 0 })}`;
  }

  it("→ 401 UNAUTHORIZED with no Authorization header (engine never called)", async () => {
    const res = await app.inject({ method: "GET", url: "/api/wallet" });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ success: false, error: { code: "UNAUTHORIZED" } });
    expect(engineCalls).toHaveLength(0);
  });

  it("→ 401 UNAUTHORIZED with a malformed bearer token", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/wallet",
      headers: { authorization: "Bearer not-a-real-jwt" },
    });
    expect(res.statusCode).toBe(401);
    expect(engineCalls).toHaveLength(0);
  });

  it("→ 200 with the engine's decimal-string balances forwarded verbatim", async () => {
    seedUser({ id: "user-1", trueEnginePlayerId: "11111111-1111-4111-8111-111111111111" });
    setEngineHandler((call) => {
      if (call.path === "/api/v1/session") {
        return {
          ok: true,
          status: 200,
          body: {
            code: "OK",
            player_id: call.body.player_id,
            balances: { gc: "1234.5000", sc_unplayed: "25.0000", sc_redeemable: "5.1250" },
          },
        };
      }
      return { ok: false, status: 500, body: { code: "UNEXPECTED_CALL", message: call.path } };
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/wallet",
      headers: { authorization: bearerFor("user-1") },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      success: true,
      data: {
        player_id: "11111111-1111-4111-8111-111111111111",
        balances: { gc: "1234.5000", sc_unplayed: "25.0000", sc_redeemable: "5.1250" },
      },
    });

    // The read is a signed POST with the player id INSIDE the HMAC-covered body.
    const sessionCall = engineCalls.find((c) => c.path === "/api/v1/session");
    expect(sessionCall).toBeDefined();
    expect(sessionCall?.method).toBe("POST");
    expect(sessionCall?.body).toEqual({ player_id: "11111111-1111-4111-8111-111111111111" });
    expect(sessionCall?.headers["X-Signature"]).toMatch(/^[0-9a-f]{64}$/);
    expect(sessionCall?.headers["X-Operator-Code"]).toBe("TEST_OP");
    expect(sessionCall?.headers["X-Nonce"]).toBeTruthy();
    expect(sessionCall?.headers["X-Timestamp"]).toMatch(/^\d+$/);
  });

  it("→ 503 ENGINE_UNAVAILABLE on engine timeout (fail closed, no fabricated balance)", async () => {
    seedUser({ id: "user-1", trueEnginePlayerId: "11111111-1111-4111-8111-111111111111" });
    setEngineHandler(() => ({ throwKind: "timeout" }));

    const res = await app.inject({
      method: "GET",
      url: "/api/wallet",
      headers: { authorization: bearerFor("user-1") },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ success: false, error: { code: "ENGINE_UNAVAILABLE" } });
  });

  it("→ 404 PLAYER_NOT_FOUND when the ledger does not know the player", async () => {
    seedUser({ id: "user-1", trueEnginePlayerId: "11111111-1111-4111-8111-111111111111" });
    setEngineHandler(() => ({
      ok: false,
      status: 404,
      body: { code: "PLAYER_NOT_FOUND", message: "player not found" },
    }));

    const res = await app.inject({
      method: "GET",
      url: "/api/wallet",
      headers: { authorization: bearerFor("user-1") },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ success: false, error: { code: "PLAYER_NOT_FOUND" } });
  });
});
