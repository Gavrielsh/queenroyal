import { createHmac, randomUUID } from "node:crypto";

import { getEnv } from "@/lib/env";
import type {
  BetPayload,
  DepositPayload,
  EngineTxResult,
  TrueEngineErrorBody,
  TrueEngineResult,
  WinPayload,
} from "@/types/true-engine";

/**
 * TrueEngineClient — the signed bridge between this Gateway and the Go ledger.
 *
 * Responsibilities (Zero-Trust + Idempotency, per ARCHITECTURE.md):
 *   1. Serialize the payload exactly once and sign those exact bytes with
 *      HMAC-SHA256(rawBody, ENGINE_SECRET_KEY) → `X-Signature`.
 *   2. Attach an `X-Idempotency-Key` (UUID v4), auto-generated if not supplied.
 *   3. Never throw for HTTP / transport failures — return a discriminated
 *      `TrueEngineResult` so the route layer can fail gracefully.
 *
 * NOTE for the engine side: it must recompute the HMAC over the RAW request body
 * bytes (not a re-serialized object) for the signature to match.
 */

const ENGINE_ENDPOINTS = {
  bet: "/v1/ledger/bet",
  win: "/v1/ledger/win",
  deposit: "/v1/ledger/deposit",
} as const;

export class TrueEngineClient {
  private readonly baseUrl: string;
  private readonly secret: string;
  private readonly timeoutMs: number;

  constructor(opts?: { baseUrl?: string; secret?: string; timeoutMs?: number }) {
    const env = getEnv();
    this.baseUrl = (opts?.baseUrl ?? env.ENGINE_BASE_URL).replace(/\/+$/, "");
    this.secret = opts?.secret ?? env.ENGINE_SECRET_KEY;
    this.timeoutMs = opts?.timeoutMs ?? env.ENGINE_TIMEOUT_MS;
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /** Debit a wager. Idempotency key defaults to the payload's `transaction_id`. */
  sendBet(payload: BetPayload, idempotencyKey?: string): Promise<TrueEngineResult<EngineTxResult>> {
    return this.post<EngineTxResult>(
      ENGINE_ENDPOINTS.bet,
      payload,
      idempotencyKey ?? payload.transaction_id,
    );
  }

  /** Credit a win. Idempotency key defaults to the payload's `transaction_id`. */
  sendWin(payload: WinPayload, idempotencyKey?: string): Promise<TrueEngineResult<EngineTxResult>> {
    return this.post<EngineTxResult>(
      ENGINE_ENDPOINTS.win,
      payload,
      idempotencyKey ?? payload.transaction_id,
    );
  }

  /** Credit purchased coins after a confirmed fiat charge. */
  sendDeposit(
    payload: DepositPayload,
    idempotencyKey?: string,
  ): Promise<TrueEngineResult<EngineTxResult>> {
    return this.post<EngineTxResult>(
      ENGINE_ENDPOINTS.deposit,
      payload,
      idempotencyKey ?? payload.transaction_id,
    );
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  /** HMAC-SHA256 of the exact serialized body, hex-encoded. */
  private sign(rawBody: string): string {
    return createHmac("sha256", this.secret).update(rawBody, "utf8").digest("hex");
  }

  /**
   * Signed POST. Serializes once, signs those bytes, sends that exact string.
   * Converts every failure mode (4xx/5xx, timeout, network) into a typed result.
   */
  private async post<T>(
    path: string,
    payload: object,
    idempotencyKey?: string,
  ): Promise<TrueEngineResult<T>> {
    const rawBody = JSON.stringify(payload); // serialize ONCE; sign & send identical bytes
    const signature = this.sign(rawBody);
    const key = idempotencyKey ?? randomUUID();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Signature": signature,
          "X-Idempotency-Key": key,
        },
        body: rawBody,
        signal: controller.signal,
        cache: "no-store",
      });

      const text = await res.text();
      const parsed = text ? safeJsonParse(text) : null;

      if (!res.ok) {
        return { ok: false, status: res.status, error: normalizeEngineError(res.status, parsed) };
      }
      return { ok: true, status: res.status, data: (parsed ?? {}) as T };
    } catch (err) {
      const isAbort = err instanceof Error && err.name === "AbortError";
      return {
        ok: false,
        status: 0,
        error: {
          code: isAbort ? "ENGINE_TIMEOUT" : "ENGINE_UNREACHABLE",
          message: isAbort
            ? `True Engine did not respond within ${this.timeoutMs}ms`
            : "Failed to reach the True Engine",
          details: err instanceof Error ? err.message : String(err),
        },
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

/** Map an engine HTTP status + body into a stable, frontend-safe error shape. */
function normalizeEngineError(status: number, parsed: unknown): TrueEngineErrorBody {
  const fallback = STATUS_FALLBACK[status] ?? {
    code: "ENGINE_ERROR",
    message: "True Engine returned an error",
  };

  if (parsed && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;
    return {
      code: typeof obj.code === "string" ? obj.code : fallback.code,
      message: typeof obj.message === "string" ? obj.message : fallback.message,
      details: obj.details ?? obj.error ?? undefined,
    };
  }
  return fallback;
}

const STATUS_FALLBACK: Record<number, TrueEngineErrorBody> = {
  400: { code: "LEDGER_REJECTED", message: "The ledger rejected the transaction (e.g. insufficient funds)" },
  401: { code: "UNAUTHORIZED_SIGNATURE", message: "True Engine rejected the HMAC signature" },
  404: { code: "ENGINE_ROUTE_NOT_FOUND", message: "True Engine endpoint not found" },
  409: { code: "IDEMPOTENCY_CONFLICT", message: "A transaction with this idempotency key already exists" },
  422: { code: "LEDGER_VALIDATION_ERROR", message: "True Engine rejected the payload" },
  500: { code: "ENGINE_INTERNAL_ERROR", message: "True Engine internal error" },
  503: { code: "ENGINE_UNAVAILABLE", message: "True Engine temporarily unavailable" },
};

/** Lazy process-wide singleton. */
let _client: TrueEngineClient | null = null;
export function trueEngine(): TrueEngineClient {
  if (!_client) _client = new TrueEngineClient();
  return _client;
}
