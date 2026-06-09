/**
 * Request/flow context propagated into service-layer money operations so their logs can be
 * correlated with the inbound request (trace_id) alongside the operator_transaction_id and
 * user/player id.
 */
export interface FlowContext {
  traceId?: string;
}
