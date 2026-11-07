// Route contracts of the staff's webhook log (map domain G, stage 7): the list, one delivery with its request and the merchant's
// answer, and the manual retry. Shapes match the console's WebhookDelivery (docs/contract/endpoints/platform.md, RESOLUTIONS
// identity-platform-12).
import { z } from 'zod';
import { defineRoute, listQuery, zId, zIdParam, zIsoDateTime, zJsonObject } from '../../../common/contract';
import { WEBHOOK_DELIVERY_STATUSES } from '../db/schema';

/**
 * One delivery with the endpoint and the merchant behind it (never null: deliveries go with their endpoint), the request that
 * was sent (`payload`) and the answer that came back (`responseBody`, `error`): the table's columns plus the two joins.
 */
const DeliveryRow = z.object({
  id: zId,
  endpointId: zId,
  event: z.string(),
  attempt: z.number().int(),
  status: z.enum(WEBHOOK_DELIVERY_STATUSES),
  responseCode: z.number().int(),
  nextRetryAt: zIsoDateTime.nullable(),
  createdAt: zIsoDateTime,
  payload: zJsonObject.nullable(),
  responseBody: z.string().nullable(),
  error: z.string().nullable(),
  endpoint: z.object({ id: zId, url: z.string() }),
  client: z.object({ id: zId, name: z.string() }),
});

const ROW_EXAMPLE = {
  id: 118,
  endpointId: 3,
  event: 'order.status_changed',
  attempt: 2,
  status: 'pending',
  responseCode: 500,
  nextRetryAt: '2026-11-01T10:12:00.000Z',
  createdAt: '2026-11-01T09:42:10.000Z',
  payload: {
    id: 'evt_9f2c1b7a40d85e6a31c2b0d4',
    type: 'order.status_changed',
    createdAt: '2026-11-01T09:42:10.000Z',
    data: { orderId: 48102, status: 'completed' },
  },
  responseBody: '{"error":"internal"}',
  error: null,
  endpoint: { id: 3, url: 'https://hooks.example.com/gsm' },
  client: { id: 1, name: 'Zain Mobile Hub' },
} as const;

/** `GET /admin/webhook-deliveries`: the log of merchant webhooks. */
export const listWebhookDeliveries = defineRoute({
  key: 'GET /admin/webhook-deliveries',
  summary: 'Log of merchant webhooks',
  description:
    'Newest first. Each row has the delivery columns, the endpoint and the merchant. `status` is `pending`, `delivered` or `failed`. `responseCode` is `0` when the merchant’s server gave no answer ' +
    '(RESOLUTIONS identity-platform-12). `nextRetryAt` is `null` once the delivery is finished. `q` is a case-insensitive ' +
    'contains over the merchant’s name, the event and the endpoint address.',
  tags: ['webhooks'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'webhooks:read',
  query: listQuery({
    sorts: ['createdAt', 'id'],
    defaultSort: { field: 'createdAt', order: 'desc' },
    filters: {
      status: { type: 'enum', values: [...WEBHOOK_DELIVERY_STATUSES], ops: ['eq', 'ne'] },
      event: { type: 'string', ops: ['eq'] },
      clientId: { type: 'id', ops: ['eq'] },
    },
    search: ['client.name', 'event', 'endpoint.url'],
  }),
  success: { status: 200, schema: DeliveryRow },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'VALIDATION_FAILED'],
  examples: { response: [ROW_EXAMPLE] },
});

/** `GET /admin/webhook-deliveries/:id`: one delivery. */
export const showWebhookDelivery = defineRoute({
  key: 'GET /admin/webhook-deliveries/:id',
  summary: 'Show a webhook delivery',
  description:
    'The same row as the list: `payload` is the envelope that is signed and sent, `responseBody` the merchant’s answer (cut to a ' +
    'few kilobytes, `null` when none) and `error` what went wrong when no answer came (`null` otherwise).',
  tags: ['webhooks'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'webhooks:read',
  params: z.object({ id: zIdParam }),
  success: { status: 200, schema: DeliveryRow },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'NOT_FOUND'],
  examples: { response: ROW_EXAMPLE },
});

/** `POST /admin/webhook-deliveries/:id/retry`: send a delivery again. */
export const retryWebhookDelivery = defineRoute({
  key: 'POST /admin/webhook-deliveries/:id/retry',
  summary: 'Resend a webhook delivery',
  description:
    'Queues one more attempt of the same payload now: the delivery becomes `pending`, its `attempt` goes up by one and ' +
    '`nextRetryAt` is now; the worker signs it again with a new timestamp. A delivery that already worked is ' +
    '`409 DELIVERY_SUCCEEDED`. Retrying one delivery again within a minute is `429` with `Retry-After`. Writes the audit entry ' +
    '`retried webhook delivery of <merchant>`.',
  tags: ['webhooks'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'webhooks:update',
  params: z.object({ id: zIdParam }),
  success: { status: 200, schema: DeliveryRow },
  errors: [
    'UNAUTHORIZED',
    'FORBIDDEN',
    'CSRF_FAILED',
    'NOT_FOUND',
    'DELIVERY_SUCCEEDED',
    'RATE_LIMITED',
    'UNAVAILABLE',
  ],
  examples: { response: { ...ROW_EXAMPLE, attempt: 3, nextRetryAt: '2026-11-01T10:30:00.000Z' } },
});
