// How stored endpoints and deliveries read on the wire: the merchant portal's shapes (MISMATCHES B156) and the console's (RESOLUTIONS
// identity-platform-12). Pure mapping, no I/O.
import type { JsonObject } from '../../../common/contract';
import type { WebhookDelivery, WebhookEndpoint } from '../db/schema';
import type { DeliveryRow } from './webhook-delivery.repository';
import { type WebhookEventName, portalStatusOf } from './webhook-delivery.rules';

/** An endpoint as the portal reads it (never the signing secret). */
export interface EndpointWire {
  readonly id: number;
  readonly url: string;
  readonly events: WebhookEventName[];
  readonly isActive: boolean;
  readonly failureCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * Writes an endpoint for the portal.
 *
 * @param row the stored endpoint
 * @returns the wire object, without the secret
 */
export function endpointToWire(row: WebhookEndpoint): EndpointWire {
  return {
    id: row.id,
    url: row.url,
    // Only the four event names are ever written (the contract's enum), so the text list holds nothing else.
    events: row.events as WebhookEventName[],
    isActive: row.isActive,
    failureCount: row.failureCount,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Writes a delivery for the merchant portal's endpoint log.
 *
 * Why: B156: `status` is `pending`, `succeeded` or `failed`, `responseCode` is `0` when there was no answer and `error` is `''`
 * when there is none.
 *
 * @param row the stored delivery
 * @returns the wire object
 */
export function portalDeliveryToWire(row: WebhookDelivery) {
  return {
    id: row.id,
    event: row.event,
    attempt: row.attempt,
    status: portalStatusOf(row.status),
    responseCode: row.responseCode ?? 0,
    error: row.error ?? '',
    nextRetryAt: row.nextRetryAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Writes a delivery for the console's webhook log (the list, the detail and the retry answer).
 *
 * Why: identity-platform-12: a missing response code is sent as `0`; the endpoint and the merchant are always there, because
 * deliveries go with their endpoint and merchants are never deleted. `payload` is the envelope that was sent, `responseBody` and
 * `error` are what came back (B75).
 *
 * @param row the delivery with its endpoint and merchant
 * @returns the wire object
 */
export function adminDeliveryToWire(row: DeliveryRow) {
  const { delivery } = row;
  return {
    id: delivery.id,
    endpointId: delivery.endpointId,
    event: delivery.event,
    attempt: delivery.attempt,
    status: delivery.status,
    responseCode: delivery.responseCode ?? 0,
    nextRetryAt: delivery.nextRetryAt?.toISOString() ?? null,
    createdAt: delivery.createdAt.toISOString(),
    // The envelope was built by this feature as plain JSON and lives in a jsonb column: the cast only names that.
    payload: delivery.payload as JsonObject,
    responseBody: delivery.responseBody,
    error: delivery.error,
    endpoint: row.endpoint,
    client: row.client,
  };
}
