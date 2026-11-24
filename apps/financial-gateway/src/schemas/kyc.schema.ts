import { z } from "zod";

import { KYC_DOCUMENT_TYPES } from "../lib/kyc";

/**
 * POST /api/kyc/documents body.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * DELIBERATELY EMPTY OF THE DOCUMENT
 * ─────────────────────────────────────────────────────────────────────────────
 * There is no `file`, no `content`, no `data`, no `base64`, and no field that could carry one.
 * The route hands back a presigned URL and the client uploads to it directly; the document
 * never passes through this process, so there is nothing here to buffer, log, or accidentally
 * persist.
 *
 * `.strict()` is what makes that a refusal rather than a convention. A client that POSTs
 * `{"documentType":"PASSPORT","file":"<base64 of a passport>"}` gets a 422 and knows its
 * upload did not happen. Without `.strict()`, Zod would silently drop the extra key, the
 * request would succeed, and the client would reasonably believe it had uploaded a document
 * that went nowhere — the worst of both outcomes, since the applicant then waits for a
 * decision on a file nobody has.
 *
 * It also means the bytes never reach a log. Fastify logs request bodies on error paths at
 * some log levels; a base64 passport in a rejected payload is an identity document sitting in
 * a log aggregator, which is precisely the exposure this whole design exists to avoid. The
 * `bodyLimit` in app.ts is the backstop — a real document exceeds it long before it is parsed.
 */
export const kycDocumentUploadSchema = z
  .object({
    documentType: z.enum(KYC_DOCUMENT_TYPES as unknown as [string, ...string[]]),
    /**
     * The MIME type the client intends to upload, so the provider can constrain the presigned
     * PUT to it. An allow-list rather than a free string: it is echoed into a `Content-Type`
     * header on a URL handed to a browser, and the set of things a legitimate identity
     * document can be is short and known.
     */
    contentType: z.enum(["image/jpeg", "image/png", "image/heic", "application/pdf"]),
  })
  .strict();

export type KycDocumentUploadInput = z.infer<typeof kycDocumentUploadSchema>;
