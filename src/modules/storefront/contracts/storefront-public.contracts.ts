// Route contracts of the public storefront catalog (map domain H, stage 14): the shop's configuration, the list of service pages
// and one service page. The console has no screen for them (the storefront is another frontend): the shapes follow ALIGNMENT § 7
// and are written up in the module README. Money is the wire's four-decimal text; amounts are in the buyer's currency.
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

/** The languages of the storefront. */
export const STOREFRONT_LOCALES = ['en', 'ar'] as const;

/** A service page language. */
export const zLocale = z.enum(STOREFRONT_LOCALES);

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

const ServiceCardSchema = z.object({
  id: zId.describe('The service id: what `POST /store/v1/checkout-sessions` takes as `serviceId`.'),
  slug: z.string(),
  locale: zLocale,
  title: z.string(),
  summary: z.string(),
  brand: z.string(),
  network: z.string().describe('The carrier or network the service unlocks (empty when none).'),
  country: z.string().describe('The country the service is for (empty when none).'),
  isFeatured: z.boolean(),
  type: z.enum(SERVICE_TYPES),
  deliveryTime: z.string().describe('How long it takes, as text.'),
  price: StorefrontPriceSchema,
});

const FieldSchema = z.object({
  key: z.string(),
  label: z.string(),
  fieldType: z.enum(['text', 'number', 'select', 'textarea']),
  options: z.array(z.string()).describe('The choices of a `select` field.'),
  required: z.boolean(),
});

const ServicePageSchema = ServiceCardSchema.extend({
  descriptionMd: z.string().describe('Markdown.'),
  etaText: z.string(),
  requirementsMd: z.string().describe('Markdown.'),
  seoTitle: z.string(),
  seoDescription: z.string(),
  quantity: z.object({
    min: z.number().int(),
    max: z.number().int(),
    options: z.array(z.number().int()).describe('Fixed packs; empty means any quantity from min to max.'),
  }),
  fields: z.array(FieldSchema).describe('What the order form asks for besides the IMEI.'),
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
  locale: 'en',
  title: 'iCloud Clean / Lost Check',
  summary: 'Find out if the phone is clean before you buy.',
  brand: 'Apple',
  network: '',
  country: '',
  isFeatured: true,
  type: 'imei',
  deliveryTime: '2 minutes',
  price: PRICE_EXAMPLE,
} as const;

const BUYER_QUERY = {
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
    '`withdrawalWaiver`, `imeiPrecheck`) and the current version of each legal document. Public; answers may be cached by the ' +
    'browser for 30 seconds.',
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
      paymentMethods: z.array(z.object({ code: z.string(), name: z.string(), supports3ds: z.boolean() })),
      policies: z.object({ guestCheckout: z.boolean(), withdrawalWaiver: z.boolean(), imeiPrecheck: z.boolean() }),
      legalDocuments: z.array(
        z.object({
          type: z.enum(LEGAL_DOCUMENT_TYPES),
          version: z.string(),
          locale: z.string(),
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
      paymentMethods: [{ code: 'card', name: 'Card gateway', supports3ds: true }],
      policies: { guestCheckout: true, withdrawalWaiver: true, imeiPrecheck: true },
      legalDocuments: [{ type: 'terms', version: '3.2', locale: 'en', effectiveFrom: '2025-11-22T12:00:00.000Z' }],
    },
  },
});

/** The list dialect of the public service list. */
const SERVICE_LIST_QUERY = listQuery({
  sorts: ['featured', 'sort', 'title'],
  defaultSort: [
    { field: 'featured', order: 'desc' },
    { field: 'sort', order: 'asc' },
    { field: 'title', order: 'asc' },
  ],
  filters: {
    brand: { type: 'string', ops: ['eq'] },
    network: { type: 'string', ops: ['eq'] },
    country: { type: 'string', ops: ['eq'] },
    featured: { type: 'boolean', ops: ['eq'] },
    locale: { type: 'enum', values: STOREFRONT_LOCALES, ops: ['eq'] },
  },
  search: ['title', 'summary', 'brand', 'network'],
  maxPage: 100,
  extra: BUYER_QUERY,
});

/** `GET /store/v1/services`. */
export const listStoreServices = defineRoute({
  key: 'GET /store/v1/services',
  summary: 'List the services on sale',
  description:
    "The service pages that are switched on, at the retail price: `net` before tax, `tax` of the buyer's country and `gross`, in the " +
    "buyer's currency (`buyerCountry`, `currency`). Only services the shop may sell and has priced appear (an archived, disabled or " +
    'B2B-only service never does, and the price is never under the retail floor). Filter by `brand`, `network` and `country` ' +
    '(case-insensitive), `featured` and `locale` (default `en`); `q` searches title, summary, brand and network; sort by `featured` ' +
    '(default: featured first), `sort` and `title`; pages of up to 100 rows with `x-total-count`. Public; cacheable for 30 seconds.',
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
    'One service page by slug and language: description, delivery time, what the order form asks for, the quantities, the published ' +
    'FAQs of the service and its retail price (see the list). `404` when the page does not exist, is switched off, or the service ' +
    'cannot be sold. Public; cacheable for 30 seconds.',
  tags: ['storefront'],
  surface: 'store',
  access: 'public',
  params: z.object({ slug: z.string().trim().min(1).max(200) }),
  query: z.object({ locale: zLocale.optional(), ...BUYER_QUERY }),
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
      fields: [],
      faqs: [{ question: 'How fast is it?', answerMd: 'Most checks finish in two minutes.' }],
    },
  },
});
