// Route contracts of the public storefront catalog (map domain H, stage 14): the shop's configuration, the list of service pages,
// one service page and the category menu. The console has no screen for them (the storefront is another frontend): the shapes follow
// ALIGNMENT § 7 and are written up in the module README. Money is the wire's four-decimal text; amounts are in the buyer's currency.
// English only (decision 039, B224): the list, the service page and the menu take and answer no language; no `alternates`.
import { z } from 'zod';
import { defineRoute, listQuery, zDecimal, zId, zIsoDateTime, zMoney } from '../../../common/contract';
import { SERVICE_TYPES } from '../../catalog';
import { LEGAL_DOCUMENT_TYPES } from '../db/schema';

/** An ISO 3166-1 alpha-2 country code, any case in, upper case out. */
export const zCountryCode = z
  .string()
  .trim()
  .regex(/^[A-Za-z]{2}$/, 'Use a two-letter country code, like GB.')
  .transform((value) => value.toUpperCase())
  .describe('ISO 3166-1 alpha-2 country code.');

/** An ISO 4217 currency code, any case in, upper case out. */
export const zCurrencyCode = z
  .string()
  .trim()
  .regex(/^[A-Za-z]{3}$/, 'Use a three-letter currency code, like GBP.')
  .transform((value) => value.toUpperCase())
  .describe('ISO 4217 currency code.');

/** Whether a service is delivered at once from stock or processed after the order. */
export const AVAILABILITIES = ['in_stock', 'on_request'] as const;

/** A price bound of the list: decimal text, 0 or more, at most 4 decimals. */
export const PriceBound = z
  .string()
  .trim()
  .regex(/^\d{1,12}(\.\d{1,4})?$/, 'Use a number like 12.50 (at most 4 decimals).');

/** The price of one unit, in the buyer's currency, tax included in `gross`. */
export const StorefrontPriceSchema = z.object({
  currency: z.string().describe('The currency of net, tax and gross.'),
  fxRate: zDecimal.describe('Units of the currency per 1 USD, the exchange markup included (8 decimals).'),
  net: zMoney.describe('The price before tax.'),
  tax: zMoney,
  gross: zMoney.describe('What the buyer pays: net plus tax.'),
  taxRate: zDecimal.describe('The tax rate in percent (0 when the buyer gave no country or it has no tax).'),
  taxCountry: z.string().nullable().describe('The country the tax was worked out for.'),
});

/** One service card: what the list, the search results and the service page share. */
export const ServiceCardSchema = z.object({
  id: zId.describe('The service id: what `POST /store/v1/checkout-sessions` takes as `serviceId`.'),
  slug: z.string(),
  title: z.string(),
  summary: z.string(),
  brand: z.string(),
  network: z.string().describe('The carrier or network the service unlocks (empty when none).'),
  country: z.string().describe('The country the service is for (empty when none).'),
  isFeatured: z.boolean(),
  type: z.enum(SERVICE_TYPES),
  deliveryTime: z.string().describe("How long it takes, as text (English, or the supplier's own words)."),
  category: z
    .object({
      id: zId,
      slug: z.string().describe('`<id>-<words>`: only the number before the first hyphen counts.'),
      name: z.string().describe('The category name.'),
    })
    .describe('The catalog category of the service (what `GET /store/v1/categories` lists).'),
  availability: z
    .enum(AVAILABILITIES)
    .describe(
      '`in_stock`: the available inventory codes cover the smallest order, so it is delivered at once; `on_request`: processed ' +
        'after the order. Both can be bought. Never a count.',
    ),
  deliveryMinutes: z
    .number()
    .int()
    .min(1)
    .describe('The expected delivery time in minutes (the service SLA); the site formats it.'),
  etaText: z.string().describe("A delivery note that replaces `deliveryMinutes` on screen; `''` when none."),
  listedAt: zIsoDateTime
    .nullable()
    .describe('When the page first went on the site; never resets. `null` for pages from before it was recorded.'),
  imageUrl: z
    .string()
    .nullable()
    .describe(
      'The picture of the service: a root-relative path `/store/v1/media/<sha256>.<jpg|png|webp>` (immutable, cached for a year); ' +
        '`null` when it has none (show the picture of the service type).',
    ),
  price: StorefrontPriceSchema,
});

const FieldSchema = z.object({
  key: z.string(),
  label: z.string(),
  fieldType: z
    .enum(['text', 'number', 'select', 'textarea', 'imei'])
    .describe(
      '`imei` holds one IMEI: read as digits (spaces and dashes removed), 15 digits with a valid Luhn check digit (else ' +
        '`422 INVALID_IMEI`, code `invalid_imei` on `inputs.<key>`).',
    ),
  options: z.array(z.string()).describe('The choices of a `select` field.'),
  required: z.boolean(),
  isMainInput: z
    .boolean()
    .describe(
      "The service's main input (at most one field): its value is what the supplier receives as the IMEI. It is judged like any " +
        'other field, by its own type (an IMEI only for the type `imei`), `required` and pattern.',
    ),
});

const ServicePageSchema = ServiceCardSchema.extend({
  descriptionMd: z.string().describe('Markdown.'),
  requirementsMd: z.string().describe('Markdown.'),
  seoTitle: z.string(),
  seoDescription: z.string(),
  quantity: z.object({
    min: z.number().int(),
    max: z.number().int(),
    options: z.array(z.number().int()).describe('Fixed packs; empty means any quantity from min to max.'),
  }),
  fields: z
    .array(FieldSchema)
    .describe(
      'Everything the order form asks for, in form order: the form draws only these fields. On an IMEI service the IMEI is typed into ' +
        'the field with `isMainInput` (a service without one takes the IMEI as `imei`).',
    ),
  faqs: z.array(z.object({ question: z.string(), answerMd: z.string() })),
});

const PRICE_EXAMPLE = {
  currency: 'GBP',
  fxRate: '0.80185000',
  net: '3.2000',
  tax: '0.6400',
  gross: '3.8400',
  taxRate: '20.0000',
  taxCountry: 'GB',
} as const;

const CARD_EXAMPLE = {
  id: 1,
  slug: 'icloud-clean-lost-check',
  title: 'iCloud Clean / Lost Check',
  summary: 'Find out if the phone is clean before you buy.',
  brand: 'Apple',
  network: '',
  country: '',
  isFeatured: true,
  type: 'imei',
  deliveryTime: '2 minutes',
  category: { id: 1, slug: '1-apple', name: 'Apple' },
  availability: 'on_request',
  deliveryMinutes: 2,
  etaText: '',
  listedAt: '2026-10-01T09:00:00.000Z',
  imageUrl: '/store/v1/media/9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08.webp',
  price: PRICE_EXAMPLE,
} as const;

/** The buyer's country, region and currency every priced public route takes. */
export const BUYER_QUERY = {
  buyerCountry: zCountryCode
    .optional()
    .describe("The buyer's country: the tax of its window is added. Without it no tax is added."),
  region: z
    .string()
    .trim()
    .min(1)
    .max(60)
    .optional()
    .describe("The buyer's region, for the countries that tax by region."),
  currency: zCurrencyCode
    .optional()
    .describe('The currency to show prices in (one `GET /store/v1/config` lists). Default: USD.'),
};

/** `GET /store/v1/config`. */
export const getStoreConfig = defineRoute({
  key: 'GET /store/v1/config',
  summary: 'Storefront configuration',
  description:
    'What the storefront needs to start: the currencies on offer with their exchange rate (the markup included), the tax windows in ' +
    'force today (a country without one has no tax), the payment methods that are on, the policy switches (`guestCheckout`, ' +
    '`withdrawalWaiver`) and the current version of each legal document. Public; answers may be cached by the ' +
    'browser for 30 seconds. A currency whose rate is older than `fx.max_rate_age_hours` (default 48), or held by a refresh, is not ' +
    'on offer (decision 049).',
  tags: ['storefront'],
  surface: 'store',
  access: 'public',
  success: {
    status: 200,
    schema: z.object({
      baseCurrency: z.string(),
      currencies: z.array(
        z.object({
          code: z.string(),
          name: z.string(),
          decimals: z.number().int().min(0).max(4),
          fxRate: zDecimal.describe('Units per 1 USD with the markup, 8 decimals.'),
        }),
      ),
      taxRates: z.array(
        z.object({
          country: z.string(),
          region: z.string().describe('Empty for the whole country.'),
          ratePercent: zDecimal,
          taxType: z.string(),
          label: z.string(),
        }),
      ),
      paymentMethods: z.array(
        z.object({
          code: z.string(),
          name: z.string(),
          supports3ds: z.boolean(),
          preset: z
            .string()
            .nullable()
            .describe('The key of the ready-made method it was made from; null for a custom method (feature 32).'),
          logoUrl: z
            .string()
            .nullable()
            .describe(
              'The public path of the logo staff uploaded; null when none, then show the bundled logo of `preset` (feature 32).',
            ),
        }),
      ),
      policies: z.object({ guestCheckout: z.boolean(), withdrawalWaiver: z.boolean() }),
      legalDocuments: z.array(
        z.object({
          type: z.enum(LEGAL_DOCUMENT_TYPES),
          version: z.string(),
          effectiveFrom: zIsoDateTime.nullable(),
        }),
      ),
    }),
  },
  errors: [],
  examples: {
    response: {
      baseCurrency: 'USD',
      currencies: [
        { code: 'USD', name: 'US dollar', decimals: 2, fxRate: '1.00000000' },
        { code: 'GBP', name: 'British pound', decimals: 2, fxRate: '0.80185000' },
      ],
      taxRates: [{ country: 'GB', region: '', ratePercent: '20.0000', taxType: 'vat', label: 'UK VAT' }],
      paymentMethods: [{ code: 'card', name: 'Card gateway', supports3ds: true, preset: null, logoUrl: null }],
      policies: { guestCheckout: true, withdrawalWaiver: true },
      legalDocuments: [{ type: 'terms', version: '3.2', effectiveFrom: '2025-11-22T12:00:00.000Z' }],
    },
  },
});

/** The list dialect of the public service list. */
const SERVICE_LIST_QUERY = listQuery({
  sorts: ['relevance', 'featured', 'sort', 'title', 'popular', 'listedAt', 'price'],
  // `relevance` leads the default order but means something only with `q` when the search engine answers; without it (no `q`, the
  // engine down) it is skipped and the order is the staff's, exactly as before feature 29.
  defaultSort: [
    { field: 'relevance', order: 'desc' },
    { field: 'featured', order: 'desc' },
    { field: 'sort', order: 'asc' },
    { field: 'title', order: 'asc' },
  ],
  filters: {
    brand: { type: 'string', ops: ['eq'] },
    network: { type: 'string', ops: ['eq'] },
    country: { type: 'string', ops: ['eq'] },
    featured: { type: 'boolean', ops: ['eq'] },
    type: { type: 'enum', values: SERVICE_TYPES, ops: ['eq'] },
    categoryId: { type: 'id', ops: ['eq'] },
    availability: { type: 'enum', values: AVAILABILITIES, ops: ['eq'] },
  },
  search: ['title', 'summary', 'brand', 'network'],
  maxPage: 100,
  extra: {
    ...BUYER_QUERY,
    minPrice: PriceBound.optional().describe('Lowest `price.gross` to show (inclusive), in `currency`.'),
    maxPrice: PriceBound.optional().describe(
      'Highest `price.gross` to show (inclusive), in `currency`. Not below `minPrice`.',
    ),
  },
});

/** `GET /store/v1/services`. */
export const listStoreServices = defineRoute({
  key: 'GET /store/v1/services',
  summary: 'List the services on sale',
  description:
    "The service pages that are switched on, at the retail price: `net` before tax, `tax` of the buyer's country and `gross`, in the " +
    "buyer's currency (`buyerCountry`, `currency`). Only services the shop may sell and has priced appear (an archived, disabled or " +
    'B2B-only service never does, and the price is never under the retail floor). Filter by `brand`, `network` and `country` ' +
    '(case-insensitive), `featured`, `type` (`imei`, `server`, `remote`, `file`; repeat the key for several), ' +
    '`categoryId` (repeatable) and `availability` (`in_stock` keeps the services the stock covers); `minPrice` and `maxPrice` bound ' +
    '`price.gross` in the requested `currency` (inclusive; `minPrice` above `maxPrice` is `422` on `maxPrice`); `q` searches title, ' +
    'summary, brand and network; sort by `featured` (default: featured first), `sort`, `title`, `popular` (best sellers: the ' +
    'orders of the last 30 days, refreshed every 30 minutes, no number is shown), `listedAt` (first publication), `price` ' +
    '(`gross`, in the requested currency) and `relevance` (how well the service matches `q`; the default order while `q` is set, ' +
    'ignored otherwise). With `q` the order and the match set come from the search engine, which forgives typos and knows ' +
    'synonyms; `x-search-engine: typesense|fallback` says which answered, and with a price sort or price ' +
    'bounds the set is the best 1000 matches (`x-search-truncated: true` when more matched). Pages of up to 100 rows with ' +
    '`x-total-count`. Public; cacheable for 30 seconds.',
  tags: ['storefront'],
  surface: 'store',
  access: 'public',
  query: SERVICE_LIST_QUERY,
  success: { status: 200, schema: ServiceCardSchema },
  errors: ['VALIDATION_FAILED'],
  examples: { response: [CARD_EXAMPLE] },
});

/** `GET /store/v1/services/:slug`. */
export const showStoreService = defineRoute({
  key: 'GET /store/v1/services/:slug',
  summary: 'Show a service page',
  description:
    'One service page by slug: description, delivery time, what the order form asks for, the quantities, the published FAQs of the ' +
    'service and its retail price (see the list). `404` when the page does not exist, is switched off, or the service cannot be ' +
    'sold. Public; cacheable for 30 seconds.',
  tags: ['storefront'],
  surface: 'store',
  access: 'public',
  params: z.object({ slug: z.string().trim().min(1).max(200) }),
  query: z.object(BUYER_QUERY),
  success: { status: 200, schema: ServicePageSchema },
  errors: ['NOT_FOUND', 'VALIDATION_FAILED'],
  examples: {
    response: {
      ...CARD_EXAMPLE,
      descriptionMd: 'We check iCloud and Find My status from the IMEI.',
      etaText: 'Usually 2 minutes',
      requirementsMd: 'The 15-digit IMEI of the phone (dial *#06#).',
      seoTitle: 'iCloud Clean / Lost Check',
      seoDescription: 'Check iCloud status from the IMEI.',
      quantity: { min: 1, max: 1, options: [] },
      fields: [{ key: 'imei', label: 'IMEI', fieldType: 'imei', options: [], required: true, isMainInput: true }],
      faqs: [{ question: 'How fast is it?', answerMd: 'Most checks finish in two minutes.' }],
    },
  },
});

/** The categories of the storefront menu. */
const StoreCategorySchema = z.object({
  id: zId,
  slug: z.string().describe('`<id>-<words>`: only the number before the first hyphen counts.'),
  name: z.string(),
  type: z.enum(SERVICE_TYPES),
  serviceCount: z.number().int().min(1).describe('Services with a switched-on page that can be bought now.'),
});

/** `GET /store/v1/categories`. */
export const listStoreCategories = defineRoute({
  key: 'GET /store/v1/categories',
  summary: 'List the storefront categories',
  description:
    'The catalog categories that hold at least one service the shop sells: a switched-on page, a service that may be sold and a ' +
    'retail price. `serviceCount` equals `x-total-count` of `GET /store/v1/services` filtered by `categoryId`. In category order ' +
    '(the staff `sort`), at most 500. Public; cacheable for 30 seconds.',
  tags: ['storefront'],
  surface: 'store',
  access: 'public',
  success: {
    status: 200,
    schema: z.object({ categories: z.array(StoreCategorySchema) }),
  },
  errors: [],
  examples: {
    response: {
      categories: [{ id: 1, slug: '1-apple', name: 'Apple', type: 'imei', serviceCount: 12 }],
    },
  },
});
