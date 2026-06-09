/**
 * Programmable `fetch` mock standing in for the True Engine HTTP API. Each test installs
 * a handler that maps an outbound call (path + body) to an engine response, a timeout, or
 * a network error — letting us simulate ghost spins, terminal rejections, and dropped
 * connections deterministically. Every call is recorded for assertions.
 */

export type Directive =
  | { ok: boolean; status: number; body: unknown }
  | { throwKind: "timeout" | "network" };

export interface EngineCall {
  path: string;
  method: string;
  headers: Record<string, string>;
  body: any;
}

export const engineCalls: EngineCall[] = [];

const NO_HANDLER: Directive = { ok: false, status: 500, body: { code: "NO_HANDLER", message: "no engine handler set" } };
let handler: (call: EngineCall) => Directive = () => NO_HANDLER;

export function setEngineHandler(h: (call: EngineCall) => Directive): void {
  handler = h;
}

export function resetEngine(): void {
  engineCalls.length = 0;
  handler = () => NO_HANDLER;
}

// Install the mock onto the global fetch used by TrueEngineClient.
global.fetch = (async (input: any, init: any = {}) => {
  const url = typeof input === "string" ? input : input.url;
  const call: EngineCall = {
    path: new URL(url).pathname,
    method: init.method ?? "GET",
    headers: (init.headers ?? {}) as Record<string, string>,
    body: init.body ? JSON.parse(init.body) : undefined,
  };
  engineCalls.push(call);

  const directive = handler(call);
  if ("throwKind" in directive) {
    if (directive.throwKind === "timeout") {
      throw Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
    }
    throw new Error("ECONNRESET");
  }
  return {
    ok: directive.ok,
    status: directive.status,
    text: async () => JSON.stringify(directive.body),
  };
}) as unknown as typeof fetch;
