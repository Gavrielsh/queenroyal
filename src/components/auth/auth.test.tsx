import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const router = { replace: vi.fn(), push: vi.fn() };
let search = new URLSearchParams();
vi.mock("next/navigation", () => ({
  useRouter: () => router,
  usePathname: () => "/casino",
  useSearchParams: () => search,
}));

import { AuthGate } from "@/components/auth/AuthGate";
import { LoginForm } from "@/components/auth/LoginForm";
import { RegisterForm, validateRegistration } from "@/components/auth/RegisterForm";
import { ACCESS_TOKEN_KEY, clearAccessToken, writeAccessToken } from "@/lib/auth/token";

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
}
const failure = (code: string, status: number) => jsonResponse({ success: false, error: { code, message: code } }, status);
function liveToken(): string {
  const enc = (v: object) => btoa(JSON.stringify(v)).replace(/=+$/, "");
  return `${enc({ alg: "HS256" })}.${enc({ sub: "u1", email: "q@example.test", exp: Math.floor(Date.now() / 1000) + 900 })}.s`;
}
const sessionEnvelope = () => ({ success: true, data: { user: { id: "u1" }, accessToken: liveToken() } });

const fetchMock = vi.fn<typeof fetch>();
const pathsCalled = () => fetchMock.mock.calls.map(([url]) => new URL(String(url)).pathname);

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  window.localStorage.clear();
  search = new URLSearchParams();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  fetchMock.mockReset();
  router.replace.mockReset();
  router.push.mockReset();
});

describe("LoginForm", () => {
  it("signs in and goes to the ?next= destination", async () => {
    search = new URLSearchParams({ next: "/casino?tab=store" });
    fetchMock.mockResolvedValueOnce(jsonResponse(sessionEnvelope()));
    render(<LoginForm />);

    await userEvent.type(screen.getByLabelText("Email"), "q@example.test");
    await userEvent.type(screen.getByLabelText("Password"), "hunter2hunter2");
    await userEvent.click(screen.getByRole("button", { name: "Log in" }));

    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/casino?tab=store"));
    expect(window.localStorage.getItem(ACCESS_TOKEN_KEY)).not.toBeNull();
  });

  it("shows wrong credentials as a form alert and stays put", async () => {
    fetchMock.mockResolvedValueOnce(failure("INVALID_CREDENTIALS", 401));
    render(<LoginForm />);

    await userEvent.type(screen.getByLabelText("Email"), "q@example.test");
    await userEvent.type(screen.getByLabelText("Password"), "nope");
    await userEvent.click(screen.getByRole("button", { name: "Log in" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/don't match/);
    expect(router.replace).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Log in" })).toBeEnabled();
  });

  it("does not call the gateway with empty fields", async () => {
    render(<LoginForm />);
    await userEvent.click(screen.getByRole("button", { name: "Log in" }));
    expect(screen.getByLabelText("Email")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByLabelText("Password")).toHaveAttribute("aria-invalid", "true");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses an off-site ?next= (no open redirect)", async () => {
    search = new URLSearchParams({ next: "//evil.example" });
    fetchMock.mockResolvedValueOnce(jsonResponse(sessionEnvelope()));
    render(<LoginForm />);
    await userEvent.type(screen.getByLabelText("Email"), "q@example.test");
    await userEvent.type(screen.getByLabelText("Password"), "hunter2hunter2");
    await userEvent.click(screen.getByRole("button", { name: "Log in" }));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/casino"));
  });
});

describe("RegisterForm", () => {
  const now = new Date("2026-09-23T15:00:00Z");
  const complete = {
    email: "new@example.test",
    password: "correct-horse",
    dateOfBirth: "1990-04-12",
    residenceState: "NJ",
    acceptTerms: true,
  };

  it("validateRegistration flags every missing or ineligible field", () => {
    expect(validateRegistration(complete, now)).toEqual({});
    expect(
      validateRegistration({ email: "nope", password: "short", dateOfBirth: "", residenceState: "", acceptTerms: false }, now),
    ).toEqual({
      email: expect.any(String),
      password: expect.any(String),
      dateOfBirth: expect.any(String),
      residenceState: expect.any(String),
      acceptTerms: expect.any(String),
    });
    expect(validateRegistration({ ...complete, dateOfBirth: "2008-09-24" }, now).dateOfBirth).toMatch(/18 or older/);
  });

  async function fillAndSubmit() {
    await userEvent.type(screen.getByLabelText("Email"), complete.email);
    await userEvent.type(screen.getByLabelText("Password"), complete.password);
    await userEvent.type(screen.getByLabelText("Date of birth"), complete.dateOfBirth);
    await userEvent.selectOptions(screen.getByLabelText("State of residence"), "NJ");
    await userEvent.click(screen.getByRole("checkbox"));
    await userEvent.click(screen.getByRole("button", { name: "Create account" }));
  }

  it("creates the account and continues to the casino", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(sessionEnvelope(), 201));
    render(<RegisterForm />);
    await fillAndSubmit();

    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/casino"));
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]!.body))).toEqual(complete);
  });

  it("puts the gateway's refusal on the field it concerns (blocked state)", async () => {
    fetchMock.mockResolvedValueOnce(failure("STATE_NOT_ELIGIBLE", 403));
    render(<RegisterForm />);
    await fillAndSubmit();

    expect(await screen.findByText(/isn't available in your state/)).toBeInTheDocument();
    expect(screen.getByLabelText("State of residence")).toHaveAttribute("aria-invalid", "true");
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("will not submit without the terms accepted", async () => {
    render(<RegisterForm />);
    await userEvent.type(screen.getByLabelText("Email"), complete.email);
    await userEvent.type(screen.getByLabelText("Password"), complete.password);
    await userEvent.type(screen.getByLabelText("Date of birth"), complete.dateOfBirth);
    await userEvent.selectOptions(screen.getByLabelText("State of residence"), "NJ");
    await userEvent.click(screen.getByRole("button", { name: "Create account" }));

    expect(screen.getByText(/accept the terms/)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("AuthGate", () => {
  const Casino = () => <p>casino floor</p>;

  it("renders at once with a live token — no network", async () => {
    writeAccessToken(liveToken());
    render(
      <AuthGate>
        <Casino />
      </AuthGate>,
    );
    expect(await screen.findByText("casino floor")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("restores a returning player through the refresh cookie", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ success: true, data: { accessToken: liveToken() } }));
    render(
      <AuthGate>
        <Casino />
      </AuthGate>,
    );
    expect(await screen.findByText("casino floor")).toBeInTheDocument();
    expect(pathsCalled()).toEqual(["/api/auth/refresh"]);
  });

  it("sends a signed-out player to /login with this page as ?next=, rendering nothing gated", async () => {
    fetchMock.mockResolvedValueOnce(failure("NO_REFRESH_TOKEN", 401));
    render(
      <AuthGate>
        <Casino />
      </AuthGate>,
    );
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/login?next=%2Fcasino"));
    expect(screen.queryByText("casino floor")).toBeNull();
    expect(pathsCalled()).toEqual(["/api/auth/refresh"]);
  });

  it("uses the dev mock login only when NEXT_PUBLIC_DEV_AUTO_LOGIN=1", async () => {
    vi.stubEnv("NEXT_PUBLIC_DEV_AUTO_LOGIN", "1");
    fetchMock
      .mockResolvedValueOnce(failure("NO_REFRESH_TOKEN", 401))
      .mockResolvedValueOnce(jsonResponse(sessionEnvelope()));
    render(
      <AuthGate>
        <Casino />
      </AuthGate>,
    );
    expect(await screen.findByText("casino floor")).toBeInTheDocument();
    expect(pathsCalled()).toEqual(["/api/auth/refresh", "/api/auth/mock-login"]);
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("a sign-out while inside ends signed out — even the dev login does not sign back in", async () => {
    vi.stubEnv("NEXT_PUBLIC_DEV_AUTO_LOGIN", "1");
    writeAccessToken(liveToken());
    fetchMock.mockResolvedValue(failure("NO_REFRESH_TOKEN", 401));
    render(
      <AuthGate>
        <Casino />
      </AuthGate>,
    );
    expect(await screen.findByText("casino floor")).toBeInTheDocument();

    act(() => clearAccessToken());

    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/login?next=%2Fcasino"));
    expect(pathsCalled()).toEqual(["/api/auth/refresh"]);
    expect(window.localStorage.getItem(ACCESS_TOKEN_KEY)).toBeNull();
  });
});
