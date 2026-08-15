import { isIP } from "node:net";

import { getEnv } from "../config/env";

/**
 * Jurisdiction enforcement at the PLAYER perimeter.
 *
 * WHY THIS EXISTS SEPARATELY FROM THE ENGINE'S FENCE:
 *
 *   The engine is called server-to-server, so the socket peer it sees is this
 *   gateway's datacenter address — never a player's. Its fence is a backstop
 *   that only works when a trusted upstream forwards a client IP. THIS is the
 *   layer where a player's connection actually terminates, so this is where
 *   jurisdiction enforcement has to be correct.
 *
 * FAIL CLOSED: a request whose region cannot be positively established is
 * rejected. A jurisdiction control that admits on error is not a control.
 *
 * REGION SOURCE: we do not ship a GeoIP database here. Production edges
 * (Cloudflare, CloudFront, Fastly) all resolve geography and forward it as
 * headers, which is both cheaper and more accurate than a bundled database.
 * Those headers are honoured ONLY when the socket peer is a configured
 * trusted proxy — otherwise a player could simply set them and choose their
 * own jurisdiction.
 */

export class GeoBlockedError extends Error {
  readonly code = "GEO_BLOCKED";
  readonly status = 403;
  constructor(
    /** Machine-readable reason for logs/metrics. NEVER sent to the caller. */
    readonly reason: string,
  ) {
    super("service not available in your region");
    this.name = "GeoBlockedError";
  }
}

/** A parsed CIDR or single-address trusted-proxy entry. */
interface CidrBlock {
  base: bigint;
  mask: bigint;
  bits: number;
}

/** Convert a dotted/colon IP literal to a bigint for prefix comparison. */
function ipToBigInt(ip: string): { value: bigint; bits: number } | null {
  const kind = isIP(ip);
  if (kind === 4) {
    const parts = ip.split(".").map((p) => Number(p));
    if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return null;
    let v = 0n;
    for (const p of parts) v = (v << 8n) | BigInt(p);
    return { value: v, bits: 32 };
  }
  if (kind === 6) {
    // Expand "::" and normalise to 8 groups.
    const [head, tail] = ip.split("::");
    const headGroups = head ? head.split(":").filter(Boolean) : [];
    const tailGroups = tail ? tail.split(":").filter(Boolean) : [];
    const fill = 8 - headGroups.length - tailGroups.length;
    if (fill < 0) return null;
    const groups = [...headGroups, ...Array<string>(ip.includes("::") ? fill : 0).fill("0"), ...tailGroups];
    if (groups.length !== 8) return null;
    let v = 0n;
    for (const g of groups) {
      const n = Number.parseInt(g, 16);
      if (!Number.isInteger(n) || n < 0 || n > 0xffff) return null;
      v = (v << 16n) | BigInt(n);
    }
    return { value: v, bits: 128 };
  }
  return null;
}

/**
 * Parse TRUSTED_PROXIES entries. Accepts CIDRs ("10.0.0.0/8") and bare IPs.
 * A malformed entry THROWS — silently dropping one would leave the geo
 * headers trusted from an unintended network.
 */
export function parseTrustedProxies(entries: readonly string[]): CidrBlock[] {
  const out: CidrBlock[] = [];
  for (const raw of entries) {
    const e = raw.trim();
    if (e === "") continue;

    const [addr, prefixRaw] = e.split("/");
    const parsed = ipToBigInt(addr ?? "");
    if (!parsed) throw new Error(`TRUSTED_PROXIES entry ${JSON.stringify(e)} is not a valid IP or CIDR`);

    const prefix = prefixRaw === undefined ? parsed.bits : Number(prefixRaw);
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > parsed.bits) {
      throw new Error(`TRUSTED_PROXIES entry ${JSON.stringify(e)} has an invalid prefix length`);
    }
    const hostBits = BigInt(parsed.bits - prefix);
    const mask = hostBits === 0n ? (1n << BigInt(parsed.bits)) - 1n : ~((1n << hostBits) - 1n);
    out.push({ base: parsed.value & mask, mask, bits: parsed.bits });
  }
  return out;
}

function isTrusted(ip: string, blocks: readonly CidrBlock[]): boolean {
  const parsed = ipToBigInt(ip);
  if (!parsed) return false;
  return blocks.some((b) => b.bits === parsed.bits && (parsed.value & b.mask) === b.base);
}

/**
 * Resolve the client address.
 *
 * The socket peer is authoritative unless it is a trusted proxy. Only then is
 * X-Forwarded-For consulted, walked RIGHT-TO-LEFT past known proxies — each
 * hop appends what it saw, so anything a client prepends itself sits to the
 * left of the real entry and is correctly ignored.
 *
 * Returns null (→ 403) rather than a best guess when the chain is unresolvable.
 */
export function resolveClientIp(
  socketIp: string | undefined,
  forwardedFor: string | undefined,
  trusted: readonly CidrBlock[],
): string | null {
  if (!socketIp || !isIP(socketIp)) return null;

  if (!isTrusted(socketIp, trusted)) {
    // Direct connection, or a hop we do not control: the peer IS the client
    // and the forwarded header is untrusted noise.
    return socketIp;
  }

  const chain = (forwardedFor ?? "").split(",").map((p) => p.trim()).filter(Boolean);
  if (chain.length === 0) {
    // A trusted proxy that forwarded nothing: we know the hop, not the client.
    return null;
  }
  for (let i = chain.length - 1; i >= 0; i--) {
    const hop = chain[i] as string;
    if (!isIP(hop)) return null; // malformed chain — do not guess
    if (!isTrusted(hop, trusted)) return hop;
  }
  return null; // every hop was ours
}

export interface GeoDecisionInput {
  socketIp: string | undefined;
  header: (name: string) => string | undefined;
}

/** Immutable, boot-time geo policy. */
export interface GeoPolicy {
  enabled: boolean;
  blocked: ReadonlySet<string>;
  trusted: CidrBlock[];
  countryHeader: string;
  regionHeader: string;
}

let cached: GeoPolicy | null = null;

export function getGeoPolicy(): GeoPolicy {
  if (cached) return cached;
  const env = getEnv();
  cached = {
    enabled: !env.GEO_ENFORCEMENT_DISABLED,
    blocked: new Set(env.BLOCKED_REGIONS.map((r) => r.toUpperCase())),
    trusted: parseTrustedProxies(env.TRUSTED_PROXIES),
    countryHeader: env.GEO_COUNTRY_HEADER.toLowerCase(),
    regionHeader: env.GEO_REGION_HEADER.toLowerCase(),
  };
  return cached;
}

/** Test-support: drop the memoized policy so a suite can re-read env. */
export function resetGeoPolicyForTests(): void {
  cached = null;
}

/**
 * Decide whether a request may proceed. Throws {@link GeoBlockedError} on any
 * outcome that is not a positively-permitted region.
 *
 * The thrown error carries a machine-readable `reason` for logs, but every
 * rejection presents the SAME opaque message and status to the caller — a
 * player must not be able to distinguish "you are in Washington" from "we
 * could not geolocate you", which would turn the fence into a probing oracle.
 */
export function assertGeoAllowed(input: GeoDecisionInput, policy: GeoPolicy = getGeoPolicy()): void {
  if (!policy.enabled) return;

  const clientIp = resolveClientIp(input.socketIp, input.header("x-forwarded-for"), policy.trusted);
  if (!clientIp) throw new GeoBlockedError("no_client_ip");

  // Geo headers are only meaningful when they came through a trusted edge.
  // If the peer is not a trusted proxy, the player could have set them.
  const viaTrustedEdge = isTrusted(input.socketIp ?? "", policy.trusted);
  if (!viaTrustedEdge) throw new GeoBlockedError("no_trusted_edge");

  const country = (input.header(policy.countryHeader) ?? "").trim().toUpperCase();
  const region = (input.header(policy.regionHeader) ?? "").trim().toUpperCase();
  if (!country || !region) {
    // The edge could not resolve a subdivision — routine for mobile/CGNAT and
    // exactly the case that used to be admitted silently.
    throw new GeoBlockedError("region_unknown");
  }

  const iso = `${country}-${region}`;
  if (policy.blocked.has(iso)) throw new GeoBlockedError("blocked_region");
}
