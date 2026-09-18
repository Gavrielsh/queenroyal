import { getKycProvider, type KycCaseStatus, type KycDecisionEvent } from "../lib/kyc";
import { childLogger } from "../lib/logger";
import { getPrisma } from "../lib/prisma";

/**
 * KYC decision intake — the path that decides whether a player may ever redeem.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * STRICT IDEMPOTENCY, ANCHORED IN POSTGRES
 * ─────────────────────────────────────────────────────────────────────────────
 * Every real provider redelivers. Webhooks are retried on timeout, on a 5xx, and often simply
 * because the vendor's queue is at-least-once — so the same decision arrives repeatedly,
 * sometimes out of order, sometimes concurrently.
 *
 * The idempotency is therefore NOT "check the case's status and skip if it already matches".
 * That check is passed by both halves of a concurrent redelivery — each reads the old status
 * before the other writes — and both then act. Instead the provider's event id is INSERTED
 * first, into a table whose unique index Postgres enforces however the deliveries interleave.
 * A P2002 means "already processed", and the original outcome is reported back.
 *
 * Insert-before-act is the order that matters. Acting first and recording afterwards would
 * leave a crash between the two looking exactly like an unprocessed event, and the redelivery
 * would apply the decision twice. Applying a KYC decision twice is harmless in isolation —
 * it is idempotent at the row level — but the AUDIT TRAIL would show two decisions where the
 * provider made one, and a duplicated rejection is a conversation with a regulator nobody
 * wants to have with "our webhook handler was racy" as the explanation.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT A DECISION ACTUALLY CHANGES
 * ─────────────────────────────────────────────────────────────────────────────
 * `User.kycStatus`, which is the field every gate already reads: assertKycAllows (purchase and
 * SC play), the redemption policy, the AMOE policy. This service is the ONLY writer of that
 * field outside the dev-only mock-login route, which is what makes "who verified this player?"
 * answerable from the KycVerification row rather than from memory.
 *
 * It holds and moves no money. A KYC decision gates redemption; it is not a balance.
 */

export interface KycWebhookOutcome {
  handled: boolean;
  outcome: string;
}

/** Provider case status → the KycStatus stored on User. Same three values, no translation. */
const STATUS_TO_KYC: Readonly<Record<KycCaseStatus, "PENDING" | "VERIFIED" | "REJECTED">> = {
  PENDING: "PENDING",
  APPROVED: "VERIFIED",
  REJECTED: "REJECTED",
};

/**
 * Prisma's unique-constraint violation, recognised without importing the generated error class
 * — which the test fake does not construct and which would couple this service to a generated
 * namespace for one string comparison.
 */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "P2002";
}

export async function handleKycDecisionEvent(event: KycDecisionEvent, traceId?: string): Promise<KycWebhookOutcome> {
  const log = childLogger({
    trace_id: traceId,
    component: "kyc-webhook",
    provider_event_id: event.id,
    kyc_event_type: event.type,
    case_ref: event.caseRef,
  });

  // A provider that cannot supply a stable event id cannot be made idempotent by us. Refusing
  // is the honest answer: processing it would mean every redelivery applies again, and
  // pretending otherwise would put a silent duplicate-decision hole behind a 200.
  if (!event.id) {
    log.warn("kyc event without a provider event id; refused (cannot be de-duplicated)");
    return { handled: false, outcome: "missing_event_id" };
  }
  if (!event.caseRef) {
    log.warn("kyc event without a case ref; ignored");
    return { handled: false, outcome: "missing_case_ref" };
  }

  const prisma = getPrisma();
  const provider = getKycProvider();

  // ── THE IDEMPOTENCY BARRIER. Claimed BEFORE anything is applied. ──
  //
  // `outcome` is written as "received" and narrowed once the work is done, so a crash between
  // the two leaves a row that says exactly that: we saw this event and did not finish it. That
  // is more useful than no row (which would invite a duplicate apply) and more honest than a
  // row claiming an outcome that never happened.
  try {
    await prisma.kycWebhookEvent.create({
      data: {
        providerEventId: event.id,
        provider: provider.name,
        eventType: event.type,
        caseRef: event.caseRef,
        outcome: "received",
      },
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      const prior = await prisma.kycWebhookEvent.findUnique({ where: { providerEventId: event.id } });
      log.info({ prior_outcome: prior?.outcome }, "kyc event already processed; redelivery absorbed");
      return { handled: false, outcome: prior?.outcome ?? "duplicate" };
    }
    throw err;
  }

  const verification = await prisma.kycVerification.findUnique({ where: { providerCaseRef: event.caseRef } });
  if (!verification) {
    // A decision for a case this gateway never opened. Recorded, not applied: it may be a
    // misrouted webhook, a case opened by another environment sharing the provider account, or
    // an attacker with a valid signature and a guessed ref. None of those should move a status.
    await finish(event.id, "unknown_case");
    log.warn("kyc decision for an unknown case; recorded but not applied");
    return { handled: false, outcome: "unknown_case" };
  }

  // Subject guard: the event's stated subject must be the case's owner. A signed event whose
  // user_ref points at a DIFFERENT account is the one shape that could verify the wrong
  // person, and a signature proves the provider sent it — not that it is about who it claims.
  if (event.userRef && event.userRef !== verification.userId) {
    await finish(event.id, "subject_mismatch");
    log.error({ case_user: verification.userId }, "kyc decision subject mismatch; recorded but NOT applied");
    return { handled: false, outcome: "subject_mismatch" };
  }

  // A non-terminal update carries no decision. Recorded for the trail; nothing to apply.
  if (event.status === "PENDING") {
    await finish(event.id, "non_terminal");
    log.info("kyc event is non-terminal; recorded only");
    return { handled: false, outcome: "non_terminal" };
  }

  const decidedAt = event.decidedAt ?? new Date();

  // The case row and the player's status move together. A verification marked APPROVED whose
  // user is still PENDING — or the reverse — is the inconsistency every gate downstream would
  // read differently depending on which it happened to consult.
  await prisma.$transaction(async (tx) => {
    await tx.kycVerification.update({
      where: { id: verification.id },
      data: {
        status: event.status,
        decidedAt,
        ...(event.reason ? { decisionReason: event.reason } : {}),
      },
    });
    await tx.user.update({
      where: { id: verification.userId },
      data: { kycStatus: STATUS_TO_KYC[event.status] },
    });
  });

  await finish(event.id, event.status === "APPROVED" ? "approved" : "rejected");

  // The REASON is not logged at info level on a rejection. It is the provider's grounds for
  // refusing an identity — sensitive on its own, and a precise one is a free oracle for
  // somebody iterating on a forged document. It is stored on the row for an operator handling
  // an appeal, which is where it belongs.
  log.info({ decision: event.status, user_id: verification.userId }, "kyc decision applied");
  return { handled: true, outcome: event.status === "APPROVED" ? "approved" : "rejected" };
}

/** Narrow a claimed event row to its final outcome. */
async function finish(providerEventId: string, outcome: string): Promise<void> {
  await getPrisma().kycWebhookEvent.update({ where: { providerEventId }, data: { outcome } });
}
