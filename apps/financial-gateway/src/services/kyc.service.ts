import type { FlowContext } from "../lib/context";
import type { AuthClaims } from "../lib/jwt";
import { getKycProvider, type KycDocumentType, KycProviderError } from "../lib/kyc";
import { childLogger } from "../lib/logger";
import { getPrisma } from "../lib/prisma";
import type { KycDocumentUploadInput } from "../schemas/kyc.schema";
import type { TrueEngineErrorBody } from "../types/true-engine";
import { ProvisioningError, resolveTransactingPlayer } from "./player-provisioning.service";

/**
 * Document upload, orchestrated — and orchestrated ONLY.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE FILE DOES NOT COME THROUGH HERE
 * ─────────────────────────────────────────────────────────────────────────────
 * This service asks the provider for a destination and writes down that it did. The client
 * then PUTs the document straight to that URL. At no point does this process receive, buffer,
 * forward, or store the bytes — there is no code path through which it could, because nothing
 * in the request schema or the provider interface carries file content.
 *
 * That is worth stating as a property rather than an intention: a reviewer checking "can a
 * passport end up in our database?" can answer it by reading the types, without tracing the
 * flow.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ONE OPEN CASE PER PLAYER
 * ─────────────────────────────────────────────────────────────────────────────
 * Documents attach to a verification CASE, and a player has at most one open at a time. Two
 * concurrent cases for one person produce two decisions that can disagree, with no principled
 * way to pick a winner afterwards — and the losing decision would still be a real, signed
 * statement from the provider sitting in the audit trail.
 *
 * NO FINANCIAL STATE. Nothing here reads, computes or stores a balance. A KYC decision gates
 * whether a player may redeem; it is not money and touches none.
 */

export interface KycUploadAccepted {
  verificationId: string;
  caseRef: string;
  documentId: string;
  documentType: KycDocumentType;
  /** The presigned destination. Returned to the CLIENT, which uploads to it directly. */
  uploadUrl: string;
  uploadRef: string;
  method: "PUT" | "POST";
  headers: Record<string, string>;
  expiresAt: string;
}

export type KycUploadOutcome =
  | { ok: true; data: KycUploadAccepted }
  | { ok: false; status: number; error: TrueEngineErrorBody };

export async function requestDocumentUpload(
  user: AuthClaims,
  input: KycDocumentUploadInput,
  ctx: FlowContext = {},
): Promise<KycUploadOutcome> {
  const flowLog = childLogger({ trace_id: ctx.traceId, user_id: user.sub, component: "kyc-upload" });

  // 1) Identity. resolveTransactingPlayer is reused for the single DB read and the current KYC
  //    status; the engine player id it also resolves is irrelevant here and simply unused —
  //    KYC is Zone 2's own compliance data and involves no ledger call at all.
  let player;
  try {
    player = await resolveTransactingPlayer(user.sub);
  } catch (err) {
    if (err instanceof ProvisioningError) {
      return {
        ok: false,
        status: 404,
        error: { code: "PLAYER_NOT_FOUND", message: "Player is not provisioned", details: err.message },
      };
    }
    throw err;
  }

  // 2) An already-verified player has nothing to prove. Refused rather than quietly issuing a
  //    presigned URL nobody will look at — each one is a live write handle to an
  //    identity-document store, and minting them for no reason is how they end up in logs,
  //    browser history and screenshots.
  if (player.kycStatus === "VERIFIED") {
    return {
      ok: false,
      status: 409,
      error: { code: "KYC_ALREADY_VERIFIED", message: "This account is already verified" },
    };
  }

  const prisma = getPrisma();
  const provider = getKycProvider();

  // 3) Open or reuse the case. The provider decides — it owns the "one open case" rule — and
  //    the local row mirrors what it returns.
  let kase;
  try {
    kase = await provider.createCase(player.userId);
  } catch (err) {
    if (err instanceof KycProviderError) {
      flowLog.error({ err_code: err.code }, "kyc provider refused to open a case");
      return { ok: false, status: 502, error: { code: err.code, message: "Verification provider unavailable" } };
    }
    throw err;
  }

  const verification = await prisma.kycVerification.upsert({
    where: { providerCaseRef: kase.caseRef },
    create: {
      userId: player.userId,
      providerCaseRef: kase.caseRef,
      provider: provider.name,
      status: kase.status,
    },
    update: {},
  });

  // 4) Ask for a destination. Note what is NOT passed: any file, of any kind.
  let ticket;
  try {
    ticket = await provider.createDocumentUpload({
      userRef: player.userId,
      caseRef: kase.caseRef,
      documentType: input.documentType as KycDocumentType,
      contentType: input.contentType,
    });
  } catch (err) {
    if (err instanceof KycProviderError) {
      flowLog.error({ err_code: err.code, case_ref: kase.caseRef }, "kyc provider refused an upload ticket");
      return { ok: false, status: 502, error: { code: err.code, message: "Verification provider unavailable" } };
    }
    throw err;
  }

  // 5) Record that a slot was issued. A REFERENCE and a type — the row is deliberately
  //    incapable of holding the document itself.
  const document = await prisma.kycDocument.create({
    data: {
      userId: player.userId,
      verificationId: verification.id,
      documentType: input.documentType as KycDocumentType,
      providerUploadRef: ticket.uploadRef,
      contentType: input.contentType,
      uploadExpiresAt: ticket.expiresAt,
    },
  });

  // The upload URL is NEVER logged. It is a bearer write-handle to an identity-document store;
  // the ref is enough to correlate and is safe to keep.
  flowLog.info(
    { case_ref: kase.caseRef, document_id: document.id, upload_ref: ticket.uploadRef, document_type: input.documentType },
    "kyc upload ticket issued",
  );

  return {
    ok: true,
    data: {
      verificationId: verification.id,
      caseRef: kase.caseRef,
      documentId: document.id,
      documentType: input.documentType as KycDocumentType,
      uploadUrl: ticket.uploadUrl,
      uploadRef: ticket.uploadRef,
      method: ticket.method,
      headers: ticket.headers,
      expiresAt: ticket.expiresAt.toISOString(),
    },
  };
}
