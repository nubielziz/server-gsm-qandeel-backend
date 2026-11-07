// Route contracts of the pricing actions (map domain B, stage 4): the group prices of a service, the bulk price change
// (preview, then apply) and the price resolver. Shapes match the console's api/pricing.ts and serviceParts.ts
// (docs/contract/endpoints/catalog.md, RESOLUTIONS catalog-1, -4, -11, -12, -14).
import { z } from 'zod';
import { defineRoute, zDecimal, zId, zIdParam, zMoney } from '../../../common/contract';
import { NamedRef, PositiveMoney } from './shared';

/** One group price of a service. */
const GroupPriceRow = z.object({ groupId: zId, price: zMoney });

const GROUP_PRICE_EXAMPLE = { groupId: 3, price: '15.9000' } as const;

/** `PUT /admin/services/:id/group-prices`: replace the whole set of group prices of a service. */
export const replaceServiceGroupPrices = defineRoute({
  key: 'PUT /admin/services/:id/group-prices',
  summary: 'Replace the group prices of a service',
  description:
    'The whole set, including the storefront retail group (`b2c_retail`); a group left out loses its fixed price (it then pays ' +
    'the base price less its discount). One transaction, answers the saved prices by group id. Every row must be at or above ' +
    'its floor, rows kept unchanged included: a merchant group row at the effective cost plus the minimum profit for that group ' +
    '(`422` on `prices.N.price`, "Below the floor of $X (cost $Y plus $Z minimum profit)."), the retail row at the storefront ' +
    'floor `max(round(base price x 1.10, 2), floor)` ("Below the storefront floor of $X."). A group listed twice is `422` on ' +
    '`prices.N.groupId` ("Listed twice", the later row); an unknown group is `422` on `prices.N.groupId`; a price not above zero ' +
    'is `422` on `prices.N.price`. An unknown or archived service is `404`.',
  tags: ['services'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'pricing:update',
  params: z.object({ id: zIdParam }),
  body: z.object({
    prices: z.array(z.object({ groupId: zId, price: PositiveMoney })).max(200, 'Use at most 200 group prices.'),
  }),
  success: { status: 200, schema: z.array(GroupPriceRow) },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'NOT_FOUND', 'VALIDATION_FAILED'],
  examples: { request: { prices: [GROUP_PRICE_EXAMPLE] }, response: [GROUP_PRICE_EXAMPLE] },
});

const BulkBody = z.object({
  categoryId: zId.optional().describe('Reprice every live service of this category.'),
  serviceIds: z.array(zId).max(1000, 'Choose at most 1000 services.').optional().describe('Or reprice these services.'),
  change: z.object({
    type: z.enum(['percent', 'fixed']).describe('`percent` of the current base price, or an amount added to it.'),
    value: z
      .string()
      .trim()
      .max(40, 'Too long.')
      .describe(
        'A signed decimal with at most four decimals: `5`, `-0.25`. Zero or text that is not a number is `422` on `amount`.',
      ),
  }),
});

const BULK_REQUEST_EXAMPLE = { categoryId: 4, change: { type: 'percent', value: '5' } } as const;

/** `POST /admin/services/bulk-price/preview`: what a bulk change would do. */
export const previewBulkPrice = defineRoute({
  key: 'POST /admin/services/bulk-price/preview',
  summary: 'Preview a bulk price change',
  description:
    'Works out the new base price of every service in the scope (`serviceIds` wins over `categoryId`; archived services are left ' +
    'out) and saves nothing, so it writes no audit entry (it is a POST only because the change travels in the body). `percent` gives `round(old x (1 + value / 100), 2)`, `fixed` gives `round(old + value, 2)`, half-up. ' +
    '`belowFloor` per line is the new price under the service floor (no merchant: rules for every group only) and the top-level ' +
    '`belowFloor` counts them. `422` on `amount` for zero, text that is not a number, or a new price that would not be above zero ' +
    '(the message names the service); `422` on `scope` when neither a category nor a non-empty `serviceIds` is sent.',
  tags: ['services'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'pricing:update',
  audit: false,
  body: BulkBody,
  success: {
    status: 200,
    schema: z.object({
      lines: z.array(
        z.object({
          serviceId: zId,
          name: z.string(),
          code: z.string(),
          oldPrice: zMoney,
          newPrice: zMoney,
          floorPrice: zMoney,
          belowFloor: z.boolean(),
        }),
      ),
      belowFloor: z.number().int().min(0),
    }),
  },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'VALIDATION_FAILED'],
  examples: {
    request: BULK_REQUEST_EXAMPLE,
    response: {
      lines: [
        {
          serviceId: 5,
          name: 'AT&T USA Unlock',
          code: 'IMEI-ATT-USA',
          oldPrice: '17.2800',
          newPrice: '18.1400',
          floorPrice: '14.3100',
          belowFloor: false,
        },
      ],
      belowFloor: 0,
    },
  },
});

/** `POST /admin/services/bulk-price/apply`: apply a bulk change. */
export const applyBulkPrice = defineRoute({
  key: 'POST /admin/services/bulk-price/apply',
  summary: 'Apply a bulk price change',
  description:
    'The same body as the preview, recomputed from the current prices inside the transaction (the preview is not a token). Every ' +
    'new price is saved, those under the floor too (counted in `belowFloor`: the floor still applies at order time, where an ' +
    'order pays `max(price, floor)`); every repriced service has its `costChangedFrom` cleared. One audit entry for the change. ' +
    'The same `422` rules as the preview.',
  tags: ['services'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'pricing:update',
  body: BulkBody,
  success: { status: 200, schema: z.object({ updated: z.number().int().min(0), belowFloor: z.number().int().min(0) }) },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'VALIDATION_FAILED'],
  examples: { request: BULK_REQUEST_EXAMPLE, response: { updated: 8, belowFloor: 0 } },
});

/** One step of the trace. `value` and `after` are prices as 4-decimal text, or a signed fraction (a number) for `category`/`discount`. */
const StepRow = z.object({
  id: z.enum(['client', 'group', 'base', 'category', 'discount', 'rounding']),
  label: z.string(),
  state: z.enum(['win', 'apply', 'skip', 'none']),
  value: z
    .union([z.string(), z.number()])
    .nullable()
    .describe(
      'A price (4-decimal text), or a signed fraction (a number: -0.02 is -2 %) for `category` and `discount`.',
    ),
  after: z
    .union([z.string(), z.number()])
    .nullable()
    .describe('The running price after the step, when it decided or changed it.'),
  note: z.string(),
});

const STEPS_EXAMPLE = [
  { id: 'client', label: 'Client override', state: 'none', value: null, after: null, note: 'None for this merchant' },
  {
    id: 'group',
    label: 'Group service price',
    state: 'none',
    value: null,
    after: null,
    note: 'None for the Standard group',
  },
  {
    id: 'base',
    label: 'Base price',
    state: 'apply',
    value: '17.2800',
    after: '17.2800',
    note: 'Cost $13.50 plus 28.0% markup',
  },
  {
    id: 'category',
    label: 'Category rule',
    state: 'apply',
    value: -0.02,
    after: '16.9300',
    note: 'Carrier unlock promo -2%',
  },
  {
    id: 'discount',
    label: 'Group discount',
    state: 'none',
    value: null,
    after: null,
    note: 'Standard group has no discount',
  },
] as const;

/** `GET /admin/pricing/resolve`: the price of a service for a merchant, with the trace. */
export const resolvePrice = defineRoute({
  key: 'GET /admin/pricing/resolve',
  summary: 'Resolve a price',
  description:
    'The price one merchant pays for one service, with the steps that led to it, in the order of the demo: client override, ' +
    'group service price, base price, the pricing rule (id `category`, label "Service rule", "Category rule" or "Global rule" by ' +
    'the winning rule), the group discount, then the optional `rounding` step. A client or group price is fixed and skips the ' +
    'rule, the discount and the rounding. `price` is the final price after the floor clamp; `rawPrice` the price before it; ' +
    '`floor` = `cost` (the effective cost) + `minProfit`; `clamped` says the price was raised to the floor. `otherGroups` prices ' +
    'the same service for every merchant group without a client override. Archived services are `404`.',
  tags: ['services'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'pricing:read',
  query: z.object({ serviceId: zIdParam, clientId: zIdParam }),
  success: {
    status: 200,
    schema: z.object({
      price: zMoney,
      rawPrice: zMoney,
      floor: zMoney,
      clamped: z.boolean(),
      source: z.enum(['client', 'group', 'base']),
      cost: zMoney,
      minProfit: zMoney,
      margin: zMoney,
      marginPct: zDecimal,
      steps: z.array(StepRow),
      otherGroups: z.array(z.object({ group: NamedRef, price: zMoney, clamped: z.boolean() })).optional(),
    }),
  },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'NOT_FOUND', 'VALIDATION_FAILED'],
  examples: {
    response: {
      price: '16.9300',
      rawPrice: '16.9300',
      floor: '14.3100',
      clamped: false,
      source: 'base',
      cost: '13.5000',
      minProfit: '0.8100',
      margin: '3.4300',
      marginPct: '20.2599',
      steps: STEPS_EXAMPLE,
      otherGroups: [{ group: { id: 1, name: 'Standard' }, price: '16.9300', clamped: false }],
    },
  },
});
