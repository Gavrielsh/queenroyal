import { createHmac, randomUUID } from "node:crypto";

import { getEnv } from "../config/env";
import type {
  BetPayload,
  CreatePlayerPayload,
  CreatePlayerResult,
  EngineSuccessEnvelope,
  EngineTxResult,
  PurchasePayload,
  RollbackPayload,
  TrueEngineErrorBody,
  TrueEngineResult,
  WinPayload,
} from "../types/true-engine";

/**
 * TrueEngineClient — the signed bridge between this gateway and the Go ledger.
 *
 * Outbound zero-trust contract (every `/api/v1/*` call — see internal/api/hmac.go, replay.go):
 *   1. Serialize the payload exactly once and sign those exact bytes with
 *      HMAC-SHA256(rawBody, ENGINE_SECRET_KEY) → `X-Signature` (hex).
 *   2. `X-Operator-Code` selects our per-operator secret on the engine side.
 *   3. `X-Timestamp` (unix seconds) + a fresh `X-Nonce` (UUID) satisfy the engine's
 *      ReplayGuard. The nonce is fresh per physical attempt; the idempotency anchor
 *      (`operator_transaction_id`, in the body) stays stable across retries.
 *   4. Never throw for HTTP / transport failures — return a discriminated `TrueEngineResult`
 *      so the route layer can fail gracefully.
 *
 * The engine recomputes the HMAC over the RAW request body bytes, so we sign and send the
 * identical string (no re-serialization).
 */

const ENGINE_ENDPOINTS = {
  bet: "/api/v1/bet",
  win: "/api/v1/win",
  rollback: "/api/v1/rollback",
  purchase: "/api/v1/store/purchase",
  createPlayer: "/api/v1/player/create",
} as const;

export class TrueEngineClient {
  private readonly baseUrl: string;
  private readonly secret: string;
  private readonly operatorCode: string;
  private readonly timeoutMs: number;

  constructor(opts?: { baseUrl?: string; secret?: string; operatorCode?: string; timeoutMs?: number }) {
    const env = getEnv();
    this.baseUrl = (opts?.baseUrl ?? env.ENGINE_BASE_URL).replace(/\/+$/, "");
    this.secret = opts?.secret ?? env.ENGINE_SECRET_KEY;
    this.operatorCode = opts?.operatorCode ?? env.ENGINE_OPERATOR_CODE;
    this.timeoutMs = opts?.timeoutMs ?? env.ENGINE_TIMEOUT_MS;
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /** Debit a wager. `operator_transaction_id` must be a stable, deterministic key. */
  sendBet(payload: BetPayload): Promise<TrueEngineResult<EngineTxResult>> {
    return this.postTx(ENGINE_ENDPOINTS.bet, payload);
  }

  /** Credit a win, optionally linked to the bet's `ledger_transaction_id`. */
  sendWin(payload: WinPayload): Promise<TrueEngineResult<EngineTxResult>> {
    return this.postTx(ENGINE_ENDPOINTS.win, payload);
  }

  /** Issue purchased coins (GC + optional SC_UNPLAYED promo) after a fiat charge. */
  sendPurchase(payload: PurchasePayload): Promise<TrueEngineResult<EngineTxResult>> {
    return this.postTx(ENGINE_ENDPOINTS.purchase, payload);
  }

  /** Reverse a previously-committed BET by its ledger transaction id. */
  sendRollback(payload: RollbackPayload): Promise<TrueEngineResult<EngineTxResult>> {
    return this.postTx(ENGINE_ENDPOINTS.rollback, payload);
  }

  /**
   * Provision a player. Idempotent on `external_id` (a repeat returns the existing player
   * with `created=false`). The response is flat (not wrapped in `result`).
   */
  async createPlayer(payload: CreatePlayerPayload): Promise<TrueEngineResult<CreatePlayerResult>> {
    return this.post<CreatePlayerResult>(ENGINE_ENDPOINTS.createPlayer, payload);
  }

  // ── Internals ─────────────────────────────────────────────────────────────────

  /** Post a tx-style call and unwrap the `{ code, result }` envelope to `result`. */
  private async postTx(path: string, payload: object): Promise<TrueEngineResult<EngineTxResult>> {
    const res = await this.post<EngineSuccessEnvelope<EngineTxResult>>(path, payload);
    if (!res.ok) return res;
    return { ok: true, status: res.status, data: res.data.result };
  }

  /** HMAC-SHA256 of the exact serialized body, hex-encoded. */
  private sign(rawBody: string): string {
    return createHmac("sha256", this.secret).update(rawBody, "utf8").digest("hex");
  }

  /**
   * Signed POST. Serializes once, signs those bytes, sends that exact string with the full
   * four-header zero-trust set. Converts every failure mode (4xx/5xx, timeout, network) into
   * a typed result.
   */
  private async post<T>(path: string, payload: object): Promise<TrueEngineResult<T>> {
    const rawBody = JSON.stringify(payload); // serialize ONCE; sign & send identical bytes
    const signature = this.sign(rawBody);
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const nonce = randomUUID();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Operator-Code": this.operatorCode,
          "X-Signature": signature,
          "X-Timestamp": timestamp,
          "X-Nonce": nonce,
        },
        body: rawBody,
        signal: controller.signal,
      });

      const text = await res.text();
      const parsed = text ? safeJsonParse(text) : null;

      if (!res.ok) {
        return {
          ok: false,
          status: res.status,
          retryable: isRetryableStatus(res.status),
          error: normalizeEngineError(res.status, parsed),
        };
      }
      return { ok: true, status: res.status, data: (parsed ?? {}) as T };
    } catch (err) {
      const isAbort = err instanceof Error && err.name === "AbortError";
      return {
        ok: false,
        status: 0,
        retryable: true, // timeouts / network errors are safe to retry with the same key
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

/**
 * Engine status → retry policy (internal/api/errors.go): 409 (pending/conflict) and 5xx are
 * safely retryable with the same operator_transaction_id; 4xx are terminal.
 */
function isRetryableStatus(status: number): boolean {
  return status === 409 || status >= 500;
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

/** Map an engine error body into a stable, frontend-safe error shape. */
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
      trace_id: typeof obj.trace_id === "string" ? obj.trace_id : undefined,
      details: obj.details ?? undefined,
    };
  }
  return fallback;
}

const STATUS_FALLBACK: Record<number, TrueEngineErrorBody> = {
  400: { code: "LEDGER_REJECTED", message: "The ledger rejected the transaction (e.g. insufficient funds)" },
  401: { code: "AUTHENTICATION_FAILED", message: "True Engine rejected the request credentials" },
  403: { code: "PLAYER_NOT_ACTIVE", message: "Player is not allowed to transact" },
  404: { code: "NOT_FOUND", message: "Player or transaction not found" },
  409: { code: "TRANSACTION_CONFLICT", message: "Duplicate or concurrent transaction (retryable)" },
  422: { code: "LEDGER_VALIDATION_ERROR", message: "True Engine rejected the payload" },
  500: { code: "ENGINE_INTERNAL_ERROR", message: "True Engine internal error" },
  503: { code: "ENGINE_UNAVAILABLE", message: "True Engine temporarily unavailable" },
};

/** Lazy process-wide singleton. */
let engineClient: TrueEngineClient | null = null;
export function trueEngine(): TrueEngineClient {
  if (!engineClient) engineClient = new TrueEngineClient();
  return engineClient;
}
