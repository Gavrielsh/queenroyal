/**
 * Standard JSON envelopes shared by every route, matching the gateway's existing API
 * contract: `{ success: true, data }` on success and
 * `{ success: false, error: { code, message, details? } }` on failure.
 */

export interface ApiError {
  code: string;
  message: string;
  details?: unknown;
}

export function okBody<T>(data: T): { success: true; data: T } {
  return { success: true, data };
}

export function errBody(code: string, message: string, details?: unknown): { success: false; error: ApiError } {
  return {
    success: false,
    error: { code, message, ...(details !== undefined ? { details } : {}) },
  };
}
