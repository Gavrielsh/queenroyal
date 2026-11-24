/**
 * Request/flow context propagated into service-layer money operations so their logs can be
 * correlated with the inbound request (trace_id) alongside the operator_transaction_id and
 * user/player id.
 */
export interface FlowContext {
  traceId?: string;
  /**
   * ISO country-region the request was admitted from (e.g. "US-NJ"), as the jurisdiction fence
   * resolved it. Empty when the fence is disabled or the edge could not resolve a subdivision.
   * Carried here rather than re-read in the service so the value a compliance decision uses is
   * the same one the perimeter judged.
   */
  jurisdiction?: string;
  /**
   * The client address the request arrived from, as Fastify resolved it behind `trustProxy`.
   *
   * Carried for FRAUD REVIEW ONLY, and only on paths that need it — today the AMOE claim,
   * where one person driving many accounts is the abuse the route invites and the address is
   * the coarse signal that shows it. It is not identity, it is not used for any authorization
   * decision, and it must never become one: an address is shared by households, offices and
   * carrier NAT, so refusing a statutory free entry on it would deny legitimate entrants.
   */
  ip?: string;
}
