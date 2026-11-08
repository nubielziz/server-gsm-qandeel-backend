// Route contract of the public order tracking (map domain D, stage 14): GET /store/v1/orders/:token. The console has no screen for it
// (the storefront is another frontend): the shape follows ALIGNMENT § 7 and is written up in the module README.
import { z } from 'zod';
import { defineRoute, zIsoDateTime } from '../../../common/contract';
import { SERVICE_TYPES } from '../../catalog';
import { ORDER_STATUSES } from '../db/schema';

/** `GET /store/v1/orders/:token`. */
export const trackStoreOrder = defineRoute({
  key: 'GET /store/v1/orders/:token',
  summary: 'Track an order',
  description:
    'The order the tracking token names: its public status (`pending`, `processing`, `completed`, `rejected`), the service, the ' +
    "input with all but its last four characters hidden, the result once it is completed, and the timeline in the shop's own words " +
    '(no supplier, risk, note or cost line ever appears). The token is the whole credential (128 random bits, in the link the buyer ' +
    'received); an unknown, malformed or wrong token is `404`. Lookups are limited to 30 a minute per address. Never cached.',
  tags: ['storefront'],
  surface: 'store',
  access: 'tracking-token',
  params: z.object({ token: z.string().min(16).max(128).describe('The tracking token.') }),
  success: {
    status: 200,
    schema: z.object({
      status: z.enum(ORDER_STATUSES),
      service: z.object({ name: z.string(), type: z.enum(SERVICE_TYPES), deliveryTime: z.string() }),
      input: z
        .string()
        .nullable()
        .describe('The IMEI or other main input with all but its last four characters hidden.'),
      quantity: z.number().int().min(1),
      placedAt: zIsoDateTime,
      completedAt: zIsoDateTime.nullable(),
      result: z
        .object({ code: z.string().nullable(), comment: z.string().nullable() })
        .nullable()
        .describe('What the service delivered: set once the order is completed, null before.'),
      timeline: z.array(
        z.object({
          type: z.string().describe('`created`, `paid`, `accepted`, `completed`, `rejected`, `refund` or `reopened`.'),
          message: z.string(),
          createdAt: zIsoDateTime,
        }),
      ),
    }),
  },
  errors: ['NOT_FOUND'],
  examples: {
    response: {
      status: 'completed',
      service: { name: 'iCloud Clean / Lost Check', type: 'imei', deliveryTime: '2 minutes' },
      input: '•••••••••••0004',
      quantity: 1,
      placedAt: '2026-11-07T12:00:00.000Z',
      completedAt: '2026-11-07T12:02:10.000Z',
      result: { code: 'Status: Clean. Carrier: unlocked. Not on the GSMA blacklist.', comment: null },
      timeline: [
        { type: 'created', message: 'Order received', createdAt: '2026-11-07T12:00:00.000Z' },
        { type: 'paid', message: 'Payment received', createdAt: '2026-11-07T12:00:05.000Z' },
        { type: 'completed', message: 'Completed', createdAt: '2026-11-07T12:02:10.000Z' },
      ],
    },
  },
});

/** `GET /store/v1/orders/:token/receipt`. */
export const receiptStoreOrder = defineRoute({
  key: 'GET /store/v1/orders/:token/receipt',
  summary: 'Download the tax receipt of an order',
  description:
    'The PDF tax receipt of the order the tracking token names: receipt number, order, date paid, the buyer, the tax country, the service ' +
    "with its net price, the VAT rate and amount, and the total paid, in the buyer's currency (`Content-Disposition: attachment`). The " +
    'receipt is drawn once, by a background job that runs right after the payment is captured, and stored: every download serves the same ' +
    'stored file. A download that comes before the job has stored it draws and stores it, once. `404` for an unknown, malformed or wrong ' +
    'token, or an order with no receipt. `503` (`UNAVAILABLE`) when the stored copy is missing and could not be made (the file storage ' +
    'is down): try the download again. Lookups are limited to 30 a minute per address. Never cached.',
  tags: ['storefront'],
  surface: 'store',
  access: 'tracking-token',
  params: z.object({ token: z.string().min(16).max(128).describe('The tracking token.') }),
  success: { status: 200, contentType: 'application/pdf' },
  errors: ['NOT_FOUND', 'UNAVAILABLE'],
});
