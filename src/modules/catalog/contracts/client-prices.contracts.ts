// Route contracts of the client prices (map domain B, routes /admin/client-prices, stage 4): list, create, change and delete a
// merchant's fixed price for a service. Shapes match the console's ClientPrice (docs/contract/endpoints/catalog.md,
// RESOLUTIONS catalog-1 and catalog-16).
import { z } from 'zod';
import { defineRoute, listQuery, zId, zIdParam, zIsoDateTime, zMoney } from '../../../common/contract';
import { SERVICE_TYPES } from '../db/schema';
import { PositiveMoney } from './shared';

/** A fixed price with the service it is for and what the merchant would pay without it. */
const ClientPriceRow = z.object({
  id: zId,
  serviceId: zId,
  clientId: zId,
  price: zMoney,
  note: z.string().describe('`""` when there is none.'),
  createdAt: zIsoDateTime,
  service: z.object({
    id: zId,
    name: z.string(),
    type: z.enum(SERVICE_TYPES),
    basePrice: zMoney.nullable(),
    floorPrice: zMoney
      .nullable()
      .describe(
        'The lowest price accepted for this merchant: the effective cost plus the minimum profit of its group.',
      ),
  }),
  groupPrice: zMoney
    .nullable()
    .describe(
      'What the merchant pays without the fixed price: the resolver result for its group (group price or base price with the ' +
        'rule, discount, rounding and floor clamp), 4 decimals.',
    ),
});

const PRICE_EXAMPLE = {
  id: 3,
  serviceId: 5,
  clientId: 5,
  price: '15.2000',
  note: 'Agreed on the call',
  createdAt: '2026-10-18T09:30:00.000Z',
  service: { id: 5, name: 'AT&T USA Unlock', type: 'imei', basePrice: '17.2800', floorPrice: '14.3100' },
  groupPrice: '16.9300',
} as const;

const Note = z.string().trim().max(200, 'Use at most 200 characters.');

/** `GET /admin/client-prices`: fixed prices, one merchant's or all. */
export const listClientPrices = defineRoute({
  key: 'GET /admin/client-prices',
  summary: 'List client prices',
  description:
    'Fixed prices with the service and `groupPrice`. The merchant page asks with `clientId` and reads the whole list ' +
    '(`_end=200`). Prices of archived services are left out. Sorts: `service.name` (default), `price`, `createdAt`, `id`. `q` ' +
    'searches the service name and code.',
  tags: ['client-prices'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'pricing:read',
  query: listQuery({
    sorts: ['service.name', 'price', 'createdAt', 'id'],
    defaultSort: { field: 'service.name', order: 'asc' },
    filters: { clientId: { type: 'id', ops: ['eq'] }, serviceId: { type: 'id', ops: ['eq'] } },
    search: ['service.name', 'service.code'],
  }),
  success: { status: 200, schema: ClientPriceRow },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'VALIDATION_FAILED'],
  examples: { response: [PRICE_EXAMPLE] },
});

/** `POST /admin/client-prices`: a fixed price for a merchant. */
export const createClientPrice = defineRoute({
  key: 'POST /admin/client-prices',
  summary: 'Set a client price',
  description:
    'A fixed price one merchant pays for one service, from its next order: it beats the group price, the pricing rules and every ' +
    "discount. The price must be above zero and at or above the floor of the merchant's group (effective cost plus minimum " +
    'profit): `422` on `price` with "Below the floor of $X (cost $Y plus $Z minimum profit).". An unknown or archived service, ' +
    'or one that is turned off, is `422` on `serviceId`; an unknown merchant is `422` on `clientId`; a second price for the same ' +
    'merchant and service is `409 PRICE_EXISTS`. `note` is optional.',
  tags: ['client-prices'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'pricing:create',
  body: z.object({ clientId: zId, serviceId: zId, price: PositiveMoney, note: Note.optional() }),
  success: { status: 201, schema: ClientPriceRow },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'VALIDATION_FAILED', 'PRICE_EXISTS'],
  examples: {
    request: { clientId: 5, serviceId: 5, price: '15.2000', note: 'Agreed on the call' },
    response: PRICE_EXAMPLE,
  },
});

/** `PATCH /admin/client-prices/:id`: change the price or the note. */
export const updateClientPrice = defineRoute({
  key: 'PATCH /admin/client-prices/:id',
  summary: 'Change a client price',
  description:
    'Only the keys sent change; `note: ""` clears the note. A new price faces the same floor check as on create (`422` on ' +
    '`price`). A price of an archived service is `404`.',
  tags: ['client-prices'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'pricing:update',
  params: z.object({ id: zIdParam }),
  body: z
    .object({ price: PositiveMoney.optional(), note: Note.optional() })
    .refine((body) => body.price !== undefined || body.note !== undefined, 'Send at least one field to change.'),
  success: { status: 200, schema: ClientPriceRow },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'NOT_FOUND', 'VALIDATION_FAILED'],
  examples: { request: { price: '15.5000' }, response: { ...PRICE_EXAMPLE, price: '15.5000' } },
});

/** `DELETE /admin/client-prices/:id`: remove a fixed price. */
export const deleteClientPrice = defineRoute({
  key: 'DELETE /admin/client-prices/:id',
  summary: 'Remove a client price',
  description:
    'The merchant pays the group price again from its next order. Answers `204`. A price of an archived service is `404`.',
  tags: ['client-prices'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'pricing:delete',
  params: z.object({ id: zIdParam }),
  success: { status: 204 },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'NOT_FOUND'],
});
