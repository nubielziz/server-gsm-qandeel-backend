// Route contracts of currencies and exchange rates (map domain E, stage 3, routes /admin/currencies). Shapes match the
// console's `Currency` (docs/contract/endpoints/money.md, resolution money-13).
import { z } from 'zod';
import { defineRoute, listQuery, zDecimal, zId, zIdParam, zIsoDateTime } from '../../../common/contract';

/** A currency row. */
export const CurrencySchema = z.object({
  id: zId,
  code: z.string(),
  name: z.string(),
  rateToBase: zDecimal.describe('Units of the currency per 1 USD.'),
  rateUpdatedAt: zIsoDateTime.describe('When the rate was last set; never null.'),
  markupPercent: zDecimal,
  charmRounding: z.boolean(),
  isStorefront: z.boolean(),
  decimals: z.number().int().min(0).max(4),
  isActive: z.boolean(),
  createdAt: zIsoDateTime,
  // Optional like the console's own type (its mock omits both); the server always sends them.
  updatedAt: zIsoDateTime.optional().describe('When the row last changed; always sent.'),
  isStale: z.boolean().optional().describe('A non-base currency whose rate is older than 24 hours; always sent.'),
});

const gbp = {
  id: 2,
  code: 'GBP',
  name: 'Pound sterling',
  rateToBase: '0.7900',
  rateUpdatedAt: '2026-11-01T06:00:00.000Z',
  markupPercent: '2.5000',
  charmRounding: true,
  isStorefront: true,
  decimals: 2,
  isActive: true,
  createdAt: '2026-01-10T08:00:00.000Z',
  updatedAt: '2026-11-01T06:00:00.000Z',
  isStale: false,
};

/** `GET /admin/currencies`. */
export const listCurrencies = defineRoute({
  key: 'GET /admin/currencies',
  summary: 'Currencies',
  description:
    'Currencies and their rates (`rateToBase` is units per 1 USD). `isStale` marks a non-base currency whose rate is older ' +
    'than 24 hours. USD is the base row (rate 1, no markup, never stale). Reading needs `settings:update`, as the map says.',
  tags: ['clients'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'settings:update',
  query: listQuery({
    sorts: ['code', 'name', 'rateToBase', 'rateUpdatedAt', 'createdAt'],
    defaultSort: { field: 'code', order: 'asc' },
    filters: { isStorefront: { type: 'boolean' }, isActive: { type: 'boolean' } },
    search: ['code', 'name'],
  }),
  success: { status: 200, schema: CurrencySchema },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'VALIDATION_FAILED'],
  examples: { response: [gbp] },
});

/** `GET /admin/currencies/:id`. */
export const getCurrency = defineRoute({
  key: 'GET /admin/currencies/:id',
  summary: 'One currency',
  tags: ['clients'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'settings:update',
  params: z.object({ id: zIdParam }),
  success: { status: 200, schema: CurrencySchema },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'NOT_FOUND', 'VALIDATION_FAILED'],
  examples: { response: gbp },
});

/** `POST /admin/currencies`. */
export const createCurrency = defineRoute({
  key: 'POST /admin/currencies',
  summary: 'Add a currency',
  description:
    'Adds a currency. `code` is three capital letters and unique; `rateToBase` is above zero (up to eight decimal places); ' +
    '`markupPercent` is 0 to 10; `decimals` is 0 to 4. The rate is stamped with the current time. Audited.',
  tags: ['clients'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'settings:update',
  body: z.object({
    code: z.string().trim(),
    name: z.string().trim(),
    rateToBase: zDecimal,
    markupPercent: zDecimal.default('0'),
    charmRounding: z.boolean().default(false),
    isStorefront: z.boolean().default(false),
    decimals: z.number().default(2),
  }),
  success: { status: 201, schema: CurrencySchema },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'VALIDATION_FAILED'],
  examples: {
    request: {
      code: 'GBP',
      name: 'Pound sterling',
      rateToBase: '0.79',
      markupPercent: '2.5',
      charmRounding: true,
      isStorefront: true,
      decimals: 2,
    },
    response: gbp,
  },
});

/** `PATCH /admin/currencies/:id`. */
export const updateCurrency = defineRoute({
  key: 'PATCH /admin/currencies/:id',
  summary: 'Change a currency',
  description:
    'Changes the fields sent. Sending `rateToBase` stamps the rate with the current time. The base currency USD refuses a ' +
    'new rate, a new markup and being switched off. The code cannot be changed once created. Audited.',
  tags: ['clients'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'settings:update',
  params: z.object({ id: zIdParam }),
  body: z.object({
    code: z.string().trim().optional(),
    name: z.string().trim().optional(),
    rateToBase: zDecimal.optional(),
    markupPercent: zDecimal.optional(),
    charmRounding: z.boolean().optional(),
    isStorefront: z.boolean().optional(),
    decimals: z.number().optional(),
    isActive: z.boolean().optional(),
  }),
  success: { status: 200, schema: CurrencySchema },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'NOT_FOUND', 'VALIDATION_FAILED'],
  examples: { request: { rateToBase: '0.8', markupPercent: '2' }, response: gbp },
});
