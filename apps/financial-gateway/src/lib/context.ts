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
}
