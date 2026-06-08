import { getEnv } from "@/lib/env";
import { log } from "@/lib/logger";

/**
 * A minimal, dependency-free circuit breaker.
 *
 * The problem it solves (Phase 2): when Redis goes down, every Redis-backed call would
 * otherwise block on the driver's per-request retries before failing. Applied to a
 * fail-closed gateway that means a dead Redis stalls — and then 503s — EVERY route,
 * including health checks and non-financial paths. The breaker detects the outage after a
 * few failures and then FAILS FAST (no waiting), so callers can make an instant policy
 * decision: financial paths reject (503), non-financial paths degrade and stay alive.
 *
 * States:
 *   closed     → calls flow; consecutive failures are counted.
 *   open       → calls are rejected immediately ({@link CircuitOpenError}) until cooldown.
 *   half_open  → after cooldown, a single trial is allowed; success closes, failure re-opens.
 */

export type CircuitState = "closed" | "open" | "half_open";

export class CircuitOpenError extends Error {
  constructor(public readonly circuit: string) {
    super(`circuit "${circuit}" is open`);
    this.name = "CircuitOpenError";
  }
}

export interface CircuitBreakerOptions {
  /** Consecutive failures (while closed) that trip the breaker open. */
  failureThreshold: number;
  /** How long to stay open before allowing a half-open trial. */
  cooldownMs: number;
  /** Successful half-open trials required to close again. */
  successThreshold: number;
}

export interface CircuitSnapshot {
  name: string;
  state: CircuitState;
  failures: number;
  openedAt: number | null;
}

export class CircuitBreaker {
  private state: CircuitState = "closed";
  private failures = 0;
  private successes = 0;
  private openedAt = 0;

  constructor(
    private readonly name: string,
    private readonly opts: CircuitBreakerOptions,
  ) {}

  /** Non-mutating-ish view of the breaker (advances out of `open` if cooldown elapsed). */
  snapshot(): CircuitSnapshot {
    this.refresh();
    return {
      name: this.name,
      state: this.state,
      failures: this.failures,
      openedAt: this.state === "open" ? this.openedAt : null,
    };
  }

  /** True iff a call would be permitted right now (closed, or a half-open trial). */
  get allowsRequest(): boolean {
    this.refresh();
    return this.state !== "open";
  }

  /**
   * Run `fn` under the breaker. Throws {@link CircuitOpenError} immediately when open
   * (fail fast); otherwise records the outcome and re-throws any error from `fn`.
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    this.refresh();
    if (this.state === "open") {
      throw new CircuitOpenError(this.name);
    }
    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure();
      throw err;
    }
  }

  private refresh(): void {
    if (this.state === "open" && Date.now() - this.openedAt >= this.opts.cooldownMs) {
      this.state = "half_open";
      this.successes = 0;
    }
  }

  private onSuccess(): void {
    if (this.state === "half_open") {
      this.successes += 1;
      if (this.successes >= this.opts.successThreshold) this.close();
      return;
    }
    this.failures = 0;
  }

  private onFailure(): void {
    if (this.state === "half_open") {
      this.open();
      return;
    }
    this.failures += 1;
    if (this.failures >= this.opts.failureThreshold) this.open();
  }

  private open(): void {
    if (this.state !== "open") {
      log().warn({ circuit: this.name, failures: this.failures }, "circuit breaker opened (failing fast)");
    }
    this.state = "open";
    this.openedAt = Date.now();
  }

  private close(): void {
    if (this.state !== "closed") {
      log().info({ circuit: this.name }, "circuit breaker closed (recovered)");
    }
    this.state = "closed";
    this.failures = 0;
    this.successes = 0;
  }
}

/**
 * Process-wide breaker shared by ALL Redis interactions (rate limiting, replay nonces,
 * refresh sessions). One shared instance means a single outage is observed consistently:
 * financial callers reject, non-financial callers degrade, and /api/health can report it.
 */
let redisBreaker: CircuitBreaker | null = null;

export function redisCircuitBreaker(): CircuitBreaker {
  if (redisBreaker) return redisBreaker;
  const env = getEnv();
  redisBreaker = new CircuitBreaker("redis", {
    failureThreshold: env.REDIS_CB_FAILURE_THRESHOLD,
    cooldownMs: env.REDIS_CB_COOLDOWN_MS,
    successThreshold: 1,
  });
  return redisBreaker;
}

/** Run a Redis operation under the shared Redis breaker. */
export function withRedisBreaker<T>(fn: () => Promise<T>): Promise<T> {
  return redisCircuitBreaker().execute(fn);
}

/** Test seam: drop the shared breaker so each suite starts from a clean (closed) state. */
export function __resetRedisCircuitBreaker(): void {
  redisBreaker = null;
}
