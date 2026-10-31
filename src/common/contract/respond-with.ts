// respondWith(): builds the AlternateResponse a handler throws to answer with another status than the contract's
// success status but the same body schema (GET /health?strict=1 answers 503 with the health body, decision 015).
import { AlternateResponse } from '../errors/alternate-response';
import { AppError } from '../errors/app-error';
import type { AnyRouteContract } from './define-route';

/**
 * Prepares an alternate answer for a route.
 *
 * Why: Nest 12 writes the route's status after the handler returns, so a handler cannot change it; the exception
 * filter sends this object instead. The body is checked with the success schema like a normal answer.
 *
 * @param contract the route contract; `status` must be listed in its `success.alsoStatuses`
 * @param status the HTTP status to send
 * @param body the body, before the success schema strips it
 * @returns an object to `throw` from the handler
 * @throws {Error} when the status is not declared by the contract (programming error)
 * @throws {AppError} `RESPONSE_CONTRACT_VIOLATION` (500) when the body does not satisfy the schema
 */
export function respondWith(contract: AnyRouteContract, status: number, body: unknown): AlternateResponse {
  if (!contract.success.alsoStatuses.includes(status) || !contract.success.schema) {
    throw new Error(`${contract.key}: status ${status} is not declared in success.alsoStatuses`);
  }
  const parsed = contract.success.schema.safeParse(body);
  if (!parsed.success) throw new AppError('RESPONSE_CONTRACT_VIOLATION', { cause: parsed.error });
  return new AlternateResponse(status, parsed.data);
}
