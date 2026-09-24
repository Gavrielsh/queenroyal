import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// The in-memory Prisma fake, installed before anything imports the real singleton.
vi.mock("../src/lib/prisma", async () => {
  const mod = await import("./fakes/prisma.fake");
  return { getPrisma: () => mod.prismaFake };
});

import { buildApp } from "../src/app";
import { signAccessToken } from "../src/lib/jwt";
import { resetDb, seedRedemption, seedUser } from "./fakes/prisma.fake";

/**
 * GET /api/store/redemptions — the player's own redemption history + the policy the /redeem
 * screen renders around. Read-only: no engine call, no jurisdiction fence (see store.ts).
 */

const USER_ID = "33333333-3333-4333-8333-333333333333";
const OTHER_USER_ID = "44444444-4444-4444-8444-444444444444";

let app: FastifyInstance;
let token: string;

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
});
afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  resetDb();
  seedUser({ id: USER_ID, email: "player@queenroyal.test", kycStatus: "VERIFIED", residenceState: "NJ" });
  token = signAccessToken({ sub: USER_ID, email: "player@queenroyal.test" });
});

function getRedemptions(bearer: string | null = token) {
  return app.inject({
    method: "GET",
    url: "/api/store/redemptions",
    headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
  });
}

describe("GET /api/store/redemptions — perimeter", () => {
  it("→ 401 without a bearer token", async () => {
    const res = await getRedemptions(null);
    expect(res.statusCode).toBe(401);
  });

  it("→ 200 with an empty history and the default policy for a player who never redeemed", async () => {
    const res = await getRedemptions();
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.requests).toEqual([]);
    expect(body.data.kycStatus).toBe("VERIFIED");
    expect(body.data.policy).toEqual({
      jurisdictionPermitted: true,
      minimumAmount: "50.0000",
      maximumPerRequest: "2500.0000",
      dailyCap: "5000.0000",
      monthlyCap: "20000.0000",
      remainingToday: "5000.0000",
      remainingThisMonth: "20000.0000",
    });
  });

  it("→ orders newest first, scopes to the caller only, and never leaks a balance field", async () => {
    seedRedemption({ id: "r-old", userId: USER_ID, playerId: "p1", amount: "60.0000", createdAt: new Date("2026-01-01T00:00:00Z") });
    seedRedemption({ id: "r-new", userId: USER_ID, playerId: "p1", amount: "70.0000", createdAt: new Date("2026-01-02T00:00:00Z") });
    seedRedemption({ id: "r-other", userId: OTHER_USER_ID, playerId: "p2", amount: "999.0000", createdAt: new Date("2026-01-03T00:00:00Z") });

    const res = await getRedemptions();
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.requests.map((r: { id: string }) => r.id)).toEqual(["r-new", "r-old"]);
    for (const r of body.data.requests) {
      expect(Object.keys(r)).toEqual(["id", "amount", "status", "createdAt", "statusChangedAt"]);
      expect(JSON.stringify(r).toLowerCase()).not.toContain("balance");
    }
  });

  it("→ caps history at 50 rows", async () => {
    for (let i = 0; i < 55; i += 1) {
      seedRedemption({
        id: `r-${i}`,
        userId: USER_ID,
        playerId: "p1",
        amount: "10.0000",
        status: "REJECTED",
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)),
      });
    }
    const res = await getRedemptions();
    expect(res.json().data.requests).toHaveLength(50);
  });

  it("→ remainingToday / remainingThisMonth subtract only cap-counting statuses", async () => {
    const now = new Date();
    seedRedemption({ id: "counts", userId: USER_ID, playerId: "p1", amount: "500.0000", status: "UNDER_REVIEW", createdAt: now });
    seedRedemption({ id: "rejected", userId: USER_ID, playerId: "p1", amount: "10000.0000", status: "REJECTED", createdAt: now });
    seedRedemption({ id: "cancelled", userId: USER_ID, playerId: "p1", amount: "10000.0000", status: "CANCELLED_BY_PLAYER", createdAt: now });

    const res = await getRedemptions();
    const { policy } = res.json().data;
    expect(policy.remainingToday).toBe("4500.0000");
    expect(policy.remainingThisMonth).toBe("19500.0000");
  });

  it("→ reports a closed jurisdiction instead of the default caps", async () => {
    seedUser({ id: USER_ID, email: "player@queenroyal.test", kycStatus: "VERIFIED", residenceState: "WA" });
    token = signAccessToken({ sub: USER_ID, email: "player@queenroyal.test" });

    const res = await getRedemptions();
    expect(res.json().data.policy).toEqual({ jurisdictionPermitted: false });
  });

  it("→ falls back to the default table when residenceState is unset", async () => {
    seedUser({ id: USER_ID, email: "player@queenroyal.test", kycStatus: "PENDING", residenceState: null });
    token = signAccessToken({ sub: USER_ID, email: "player@queenroyal.test" });

    const res = await getRedemptions();
    const body = res.json();
    expect(body.data.kycStatus).toBe("PENDING");
    expect(body.data.policy.jurisdictionPermitted).toBe(true);
    expect(body.data.policy.minimumAmount).toBe("50.0000");
  });
});
