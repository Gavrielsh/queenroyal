/**
 * Minimal in-memory ioredis fake covering exactly the commands the gateway uses:
 * incr/expire/ttl (rate limiting), set (with EX/PX + NX) / get / del (nonces & sessions),
 * and ping. TTLs are honored against `Date.now()` so window/expiry behavior is realistic.
 *
 * Inject it by mocking `@/lib/redis`:
 *   vi.mock("@/lib/redis", async () => {
 *     const mod = await import("./fakes/redis.fake");
 *     return { getRedis: () => mod.redisFake };
 *   });
 */

interface Entry {
  value: string;
  expireAtMs: number | null;
}

class RedisFake {
  private readonly store = new Map<string, Entry>();

  private live(key: string): Entry | undefined {
    const e = this.store.get(key);
    if (!e) return undefined;
    if (e.expireAtMs !== null && e.expireAtMs <= Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    return e;
  }

  async incr(key: string): Promise<number> {
    const e = this.live(key);
    const next = (e ? Number.parseInt(e.value, 10) : 0) + 1;
    this.store.set(key, { value: String(next), expireAtMs: e?.expireAtMs ?? null });
    return next;
  }

  async expire(key: string, seconds: number): Promise<number> {
    const e = this.live(key);
    if (!e) return 0;
    e.expireAtMs = Date.now() + seconds * 1000;
    return 1;
  }

  async ttl(key: string): Promise<number> {
    const e = this.live(key);
    if (!e) return -2;
    if (e.expireAtMs === null) return -1;
    return Math.ceil((e.expireAtMs - Date.now()) / 1000);
  }

  async set(key: string, value: string, ...args: Array<string | number>): Promise<"OK" | null> {
    let nx = false;
    let ttlMs: number | null = null;
    for (let i = 0; i < args.length; i++) {
      const token = String(args[i]).toUpperCase();
      if (token === "NX") nx = true;
      else if (token === "EX") ttlMs = Number(args[++i]) * 1000;
      else if (token === "PX") ttlMs = Number(args[++i]);
    }
    if (nx && this.live(key)) return null;
    this.store.set(key, { value: String(value), expireAtMs: ttlMs !== null ? Date.now() + ttlMs : null });
    return "OK";
  }

  async get(key: string): Promise<string | null> {
    return this.live(key)?.value ?? null;
  }

  async del(...keys: string[]): Promise<number> {
    let removed = 0;
    for (const k of keys) if (this.store.delete(k)) removed += 1;
    return removed;
  }

  async ping(): Promise<string> {
    return "PONG";
  }

  // Test helper.
  flushall(): void {
    this.store.clear();
  }
}

export const redisFake = new RedisFake();
