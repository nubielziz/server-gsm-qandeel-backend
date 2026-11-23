// Route contracts of the console's service page beyond the map (decision 063, scripts/map-additions/47.mjs): the price grid (one read of
// the figures of a page of services: cost, base, shop and per-group prices with their margins) and the stored order of services.
import { z } from 'zod';
import { defineRoute, listQuery, zId, zMoney, zSignedMoney } from '../../../common/contract';
import { SERVICE_TYPES } from '../db/schema';
import { MAX_SERVICE_SORT } from './services.contracts';
import { NamedRef } from './shared';

/** The most services one `POST /admin/services/order` may place. */
export const MAX_ORDER_ITEMS = 500;

/** One merchant group's column of a grid row. */
const GridGroupPrice = z.object({
  groupId: zId.describe('The merchant group (a client group of kind `b2b`).'),
  fixedPrice: zMoney
    .nullable()
    .describe(
      'The price staff fixed for this group and service, as stored; `null` when the group pays the base price less its discount.',
    ),
  price: zMoney.describe(
    'What the price resolver gives this group for the service today (the function orders use, with no merchant): the fixed price, ' +
      'or the base price after the pricing rule, the group discount and rounding, never under the floor.',
  ),
  margin: zSignedMoney.nullable().describe('`price` minus the cost; `null` when the cost is not on record.'),
});

/** One service of the price grid. */
const GridRow = z.object({
  id: zId,
  name: z.string(),
  code: z.string(),
  status: z.enum(['active', 'disabled']),
  sort: z
    .number()
    .int()
    .min(0)
    .max(MAX_SERVICE_SORT)
    .describe('The position staff gave the service among those of its category; `0` when never set.'),
  categoryId: zId,
  supplier: NamedRef.nullable().describe(
    'The first active supplier link by priority, the supplier the service is sent to.',
  ),
  cost: zMoney
    .nullable()
    .describe(
      'The effective cost: the larger of the service cost and the cost of the first supplier link an order can use. `null` when no ' +
        'cost is on record (a new service starts at zero until a supplier is linked or imported).',
    ),
  costChangedFrom: zMoney
    .nullable()
    .describe('The previous cost when it rose since the base price was set; else `null`.'),
  basePrice: zMoney,
  baseMargin: zSignedMoney.nullable().describe('`basePrice` minus the cost; `null` when the cost is not on record.'),
  floorPrice: zMoney.describe('The cost plus the minimum profit, the lowest price a merchant is charged.'),
  belowFloor: z.boolean(),
  retailPrice: zMoney.nullable().describe('The shop price (net USD before VAT); `null` when the service has none.'),
  retailPriceSource: z
    .enum(['rule', 'manual'])
    .nullable()
    .describe(
      '`rule` when the shop price follows a retail price rule, `manual` when a person typed it, `null` without a shop price: ' +
        'the words of the service rows (decision 060).',
    ),
  retailMargin: zSignedMoney
    .nullable()
    .describe('`retailPrice` minus the cost; `null` without a shop price or when the cost is not on record.'),
  groupPrices: z
    .array(GridGroupPrice)
    .describe('One entry per merchant group (kind `b2b`), in the order of the groups page (`sort`, then id).'),
});

const GRID_ROW_EXAMPLE = {
  id: 5,
  name: 'AT&T USA Unlock',
  code: 'IMEI-ATT-USA',
  status: 'active',
  sort: 0,
  categoryId: 4,
  supplier: { id: 3, name: 'DHRU Pro' },
  cost: '13.5000',
  costChangedFrom: null,
  basePrice: '17.2800',
  baseMargin: '3.7800',
  floorPrice: '14.3100',
  belowFloor: false,
  retailPrice: '25.9900',
  retailPriceSource: 'manual',
  retailMargin: '12.4900',
  groupPrices: [
    { groupId: 1, fixedPrice: null, price: '17.2800', margin: '3.7800' },
    { groupId: 2, fixedPrice: '16.9000', price: '16.9000', margin: '3.4000' },
  ],
} as const;

/** `GET /admin/services/price-grid`: the figures of the console's price grid. */
export const listServicePriceGrid = defineRoute({
  key: 'GET /admin/services/price-grid',
  summary: 'Price grid of the services',
  description:
    'One page of live services with everything the console prices from, in one read: the effective `cost` (`null` while no cost is on ' +
    'record), the `basePrice` with its margin, the floor, the shop price with where it comes from and its margin, and for every ' +
    'merchant group (kind `b2b`, in the order of the groups page) the stored `fixedPrice`, the `price` the price resolver gives it ' +
    'today and its margin. The group price and the margin come from the same resolver orders use, one load for the page and no read ' +
    'per cell. A margin is the price minus the cost, `null` when the cost is not on record, negative when the price is under the ' +
    'cost. Same list dialect as `GET /admin/services`: filters `type`, `status`, `categoryId`; `q` is a case-insensitive contains over ' +
    'name, code and category name; sorts `name` (default), `sort` (the order merchants see: category position, then the service ' +
    '`sort`, then name) and `id`; the total is in `x-total-count`. Needs `catalog:read` and also `pricing:read`: `403 FORBIDDEN` ' +
    'naming `pricing:read` without it, before anything is read (the figures are the merchant prices and the cost).',
  tags: ['services'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'catalog:read',
  query: listQuery({
    sorts: ['name', 'sort', 'id'],
    defaultSort: { field: 'name', order: 'asc' },
    filters: {
      type: { type: 'enum', values: SERVICE_TYPES, ops: ['eq', 'ne'] },
      status: { type: 'enum', values: ['active', 'disabled'], ops: ['eq', 'ne'] },
      categoryId: { type: 'id', ops: ['eq'] },
    },
    search: ['name', 'code', 'category.name'],
  }),
  success: { status: 200, schema: GridRow },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'VALIDATION_FAILED'],
  examples: { response: [GRID_ROW_EXAMPLE] },
});

/** `POST /admin/services/order`: store the order of services. */
export const orderServices = defineRoute({
  key: 'POST /admin/services/order',
  summary: 'Set the order of services',
  description:
    'Sets the position (`sort`) of 1 to ' +
    String(MAX_ORDER_ITEMS) +
    ' services in one transaction: either every position is saved or none is. A position is a whole number from 0 to ' +
    String(MAX_SERVICE_SORT) +
    '; merchants and API clients read services by category position, then this number, then the name, so services with the same ' +
    'number stay in name order. A service already at its position is left alone. A service that is listed twice, or is unknown or ' +
    'archived, is `422` on `items.N.id` (N the later of two equal ids; every problem comes back together) and nothing is saved. ' +
    'The answer says how many services changed. One audit entry (`changed the order of`) holds the old and new positions of the ' +
    'changed services (the first 200), the cached merchant price lists start over, and the services are locked in id order, so two ' +
    'saves never interleave.',
  tags: ['services'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'catalog:update',
  body: z.object({
    items: z
      .array(
        z.object({
          id: zId,
          sort: z
            .number()
            .int('Enter a whole number.')
            .min(0, 'Enter 0 or more.')
            .max(MAX_SERVICE_SORT, `Use at most ${MAX_SERVICE_SORT}.`),
        }),
      )
      .min(1, 'Send at least one service.')
      .max(MAX_ORDER_ITEMS, `Send at most ${MAX_ORDER_ITEMS} services at a time.`),
  }),
  success: {
    status: 200,
    schema: z.object({ updated: z.number().int().min(0).describe('How many services changed position.') }),
  },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'VALIDATION_FAILED'],
  examples: {
    request: {
      items: [
        { id: 5, sort: 1 },
        { id: 6, sort: 2 },
      ],
    },
    response: { updated: 2 },
  },
});
