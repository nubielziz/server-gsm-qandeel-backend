// Route contracts of the tax rates by country (map domain E, stage 14, routes /admin/tax-rates; built ahead of feature 14b).
// Shapes match the console's `TaxRateRow` (docs/contract/endpoints/money.md).
import { z } from 'zod';
import { defineRoute, listQuery, zDecimal, zId, zIdParam, zIsoDateTime } from '../../../common/contract';

/** A tax rate row. */
export const TaxRateSchema = z.object({
  id: zId,
  country: z.string().describe('ISO 3166 alpha-2 code.'),
  region: z.string().describe("A region inside the country, '' for the whole country."),
  ratePercent: zDecimal.describe('Percent, 4 decimal places (`20.0000`).'),
  taxType: z.string().describe('vat | gst | sales_tax | none (older rows may hold other words, shown as they are).'),
  appliesTo: z.string(),
  validFrom: zIsoDateTime
    .nullable()
    .describe('Start of the window (a calendar date at midnight UTC); never null in practice.'),
  validTo: zIsoDateTime.nullable().describe('End of the window (exclusive); null = until further notice.'),
  label: z.string(),
  ossScheme: z.string().describe("The reporting scheme (`EU OSS`, `UK VAT`); '' when no tax is collected."),
  createdAt: zIsoDateTime,
  // Optional like the console's own type; the server always sends it.
  updatedAt: zIsoDateTime.optional().describe('When the row last changed; always sent.'),
});

const france = {
  id: 4,
  country: 'FR',
  region: '',
  ratePercent: '20.0000',
  taxType: 'vat',
  appliesTo: 'digital_services',
  validFrom: '2026-04-15T00:00:00.000Z',
  validTo: null,
  label: 'France VAT',
  ossScheme: 'EU OSS',
  createdAt: '2026-04-15T00:00:00.000Z',
  updatedAt: '2026-04-15T00:00:00.000Z',
};

const WINDOW_RULES =
  'A window runs from `validFrom` (a calendar date at midnight UTC) to `validTo` (exclusive; null = open). One window at a ' +
  'time per country and region: an overlap is 422 on `validFrom`. There is no delete; a rate that stops applying gets a ' +
  '`validTo`.';

/** `GET /admin/tax-rates`. */
export const listTaxRates = defineRoute({
  key: 'GET /admin/tax-rates',
  summary: 'Tax rates',
  description: `Tax rates by country, every window (history included). ${WINDOW_RULES}`,
  tags: ['refunds'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'tax:read',
  query: listQuery({
    sorts: ['country', 'validFrom', 'ratePercent', 'createdAt'],
    defaultSort: { field: 'country', order: 'asc' },
    search: ['country', 'label'],
  }),
  success: { status: 200, schema: TaxRateSchema },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'VALIDATION_FAILED'],
  examples: { response: [france] },
});

/** `GET /admin/tax-rates/:id`. */
export const getTaxRate = defineRoute({
  key: 'GET /admin/tax-rates/:id',
  summary: 'One tax rate',
  tags: ['refunds'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'tax:read',
  params: z.object({ id: zIdParam }),
  success: { status: 200, schema: TaxRateSchema },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'NOT_FOUND', 'VALIDATION_FAILED'],
  examples: { response: france },
});

/** `POST /admin/tax-rates`. */
export const createTaxRate = defineRoute({
  key: 'POST /admin/tax-rates',
  summary: 'Add a tax rate',
  description:
    'Adds a window for a country: `country` is two capital letters, `ratePercent` 0 to 100 with up to four decimals, ' +
    `\`taxType\` vat | gst | sales_tax | none, \`validFrom\` required. ${WINDOW_RULES} Audited.`,
  tags: ['refunds'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'tax:create',
  body: z.object({
    country: z.string().trim(),
    region: z.string().trim().default(''),
    ratePercent: z.string().trim(),
    taxType: z.string().trim(),
    appliesTo: z.string().trim().default('digital_services'),
    validFrom: zIsoDateTime.nullable(),
    validTo: zIsoDateTime.nullable().default(null),
    label: z.string().trim().default(''),
    ossScheme: z.string().trim().default(''),
  }),
  success: { status: 201, schema: TaxRateSchema },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'VALIDATION_FAILED'],
  examples: {
    request: {
      country: 'FR',
      region: '',
      ratePercent: '20',
      taxType: 'vat',
      appliesTo: 'digital_services',
      validFrom: '2026-04-15T00:00:00.000Z',
      validTo: null,
      label: 'France VAT',
      ossScheme: 'EU OSS',
    },
    response: france,
  },
});

/** `PATCH /admin/tax-rates/:id`. */
export const updateTaxRate = defineRoute({
  key: 'PATCH /admin/tax-rates/:id',
  summary: 'Change a tax rate',
  description: `Changes the fields sent; \`validTo: null\` clears the end. The country never changes. ${WINDOW_RULES} Audited.`,
  tags: ['refunds'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'tax:update',
  params: z.object({ id: zIdParam }),
  body: z.object({
    country: z.string().trim().optional(),
    region: z.string().trim().optional(),
    ratePercent: z.string().trim().optional(),
    taxType: z.string().trim().optional(),
    appliesTo: z.string().trim().optional(),
    validFrom: zIsoDateTime.nullable().optional(),
    validTo: zIsoDateTime.nullable().optional(),
    label: z.string().trim().optional(),
    ossScheme: z.string().trim().optional(),
  }),
  success: { status: 200, schema: TaxRateSchema },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'NOT_FOUND', 'VALIDATION_FAILED'],
  examples: {
    request: { validTo: '2027-01-01T00:00:00.000Z' },
    response: { ...france, validTo: '2027-01-01T00:00:00.000Z' },
  },
});
