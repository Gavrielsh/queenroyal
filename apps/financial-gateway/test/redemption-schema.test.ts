import { describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";

/**
 * Schema invariants for the money-OUT model.
 *
 * These assert on the generated Prisma DMMF rather than on behaviour, because what B1
 * introduces IS a shape — and the two ways that shape can silently rot are exactly the two
 * things this file pins:
 *
 *   1. a balance field appearing on a Zone 2 model, which would break the architecture's
 *      central invariant without breaking a single test that exercises the code, and
 *   2. `amount` drifting to a numeric type, which would hand this zone the ability to do
 *      arithmetic on money and make the float ban unenforceable by review alone.
 *
 * A comment saying "no balances here" does not fail a build. This does.
 */

const model = Prisma.dmmf.datamodel.models.find((m) => m.name === "RedemptionRequest");
const statusEnum = Prisma.dmmf.datamodel.enums.find((e) => e.name === "RedemptionStatus");

describe("RedemptionRequest schema", () => {
  it("exists and maps to redemption_requests", () => {
    expect(model).toBeDefined();
    expect(model?.dbName).toBe("redemption_requests");
  });

  it("carries the approved lifecycle, in pipeline order and with nothing extra", () => {
    expect(statusEnum?.values.map((v) => v.name)).toEqual([
      "REQUESTED",
      "UNDER_REVIEW",
      "APPROVED",
      "PROCESSING",
      "PAID",
      "REJECTED",
      "CANCELLED_BY_PLAYER",
    ]);
  });

  it("starts a new request at REQUESTED", () => {
    const status = model?.fields.find((f) => f.name === "status");
    expect(status?.type).toBe("RedemptionStatus");
    expect(status?.default).toBe("REQUESTED");
  });

  it("holds the amount as a decimal String — never Decimal, Float or Int", () => {
    const amount = model?.fields.find((f) => f.name === "amount");
    expect(amount?.type).toBe("String");
    expect(amount?.isRequired).toBe(true);
  });

  it("links to the Zone 1 ledger by a single nullable, UNIQUE transaction id", () => {
    const ledger = model?.fields.find((f) => f.name === "ledgerTransactionId");
    expect(ledger?.type).toBe("String");
    // Nullable: no ledger row exists until the engine debit commits.
    expect(ledger?.isRequired).toBe(false);
    // UNIQUE: one ledger transaction can back at most one redemption, so paying a single
    // debit twice is not representable.
    expect(ledger?.isUnique).toBe(true);
  });

  it("anchors the engine call on a UNIQUE deterministic idempotency key", () => {
    const anchor = model?.fields.find((f) => f.name === "operatorTransactionId");
    expect(anchor?.isRequired).toBe(true);
    expect(anchor?.isUnique).toBe(true);
  });

  it("stores no financial state — no balance, and no numeric money field anywhere", () => {
    const forbidden = /(balance|gc_?balance|sc_?balance|wallet|credits?|funds|totalWon|available)/i;
    const offenders = (model?.fields ?? []).filter((f) => forbidden.test(f.name));
    expect(offenders.map((f) => f.name)).toEqual([]);

    // Belt and braces: NOTHING on this model may be a numeric type that could hold money.
    // `Int`/`Float`/`Decimal` are all absent by construction — the only scalars here are
    // String, Boolean-free, DateTime and the status enum.
    const numeric = (model?.fields ?? []).filter((f) => ["Int", "Float", "Decimal", "BigInt"].includes(f.type));
    expect(numeric.map((f) => f.name)).toEqual([]);
  });
});

describe("Zone 2 zero-financial-state invariant", () => {
  it("holds across every model in the schema", () => {
    // Deliberately broad: any field whose name mentions a balance at all. A false positive
    // here costs one conversation; a false negative costs the architecture.
    const forbidden = /balance/i;
    const offenders = Prisma.dmmf.datamodel.models.flatMap((m) =>
      m.fields.filter((f) => forbidden.test(f.name)).map((f) => `${m.name}.${f.name}`),
    );
    expect(offenders).toEqual([]);
  });
});
