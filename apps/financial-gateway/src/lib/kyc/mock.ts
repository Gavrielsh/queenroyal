import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

import {
  isKycDocumentType,
  type KycCaseSnapshot,
  type KycCaseStatus,
  type KycDecisionEvent,
  type KycProvider,
  KycProviderError,
  type KycUploadRequest,
  type KycUploadTicket,
  KycWebhookSignatureError,
} from "./types";

/**
 * In-memory KYC provider for development and tests.
 *
 * A real implementation of the contract, not a stub that says yes: it holds cases, enforces
 * one open case per subject, refuses an unknown document type, issues expiring upload tickets,
 * and verifies an HMAC-SHA256 webhook signature in constant time exactly as a real vendor
 * would. The point of a mock at a security seam is that the seam is exercised — a
 * `parseWebhook` that returned the body unchecked would let every signature test pass against
 * a provider that has no signature check.
 *
 * FORBIDDEN IN PRODUCTION (see index.ts). A provider that approves whoever asks would mark
 * players verified who were never identified, and KYC status is the gate on redeeming real
 * prizes and on the AML controls behind it.
 *
 * NOTE: the Maps below are this mock PROVIDER's own case store (dev/test only) — they are not
 * the gateway's idempotency state, which is in Postgres and survives a restart. A real vendor
 * holds this remotely.
 */

const HEX_RE = /^[0-9a-fA-F]+$/;

/** How long a presigned upload stays valid. Short by contract — see KycUploadTicket. */
export const MOCK_UPLOAD_TTL_MS = 15 * 60 * 1000;

interface MockWebhookBody {
  id?: string;
  type?: string;
  case_ref?: string;
  user_ref?: string;
  status?: string;
  reason?: string;
  decided_at?: string;
}

function isCaseStatus(v: unknown): v is KycCaseStatus {
  return v === "PENDING" || v === "APPROVED" || v === "REJECTED";
}

export class MockKycProvider implements KycProvider {
  readonly name = "mock";

  private readonly cases = new Map<string, KycCaseSnapshot>();
  private readonly casesByUser = new Map<string, string>();
  private readonly uploads = new Map<string, KycUploadTicket & { caseRef: string }>();

  constructor(private readonly webhookSecret: string = "mock-kyc-webhook-secret") {}

  async createCase(userRef: string): Promise<KycCaseSnapshot> {
    // ONE OPEN CASE PER SUBJECT. Two concurrent cases for one person produce two decisions
    // that can disagree, and there is no principled way to pick a winner after the fact.
    const existingRef = this.casesByUser.get(userRef);
    if (existingRef) {
      const existing = this.cases.get(existingRef);
      if (existing && existing.status === "PENDING") return { ...existing };
    }

    const snapshot: KycCaseSnapshot = {
      caseRef: `kyc_case_${randomUUID()}`,
      userRef,
      status: "PENDING",
    };
    this.cases.set(snapshot.caseRef, snapshot);
    this.casesByUser.set(userRef, snapshot.caseRef);
    return { ...snapshot };
  }

  async createDocumentUpload(req: KycUploadRequest): Promise<KycUploadTicket> {
    const kase = this.cases.get(req.caseRef);
    if (!kase) {
      throw new KycProviderError("KYC_CASE_NOT_FOUND", `unknown case ${req.caseRef}`);
    }
    if (kase.userRef !== req.userRef) {
      // A ticket issued against someone else's case would let one account attach documents to
      // another's verification. Refused at the provider as well as the service.
      throw new KycProviderError("KYC_CASE_SUBJECT_MISMATCH", "case does not belong to this subject");
    }
    if (!isKycDocumentType(req.documentType)) {
      throw new KycProviderError("KYC_BAD_DOCUMENT_TYPE", `unsupported document type ${req.documentType}`);
    }

    const uploadRef = `kyc_upload_${randomUUID()}`;
    const ticket: KycUploadTicket = {
      uploadRef,
      // A URL, not a byte sink. The client PUTs here; this process never does.
      uploadUrl: `https://mock-kyc.invalid/upload/${uploadRef}?sig=${randomUUID()}`,
      method: "PUT",
      headers: { "Content-Type": req.contentType },
      expiresAt: new Date(Date.now() + MOCK_UPLOAD_TTL_MS),
    };
    this.uploads.set(uploadRef, { ...ticket, caseRef: req.caseRef });
    return ticket;
  }

  async retrieveCase(caseRef: string): Promise<KycCaseSnapshot | null> {
    const kase = this.cases.get(caseRef);
    return kase ? { ...kase } : null;
  }

  parseWebhook(rawBody: string, signatureHeader: string): KycDecisionEvent {
    // Shape checks first, then a constant-time compare over decoded bytes. Every failure
    // raises the SAME error: a verifier that says which check failed is a signature oracle.
    if (!signatureHeader || !HEX_RE.test(signatureHeader) || signatureHeader.length % 2 !== 0) {
      throw new KycWebhookSignatureError();
    }
    const expected = createHmac("sha256", this.webhookSecret).update(rawBody, "utf8").digest();
    const provided = Buffer.from(signatureHeader, "hex");
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
      throw new KycWebhookSignatureError();
    }

    let body: MockWebhookBody;
    try {
      body = JSON.parse(rawBody) as MockWebhookBody;
    } catch {
      throw new KycWebhookSignatureError("webhook body is not valid JSON");
    }

    // An unrecognized status is treated as PENDING, never as APPROVED. A malformed decision
    // must not be able to verify somebody by default — the conservative reading is the one
    // where a garbled event leaves the player exactly where they were.
    const status: KycCaseStatus = isCaseStatus(body.status) ? body.status : "PENDING";
    const decidedAt = body.decided_at ? new Date(body.decided_at) : undefined;

    return {
      id: body.id ?? "",
      type: body.type ?? "verification.unknown",
      caseRef: body.case_ref ?? "",
      userRef: body.user_ref ?? "",
      status,
      ...(body.reason ? { reason: body.reason } : {}),
      ...(decidedAt && !Number.isNaN(decidedAt.getTime()) ? { decidedAt } : {}),
    };
  }

  // ── Dev/test controls ─────────────────────────────────────────────────────────

  /** Record a decision on a case, as a reviewer would. */
  decide(caseRef: string, status: KycCaseStatus, reason?: string): void {
    const kase = this.cases.get(caseRef);
    if (!kase) throw new Error(`mock kyc case ${caseRef} not found`);
    kase.status = status;
    kase.decidedAt = new Date();
    if (reason) kase.reason = reason;
  }

  /**
   * Build a correctly-signed webhook for a case, so a test drives the REAL verification path
   * rather than bypassing it. The mirror of MockPaymentProvider.buildSignedWebhook.
   *
   * `eventId` is settable because webhook idempotency is keyed on the provider's event id, and
   * a test that cannot re-send the SAME id cannot prove a redelivery is absorbed.
   */
  buildSignedWebhook(
    caseRef: string,
    status: KycCaseStatus,
    opts: { eventId?: string; reason?: string; userRef?: string } = {},
  ): { rawBody: string; signature: string; eventId: string } {
    const kase = this.cases.get(caseRef);
    const eventId = opts.eventId ?? `kyc_evt_${randomUUID()}`;
    const body: MockWebhookBody = {
      id: eventId,
      type: status === "APPROVED" ? "verification.approved" : status === "REJECTED" ? "verification.rejected" : "verification.pending",
      case_ref: caseRef,
      user_ref: opts.userRef ?? kase?.userRef ?? "",
      status,
      ...(opts.reason ? { reason: opts.reason } : {}),
      decided_at: new Date().toISOString(),
    };
    const rawBody = JSON.stringify(body);
    const signature = createHmac("sha256", this.webhookSecret).update(rawBody, "utf8").digest("hex");
    return { rawBody, signature, eventId };
  }

  /** Sign an ARBITRARY body — for tests that need a valid signature over a malformed payload. */
  sign(rawBody: string): string {
    return createHmac("sha256", this.webhookSecret).update(rawBody, "utf8").digest("hex");
  }
}
