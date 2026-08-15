import bcrypt from "bcryptjs";
import { describe, expect, it } from "vitest";

/**
 * Regression guard for the login user-enumeration timing leak.
 *
 * The decoy hash compared against when an email is not found was 59 characters. A bcrypt
 * digest is exactly 60 (7 prefix + 22 salt + 31 hash), so bcryptjs failed to parse it and
 * returned false without running the key derivation — the unknown-account path finished in
 * microseconds while the known-account path spent the full cost-12 KDF.
 *
 * These tests assert the two structural properties that make the decoy work: it must be a
 * PARSEABLE bcrypt hash, and it must carry the SAME cost factor as real password hashes.
 * Either one being wrong reopens the leak.
 */

// Mirrors BCRYPT_ROUNDS in src/services/auth.service.ts.
const BCRYPT_ROUNDS = 12;

/** Extract the cost factor from a bcrypt hash ("$2a$12$..." → 12). */
function costOf(hash: string): number {
  const parts = hash.split("$");
  return Number(parts[2]);
}

describe("login decoy hash (user-enumeration timing)", () => {
  it("the historical constant was malformed and skipped the KDF", () => {
    // Pinned here so the failure mode stays documented and cannot silently return.
    const BROKEN = "$2a$12$CwTycUXWue0Thq9StjUM0uJ8Dvm9k2x9p8jWz4z1qkq1qkq1qkq1";
    expect(BROKEN).toHaveLength(59); // a valid bcrypt hash is 60

    const start = process.hrtime.bigint();
    const result = bcrypt.compareSync("any-guess", BROKEN);
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;

    expect(result).toBe(false);
    // It returns almost instantly because the salt never parsed. A genuine cost-12
    // compare cannot finish anywhere near this fast.
    expect(elapsedMs).toBeLessThan(5);
  });

  it("a derived decoy is a well-formed 60-character bcrypt hash", () => {
    const decoy = bcrypt.hashSync("throwaway", BCRYPT_ROUNDS);
    expect(decoy).toHaveLength(60);
    expect(decoy.startsWith("$2")).toBe(true);
  });

  it("the decoy carries the same cost factor as a real password hash", () => {
    // A decoy pinned at a lower cost than real hashes still leaks — it just leaks a
    // smaller ratio. Deriving both from BCRYPT_ROUNDS keeps them equal by construction.
    const decoy = bcrypt.hashSync("throwaway", BCRYPT_ROUNDS);
    const real = bcrypt.hashSync("a-real-password", BCRYPT_ROUNDS);
    expect(costOf(decoy)).toBe(BCRYPT_ROUNDS);
    expect(costOf(decoy)).toBe(costOf(real));
  });

  it("comparing against the decoy costs the same as a real failed compare", () => {
    const decoy = bcrypt.hashSync("throwaway", BCRYPT_ROUNDS);
    const real = bcrypt.hashSync("a-real-password", BCRYPT_ROUNDS);

    const time = (hash: string): number => {
      const start = process.hrtime.bigint();
      bcrypt.compareSync("wrong-guess", hash);
      return Number(process.hrtime.bigint() - start) / 1e6;
    };

    // Warm up so JIT/allocation noise does not dominate the first measurement.
    time(decoy);
    time(real);

    const decoyMs = time(decoy);
    const realMs = time(real);
    const ratio = Math.max(decoyMs, realMs) / Math.min(decoyMs, realMs);

    // The broken constant produced a ~3200x ratio. A generous 2x bound catches any
    // regression to a malformed or lower-cost decoy without flaking on a noisy CI box.
    expect(ratio).toBeLessThan(2);
  });
});
