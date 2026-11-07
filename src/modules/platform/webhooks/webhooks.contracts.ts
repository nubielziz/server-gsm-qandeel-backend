// Route contracts of the merchant portal's webhook endpoints (map domain G, stage 7; MISMATCHES B156): list, create, change,
// delete, send a test event, and the delivery log of one endpoint.
import { z } from 'zod';
import { defineRoute, listQuery, zId, zIdParam, zIsoDateTime } from '../../../common/contract';
import { MAX_ENDPOINTS_PER_MERCHANT, PING_EVENT, WEBHOOK_EVENT_NAMES } from './webhook-delivery.rules';

/** A webhook endpoint as the portal reads it: the signing secret is never part of it. */
const EndpointRow = z.object({
  id: zId,
  url: z.string(),
  events: z.array(z.enum(WEBHOOK_EVENT_NAMES)),
  isActive: z.boolean(),
  failureCount: z.number().int(),
  createdAt: zIsoDateTime,
  updatedAt: zIsoDateTime,
});

/** The address: trimmed, at most 2048 characters. The use case checks it is https with a public host. */
const EndpointUrl = z
  .string()
  .trim()
  .min(1, 'Enter the address of your endpoint.')
  .max(2048, 'Use at most 2048 characters.');
/** The events: a non-empty subset of the four. */
const EndpointEvents = z
  .array(z.enum(WEBHOOK_EVENT_NAMES), { error: `Choose from ${WEBHOOK_EVENT_NAMES.join(', ')}.` })
  .min(1, 'Choose at least one event.')
  .max(WEBHOOK_EVENT_NAMES.length);

/** One attempt chain of a delivery as the merchant sees it. */
const DeliveryRow = z.object({
  id: zId,
  event: z.string(),
  attempt: z.number().int(),
  status: z.enum(['pending', 'succeeded', 'failed']),
  responseCode: z.number().int(),
  error: z.string(),
  nextRetryAt: zIsoDateTime.nullable(),
  createdAt: zIsoDateTime,
});

const ENDPOINT_EXAMPLE = {
  id: 3,
  url: 'https://hooks.example.com/gsm',
  events: ['order.status_changed', 'wallet.low_balance'],
  isActive: true,
  failureCount: 0,
  createdAt: '2026-10-01T08:00:00.000Z',
  updatedAt: '2026-10-01T08:00:00.000Z',
} as const;

const PORTAL_ERRORS = ['UNAUTHORIZED', 'ACCOUNT_SUSPENDED', 'ACCOUNT_PENDING_APPROVAL', 'IP_NOT_ALLOWED'] as const;

/** `GET /client/webhooks`: the merchant's endpoints. */
export const portalListWebhooks = defineRoute({
  key: 'GET /client/webhooks',
  summary: 'My webhook endpoints',
  description:
    'The endpoints of the signed-in merchant, newest first. The signing secret is shown once, when the endpoint is created.',
  tags: ['webhooks'],
  surface: 'client',
  access: 'merchant-session',
  query: listQuery({ sorts: ['createdAt', 'id'], defaultSort: { field: 'createdAt', order: 'desc' } }),
  success: { status: 200, schema: EndpointRow },
  errors: ['VALIDATION_FAILED', ...PORTAL_ERRORS],
  examples: { response: [ENDPOINT_EXAMPLE] },
});

/** `POST /client/webhooks`: a new endpoint with its signing secret. */
export const portalCreateWebhook = defineRoute({
  key: 'POST /client/webhooks',
  summary: 'New webhook endpoint',
  description:
    'The address must be `https` with a public host: addresses that resolve to private, loopback or link-local networks are ' +
    'refused (`422` on `url`), now and again at every send. `events` is a non-empty subset of ' +
    `${WEBHOOK_EVENT_NAMES.map((event) => `\`${event}\``).join(', ')} (\`422\` on \`events.N\`). A merchant may register ` +
    `${MAX_ENDPOINTS_PER_MERCHANT} endpoints: the next is \`422\` on \`url\`. The answer carries the signing secret once as ` +
    '`secret` (`Cache-Control: no-store`); it is stored encrypted and never read back. Deliveries are signed with it: see the ' +
    'webhook events in the public API reference.',
  tags: ['webhooks'],
  surface: 'client',
  access: 'merchant-session',
  body: z.object({ url: EndpointUrl, events: EndpointEvents, isActive: z.boolean().optional() }),
  success: { status: 201, schema: z.object({ endpoint: EndpointRow, secret: z.string() }) },
  errors: ['VALIDATION_FAILED', ...PORTAL_ERRORS, 'CSRF_FAILED'],
  examples: {
    request: { url: 'https://hooks.example.com/gsm', events: ['order.status_changed', 'wallet.low_balance'] },
    response: { endpoint: ENDPOINT_EXAMPLE, secret: 'whsec_Qx4fD0nQ2hX8mV3vT9cKzY6bJ1aW5eRuLs7NpG4HtM0' },
  },
});

/** `PATCH /client/webhooks/:id`: change or pause an endpoint. */
export const portalUpdateWebhook = defineRoute({
  key: 'PATCH /client/webhooks/:id',
  summary: 'Edit or pause an endpoint',
  description:
    'A partial body: a missing key stays as it is. `isActive: false` pauses the endpoint (events are not sent to it); turning it ' +
    'on again resets `failureCount`. A changed address is checked like a new one. Another merchant’s and an unknown endpoint are `404`.',
  tags: ['webhooks'],
  surface: 'client',
  access: 'merchant-session',
  params: z.object({ id: zIdParam }),
  body: z.object({ url: EndpointUrl.optional(), events: EndpointEvents.optional(), isActive: z.boolean().optional() }),
  success: { status: 200, schema: EndpointRow },
  errors: ['VALIDATION_FAILED', 'NOT_FOUND', ...PORTAL_ERRORS, 'CSRF_FAILED'],
  examples: { request: { isActive: false }, response: { ...ENDPOINT_EXAMPLE, isActive: false } },
});

/** `DELETE /client/webhooks/:id`: delete an endpoint with its delivery log. */
export const portalDeleteWebhook = defineRoute({
  key: 'DELETE /client/webhooks/:id',
  summary: 'Delete an endpoint',
  description: 'Deletes the endpoint and its delivery log. Another merchant’s and an unknown endpoint are `404`.',
  tags: ['webhooks'],
  surface: 'client',
  access: 'merchant-session',
  params: z.object({ id: zIdParam }),
  success: { status: 204 },
  errors: ['NOT_FOUND', ...PORTAL_ERRORS, 'CSRF_FAILED'],
});

/** `POST /client/webhooks/:id/test`: queue a signed test delivery. */
export const portalTestWebhook = defineRoute({
  key: 'POST /client/webhooks/:id/test',
  summary: 'Send a test event',
  description:
    `Queues one signed delivery of the event \`${PING_EVENT}\` with a small sample payload \`{ message, endpointId }\`: the same ` +
    'envelope, signature and retry rules as a real event, so the merchant can check its receiver. The answer is `202` with the ' +
    'delivery id; read its progress in `GET /client/webhooks/:id/deliveries`. A paused endpoint is `409 INVALID_TRANSITION`.',
  tags: ['webhooks'],
  surface: 'client',
  access: 'merchant-session',
  params: z.object({ id: zIdParam }),
  success: { status: 202, schema: z.object({ deliveryId: zId }) },
  errors: ['NOT_FOUND', 'INVALID_TRANSITION', 'UNAVAILABLE', ...PORTAL_ERRORS, 'CSRF_FAILED'],
  examples: { response: { deliveryId: 118 } },
});

/** `GET /client/webhooks/:id/deliveries`: the delivery log of one endpoint. */
export const portalListWebhookDeliveries = defineRoute({
  key: 'GET /client/webhooks/:id/deliveries',
  summary: 'Delivery log of an endpoint',
  description:
    'The deliveries of the endpoint, newest first. `status` is `pending` (waiting for an attempt), `succeeded` (a `2xx` answer) or ' +
    '`failed` (8 attempts used). `attempt` is the attempt the delivery is on; `responseCode` is `0` when the server gave no ' +
    'answer; `error` is `""` when there is none. Another merchant’s and an unknown endpoint are `404`.',
  tags: ['webhooks'],
  surface: 'client',
  access: 'merchant-session',
  params: z.object({ id: zIdParam }),
  query: listQuery({ sorts: ['createdAt', 'id'], defaultSort: { field: 'createdAt', order: 'desc' } }),
  success: { status: 200, schema: DeliveryRow },
  errors: ['VALIDATION_FAILED', 'NOT_FOUND', ...PORTAL_ERRORS],
  examples: {
    response: [
      {
        id: 118,
        event: 'order.status_changed',
        attempt: 1,
        status: 'succeeded',
        responseCode: 200,
        error: '',
        nextRetryAt: null,
        createdAt: '2026-11-01T09:42:10.000Z',
      },
    ],
  },
});
