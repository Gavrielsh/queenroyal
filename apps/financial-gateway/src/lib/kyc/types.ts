/**
 * KYC / identity-verification provider abstraction.
 *
 * The routes depend on this interface, never on a concrete vendor, so Persona, Onfido, Sumsub
 * or Veriff drops in without touching the verification flow. The shape mirrors lib/payments,
 * which is the closest existing analogue: an asynchronous, event-driven third party that
 * returns a decision later, over a signed webhook, and that the gateway must never assume
 * answered synchronously.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE BYTES NEVER TOUCH THIS SERVICE. NOT THE DATABASE, NOT THE PROCESS.
 * ─────────────────────────────────────────────────────────────────────────────
 * A passport scan is the most sensitive data this platform will ever handle, and the safest
 * way to hold it is not to. `createDocumentUpload` returns a PRESIGNED URL that the client
 * PUTs to directly: the file travels browser → provider, and the gateway sees only a
 * reference.
 *
 * That is a structural property, not a policy anyone has to remember:
 *
 *   - Nothing in this interface accepts or returns file content. There is no Buffer, no
 *     base64 string, no stream, and no field that could carry one.
 *   - The upload route's schema is `.strict()` and has no content field, so a client that
 *     tries to POST a document body is refused rather than obliged.
 *   - The Prisma models store a reference, a type and a status — and no BLOB column exists
 *     for bytes to be put in even by a future mistake.
 *
 * The payoff is concrete. Document bytes in our database would mean they are in every backup,
 * every replica, every logical-replication stream, and every `pg_dump` a support engineer has
 * ever taken — and a breach would be a data-protection incident involving government
 * identity documents rather than a list of email addresses. Keeping them at the provider
 * confines that risk to a vendor whose entire business is holding it.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE PROVIDER OWNS ITS SIGNATURE SCHEME
 * ─────────────────────────────────────────────────────────────────────────────
 * `parseWebhook` verifies and normalizes, exactly as PaymentProvider.parseWebhook does, and
 * for the same reason: every vendor signs differently (header name, canonical string, digest
 * encoding, tolerance window), so the scheme belongs inside the adapter. A single shared
 * verifier would have to be rewritten for each vendor or, worse, weakened to accommodate them
 * all.
 */

/** The kinds of document a verification case can require. */
export type KycDocumentType = "PASSPORT" | "DRIVERS_LICENSE" | "NATIONAL_ID" | "PROOF_OF_ADDRESS" | "SELFIE";

export const KYC_DOCUMENT_TYPES: readonly KycDocumentType[] = [
  "PASSPORT",
  "DRIVERS_LICENSE",
  "NATIONAL_ID",
  "PROOF_OF_ADDRESS",
  "SELFIE",
];

export function isKycDocumentType(v: unknown): v is KycDocumentType {
  return typeof v === "string" && (KYC_DOCUMENT_TYPES as readonly string[]).includes(v);
}

/**
 * A request for somewhere to put a document.
 *
 * Note what is absent and cannot be added without changing this type: the document. The
 * gateway asks for a destination, not for permission to relay bytes.
 */
export interface KycUploadRequest {
  /** Our local user id, forwarded as the provider's subject reference. */
  userRef: string;
  /** The provider's case this document belongs to. */
  caseRef: string;
  documentType: KycDocumentType;
  /** Client-declared MIME type, so the provider can constrain the presigned PUT. */
  contentType: string;
}

/**
 * Where to put it, and for how long.
 *
 * `uploadUrl` is handed to the client and is the only thing that can receive the file. It is
 * short-lived by contract — an upload URL that never expires is a permanent write handle to
 * an identity-document store, sitting in whatever log, proxy or browser history saw it.
 */
export interface KycUploadTicket {
  /** The provider's reference for this document slot. Stored; never the file. */
  uploadRef: string;
  /** Presigned URL the CLIENT uploads to directly. Never fetched by this service. */
  uploadUrl: string;
  /** HTTP method the presigned URL expects (typically PUT). */
  method: "PUT" | "POST";
  /** Headers the client must send with the upload, e.g. Content-Type. */
  headers: Record<string, string>;
  /** Absolute expiry. */
  expiresAt: Date;
}

/** Where a verification case stands. Mirrors the KycStatus the gateway already keeps on User. */
export type KycCaseStatus = "PENDING" | "APPROVED" | "REJECTED";

export interface KycCaseSnapshot {
  caseRef: string;
  userRef: string;
  status: KycCaseStatus;
  /** Provider's rationale on a rejection. Operator-facing; never shown to the player verbatim. */
  reason?: string;
  decidedAt?: Date;
}

/**
 * A normalized, signature-verified decision event.
 *
 * `id` is the PROVIDER's event id and is the idempotency anchor for the whole webhook path —
 * see services/kyc-webhook.service. A provider that cannot supply a stable event id cannot be
 * made idempotent by us, so an adapter for one must synthesize a deterministic id from the
 * payload rather than a random one.
 */
export interface KycDecisionEvent {
  id: string;
  /** Provider-native event type, e.g. "verification.approved". */
  type: string;
  caseRef: string;
  userRef: string;
  status: KycCaseStatus;
  reason?: string;
  decidedAt?: Date;
}

export class KycProviderError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "KycProviderError";
  }
}

/** Thrown by a provider that is selected but not fully wired (missing SDK / keys). */
export class KycProviderNotConfiguredError extends KycProviderError {
  constructor(message: string) {
    super("KYC_NOT_CONFIGURED", message);
    this.name = "KycProviderNotConfiguredError";
  }
}

/**
 * Thrown when a webhook signature fails verification.
 *
 * Deliberately carries no detail about WHY. A verifier that distinguishes "bad hex", "wrong
 * length" and "wrong digest" in its error is an oracle that helps an attacker converge on a
 * valid signature; every failure looks identical from outside.
 */
export class KycWebhookSignatureError extends KycProviderError {
  constructor(message = "invalid KYC webhook signature") {
    super("KYC_WEBHOOK_BAD_SIGNATURE", message);
    this.name = "KycWebhookSignatureError";
  }
}

export interface KycProvider {
  readonly name: string;
  /**
   * Open (or reuse) a verification case for a user. Idempotent on `userRef` + the provider's
   * own rules: a user with an open case gets that case back rather than a second one, because
   * two concurrent cases for one person produce two decisions that can disagree.
   */
  createCase(userRef: string): Promise<KycCaseSnapshot>;
  /**
   * Issue a presigned destination for ONE document. Returns a URL the client uploads to
   * directly — this service never receives, buffers, or forwards the file.
   */
  createDocumentUpload(req: KycUploadRequest): Promise<KycUploadTicket>;
  /**
   * Read a case's current state directly from the provider. The backstop for a lost webhook,
   * exactly as retrievePaymentIntent is for a lost PSP event. Returns null if unknown.
   */
  retrieveCase(caseRef: string): Promise<KycCaseSnapshot | null>;
  /**
   * Verify the signature over the RAW body and normalize the event.
   * Throws {@link KycWebhookSignatureError} on a bad or absent signature.
   */
  parseWebhook(rawBody: string, signatureHeader: string): KycDecisionEvent;
}
