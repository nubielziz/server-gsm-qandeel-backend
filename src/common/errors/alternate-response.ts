// A non-error answer with a different status that still uses the route's success schema (GET /health?strict=1).
// Thrown by a handler and sent by the exception filter, because Nest re-applies the route status after the handler.

/**
 * Carries a status and body the filter sends as is (no problem+json, no error metrics, no error log).
 *
 * Why: a status other than the contract's success status cannot be set from a handler in Nest 12 (the framework
 * writes the route status after the handler returns); `/health?strict=1` must answer 503 with the normal health
 * body (decision 015). Build it with `respondWith(contract, status, body)` so the body is checked.
 *
 * @see src/common/contract/respond-with.ts
 */
export class AlternateResponse {
  /**
   * @param status the HTTP status to send
   * @param body the JSON body to send
   */
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {}
}
