import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError, apiClient, hasLiveSession, refreshAccessToken } from "@/lib/apiClient";
import { ageOn, latestEligibleBirthDate } from "@/lib/auth/eligibility";
import { AuthFormError, login, logout, register, safeNextPath, toAuthFormError, useSession } from "@/lib/auth/session";
import { ACCESS_TOKEN_KEY, clearAccessToken, writeAccessToken } from "@/lib/auth/token";

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
}

function jwt(claims: Record<string, unknown>): string {
  const enc = (v: object) => btoa(JSON.stringify(v)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  return `${enc({ alg: "HS256", typ: "JWT" })}.${enc(claims)}.sig`;
}
const liveToken = (email = "queen@example.test") => jwt({ sub: "u1", email, exp: Math.floor(Date.now() / 1000) + 900 });
const expiredToken = () => jwt({ sub: "u1", email: "queen@example.test", exp: Math.floor(Date.now() / 1000) - 60 });

const session = (token: string) => ({ success: true, data: { user: { id: "u1" }, accessToken: token } });
const failure = (code: string, status: number) => jsonResponse({ success: false, error: { code, message: code } }, status);

const fetchMock = vi.fn<typeof fetch>();
const calls = () => fetchMock.mock.calls.map(([url, init]) => ({ url: String(url), init: init ?? {} }));

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  window.localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

describe("login / register / logout", () => {
  it("login posts the credentials WITH cookies (the refresh cookie) and stores only the access token", async () => {
    const token = liveToken();
    fetchMock.mockResolvedValueOnce(jsonResponse(session(token)));

    await login("queen@example.test", "hunter2hunter2");

    const [call] = calls();
    expect(call!.url).toMatch(/\/auth\/login$/);
    expect(call!.init.credentials).toBe("include");
    expect(JSON.parse(String(call!.init.body))).toEqual({ email: "queen@example.test", password: "hunter2hunter2" });
    expect(window.localStorage.getItem(ACCESS_TOKEN_KEY)).toBe(token);
    expect(Object.keys(window.localStorage)).toEqual([ACCESS_TOKEN_KEY]);
  });

  it("register sends every sign-up field the gateway requires", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(session(liveToken()), 201));
    const form = {
      email: "new@example.test",
      password: "correct-horse",
      dateOfBirth: "1990-04-12",
      residenceState: "NJ",
      acceptTerms: true,
    };

    await register(form);

    expect(calls()[0]!.url).toMatch(/\/auth\/register$/);
    expect(JSON.parse(String(calls()[0]!.init.body))).toEqual(form);
    expect(hasLiveSession()).toBe(true);
  });

  it.each([
    ["INVALID_CREDENTIALS", 401, null, /don't match/],
    ["EMAIL_TAKEN", 409, "email", /already exists/],
    ["UNDERAGE", 403, "dateOfBirth", /18 or older/],
    ["STATE_NOT_ELIGIBLE", 403, "residenceState", /isn't available in your state/],
    ["RATE_LIMITED", 429, null, /Too many attempts/],
    ["SESSION_STORE_UNAVAILABLE", 503, null, /can't reach the casino/],
  ])("maps %s to player-facing copy on the right field", async (code, status, field, copy) => {
    fetchMock.mockResolvedValueOnce(failure(code, status));
    const err = await login("a@b.test", "x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuthFormError);
    expect((err as AuthFormError).field).toBe(field);
    expect((err as AuthFormError).message).toMatch(copy);
    expect(window.localStorage.getItem(ACCESS_TOKEN_KEY)).toBeNull();
  });

  it("a network failure reads as unreachable, not as wrong credentials", () => {
    expect(toAuthFormError(new ApiError(0, "NETWORK_ERROR", "down")).message).toMatch(/can't reach/);
  });

  it("a 2xx without a token is refused rather than half-signing-in", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ success: true, data: {} }));
    await expect(login("a@b.test", "x")).rejects.toMatchObject({ code: "MALFORMED_SESSION" });
    expect(window.localStorage.getItem(ACCESS_TOKEN_KEY)).toBeNull();
  });

  it("logout signs this device out even when the gateway is unreachable", async () => {
    writeAccessToken(liveToken());
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    await logout();
    expect(window.localStorage.getItem(ACCESS_TOKEN_KEY)).toBeNull();
    expect(calls()[0]!.url).toMatch(/\/auth\/logout$/);
    expect(calls()[0]!.init.credentials).toBe("include");
  });
});

describe("silent refresh on 401", () => {
  it("rotates the refresh cookie once and replays the SAME request with the new token", async () => {
    writeAccessToken(expiredToken());
    const fresh = liveToken();
    fetchMock
      .mockResolvedValueOnce(failure("UNAUTHORIZED", 401))
      .mockResolvedValueOnce(jsonResponse({ success: true, data: { accessToken: fresh } }))
      .mockResolvedValueOnce(jsonResponse({ success: true, data: { ok: 1 } }));

    await expect(apiClient.post("/spin", { idempotencyKey: "k-1" })).resolves.toEqual({ success: true, data: { ok: 1 } });

    const [first, refresh, replay] = calls();
    expect(refresh!.url).toMatch(/\/auth\/refresh$/);
    expect(refresh!.init.credentials).toBe("include");
    expect(replay!.url).toBe(first!.url);
    expect(replay!.init.body).toBe(first!.init.body);
    expect(new Headers(replay!.init.headers).get("Authorization")).toBe(`Bearer ${fresh}`);
    expect(first!.init.credentials).toBe("omit");
  });

  it("concurrent 401s share ONE refresh (the refresh token is single-use)", async () => {
    writeAccessToken(expiredToken());
    let refreshes = 0;
    fetchMock.mockImplementation(async (url) => {
      if (String(url).endsWith("/auth/refresh")) {
        refreshes += 1;
        return jsonResponse({ success: true, data: { accessToken: liveToken() } });
      }
      // Both first attempts fail before any refresh has happened; the replays succeed.
      return refreshes === 0 ? failure("UNAUTHORIZED", 401) : jsonResponse({ success: true, data: {} });
    });

    await Promise.all([apiClient.get("/wallet"), apiClient.get("/bonus/daily")]);
    expect(refreshes).toBe(1);
  });

  it("a refused refresh signs the player out and surfaces the original 401 — no loop", async () => {
    writeAccessToken(expiredToken());
    fetchMock
      .mockResolvedValueOnce(failure("UNAUTHORIZED", 401))
      .mockResolvedValueOnce(failure("INVALID_REFRESH_TOKEN", 401));

    await expect(apiClient.get("/wallet")).rejects.toMatchObject({ status: 401 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(window.localStorage.getItem(ACCESS_TOKEN_KEY)).toBeNull();
  });

  it("a refresh that fails on the network keeps the token (it proves nothing)", async () => {
    const stale = expiredToken();
    writeAccessToken(stale);
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    await expect(refreshAccessToken()).resolves.toBe(false);
    expect(window.localStorage.getItem(ACCESS_TOKEN_KEY)).toBe(stale);
  });

  it("does not refresh a request that carried no token", async () => {
    fetchMock.mockResolvedValueOnce(failure("UNAUTHORIZED", 401));
    await expect(apiClient.get("/wallet")).rejects.toMatchObject({ status: 401 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("replays at most once, even if the fresh token is refused too", async () => {
    writeAccessToken(expiredToken());
    fetchMock
      .mockResolvedValueOnce(failure("UNAUTHORIZED", 401))
      .mockResolvedValueOnce(jsonResponse({ success: true, data: { accessToken: liveToken() } }))
      .mockResolvedValueOnce(failure("UNAUTHORIZED", 401));
    await expect(apiClient.get("/wallet")).rejects.toMatchObject({ status: 401 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe("useSession", () => {
  it("follows sign-in and sign-out, and labels the session with the token's email", () => {
    const { result } = renderHook(() => useSession());
    expect(result.current).toBeNull();
    act(() => writeAccessToken(liveToken("royal@example.test")));
    expect(result.current).toEqual({ email: "royal@example.test" });
    act(() => clearAccessToken());
    expect(result.current).toBeNull();
  });

  it("treats an undecodable token as signed in without a label (never as signed out)", () => {
    const { result } = renderHook(() => useSession());
    act(() => writeAccessToken("opaque-token"));
    expect(result.current).toEqual({ email: null });
  });
});

describe("safeNextPath — no open redirect", () => {
  it.each([
    ["/casino", "/casino"],
    ["/casino?tab=store", "/casino?tab=store"],
    [null, "/casino"],
    ["", "/casino"],
    ["https://evil.example", "/casino"],
    ["//evil.example", "/casino"],
    ["/\\evil.example", "/casino"],
    ["javascript:alert(1)", "/casino"],
  ])("%s → %s", (input, expected) => {
    expect(safeNextPath(input)).toBe(expected);
  });
});

describe("eligibility mirror", () => {
  it("matches the gateway: the 18th birthday is the first eligible day", () => {
    const now = new Date("2026-09-23T15:00:00Z");
    expect(ageOn("2008-09-23", now)).toBe(18);
    expect(ageOn("2008-09-24", now)).toBe(17);
    expect(ageOn("2008-02-30", now)).toBeNull();
    expect(latestEligibleBirthDate(now)).toBe("2008-09-23");
    expect(latestEligibleBirthDate(new Date("2028-02-29T12:00:00Z"))).toBe("2010-02-28");
  });
});
