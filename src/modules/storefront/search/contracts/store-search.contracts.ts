// Route contracts of the public storefront search (feature 29, decision 038, plan sections 5.1-5.3): the search-as-you-type route and the
// results page. English only: the engine holds English listings; `/ar` pages keep `GET /store/v1/services`. Prices are the cards' prices
// (never from the engine); amounts are in the buyer's currency.
import { z } from 'zod';
import { defineRoute, zId, zMoney } from '../../../../common/contract';
import { SERVICE_TYPES } from '../../../catalog';
import {
  AVAILABILITIES,
  BUYER_QUERY,
  PriceBound,
  ServiceCardSchema,
  zCountryCode,
} from '../../contracts/storefront-public.contracts';
import { MAX_QUERY_LENGTH, normaliseText } from '../domain/normalise';
import { TERM_KINDS } from '../domain/terms';

/** The results page's sorts. */
export const SEARCH_SORTS = ['relevance', 'popular', 'title', 'listedAt', 'price'] as const;

// eslint-disable-next-line no-control-regex -- matching control characters is the point of this pattern
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/g;

/**
 * What a visitor typed: control characters dropped, at most 100 characters once normalised.
 *
 * Why: plan section 5.2: a NUL byte or a tab in the query is not an error (the typed text is cleaned), but a text that is longer than the
 * cap after cleaning is refused (`422`), so a pasted page cannot become an engine query. The raw text (trailing space included) is kept:
 * the ghost needs it.
 */
const TypedText = z
  .string()
  .transform((text) => text.replace(CONTROL_CHARACTERS, ' '))
  .refine((text) => normaliseText(text).length <= MAX_QUERY_LENGTH, {
    message: `Use at most ${MAX_QUERY_LENGTH} characters.`,
  });

/** A key the query string may repeat (`brand=a&brand=b`), always read as a list of at most 20 values. */
const repeatable = <T extends z.ZodType>(item: T) =>
  z
    .union([item, z.array(item).max(20)])
    .optional()
    .transform((value): Array<z.output<T>> => (value === undefined ? [] : Array.isArray(value) ? value : [value]));

const Currency = z.object({ currency: BUYER_QUERY.currency });

/** The search-as-you-type answer. */
const SuggestSchema = z.object({
  q: z.string().describe('The typed text as the engine read it (normalised, at most 100 characters).'),
  engine: z
    .enum(['typesense', 'fallback'])
    .describe('`fallback`: the simple database search answered (the engine is off or down).'),
  ghost: z
    .string()
    .nullable()
    .describe(
      'The rest of the word being typed (`icl` gives `oud`), to draw after the input; `null` when nothing continues the text and on fallback.',
    ),
  completions: z
    .array(z.object({ text: z.string(), kind: z.enum(TERM_KINDS) }))
    .max(6)
    .describe('Phrases that complete what was typed, best first.'),
  services: z
    .array(
      z.object({
        id: zId,
        slug: z.string(),
        title: z.string(),
        titleHighlight: z
          .string()
          .describe('The title as HTML with `<mark>` around matched words; every other character is escaped.'),
        brand: z.string(),
        network: z.string(),
        type: z.enum(SERVICE_TYPES),
        category: z.object({ id: zId, name: z.string() }),
        imageUrl: z.string().nullable(),
        availability: z.enum(AVAILABILITIES),
        price: z.object({ currency: z.string(), net: zMoney, gross: zMoney }),
      }),
    )
    .max(6)
    .describe(
      'The best matches, then nearby services (similar words, drop a word, a typo), priced like the cards without tax.',
    ),
  filters: z
    .array(
      z.object({
        kind: z.enum(['brand', 'network', 'country', 'category']),
        value: z
          .string()
          .describe('What the list filter takes: the name (brand, network), the country code, the category id.'),
        label: z.string().describe('`Brand: Samsung`, `Network: Vodafone`, `Country: United Kingdom`.'),
        count: z.number().int().min(0),
      }),
    )
    .max(4),
  didYouMean: z.string().nullable(),
  popular: z.array(z.string()).max(8).describe('Popular searches, only while the text is empty.'),
  intent: z.enum(['imei']).nullable().describe('`imei`: the text is an IMEI: offer the IMEI check, no search ran.'),
});

/** `GET /store/v1/search/suggest`. */
export const suggestStoreSearch = defineRoute({
  key: 'GET /store/v1/search/suggest',
  summary: 'Search as you type',
  description:
    'What the shop header shows while a visitor types (English pages): the rest of the word (`ghost`), phrases that complete the ' +
    'text, up to six services (the best matches first, then nearby ones, priced before tax in `currency`), filter chips, a ' +
    '"did you mean" and, for an empty text, the popular searches. An IMEI (15 digits with a valid check, or 16) is an `intent`, not a ' +
    'search. Every service is checked against the database before it is shown and prices never come from the engine. When the ' +
    'engine is off or down the answer is `engine: fallback` with popular phrases only (status 200, never an error). Counted per client ' +
    'IP at 1200 a minute (`search-suggest`). Public; cacheable for 30 seconds.',
  tags: ['storefront'],
  surface: 'store',
  access: 'public',
  query: z.object({ q: TypedText.default(''), ...Currency.shape }).strict(),
  success: { status: 200, schema: SuggestSchema },
  errors: ['VALIDATION_FAILED', 'RATE_LIMITED'],
  examples: {
    response: {
      q: 'samsung fr',
      engine: 'typesense',
      ghost: 'p',
      completions: [
        { text: 'samsung frp', kind: 'title' },
        { text: 'samsung frp bypass', kind: 'title' },
      ],
      services: [
        {
          id: 1,
          slug: 'samsung-frp-bypass',
          title: 'Samsung FRP Bypass',
          titleHighlight: '<mark>Samsung</mark> <mark>FRP</mark> Bypass',
          brand: 'Samsung',
          network: '',
          type: 'remote',
          category: { id: 1, name: 'Samsung Services' },
          imageUrl: null,
          availability: 'on_request',
          price: { currency: 'USD', net: '5.0000', gross: '5.0000' },
        },
      ],
      filters: [{ kind: 'brand', value: 'Samsung', label: 'Brand: Samsung', count: 12 }],
      didYouMean: null,
      popular: [],
      intent: null,
    },
  },
});

const FacetCount = z.object({ value: z.string(), count: z.number().int().min(0) });

/** The results page's answer. */
const SearchPageSchema = z.object({
  q: z.string(),
  engine: z.enum(['typesense', 'fallback']),
  total: z.number().int().min(0).describe('How many services matched (the best 1000 when `truncated`).'),
  truncated: z
    .boolean()
    .describe('More than 1000 matched and the answer is a price sort or price bounds over the best 1000.'),
  page: z.number().int().min(1),
  perPage: z.number().int().min(1),
  hits: z.array(ServiceCardSchema).describe('The exact card of `GET /store/v1/services`.'),
  facets: z
    .object({
      brand: z.array(FacetCount).describe('`value` is the display name; spellings that differ in case are one entry.'),
      network: z.array(FacetCount),
      country: z.array(FacetCount).describe('`value` is the ISO-2 code.'),
      category: z.array(z.object({ id: zId, name: z.string(), count: z.number().int().min(0) })),
      type: z.array(FacetCount),
      availability: z.object({ in_stock: z.number().int().min(0), on_request: z.number().int().min(0) }),
    })
    .nullable()
    .describe("The counts per filter, each ignoring its own group's selection (page 1); `null` on fallback."),
  priceRange: z
    .object({ min: zMoney, max: zMoney })
    .nullable()
    .describe('The lowest and highest `price.gross` of the matches, page 1 only and only when at most 1000 matched.'),
  didYouMean: z.string().nullable(),
  intent: z.enum(['imei']).nullable(),
});

/** `GET /store/v1/search`. */
export const searchStore = defineRoute({
  key: 'GET /store/v1/search',
  summary: 'Search the services (results page)',
  description:
    'The results page of an English search: the services that match `q` (typos, synonyms, model codes, staff pins), their facet counts and ' +
    'the price span. `brand`, `network`, `country`, `categoryId` and `type` repeat; `availability`, `featured`, `sort` ' +
    '(`relevance` default, `popular`, `title`, `listedAt`, `price`) and `order` take one value. `minPrice`, `maxPrice` and the price ' +
    'sort work over the best 1000 matches (`truncated`). Every hit is checked against the database and priced by the same code as ' +
    '`GET /store/v1/services`. When the engine is off or down the answer is the simple database search with `engine: fallback` and ' +
    '`facets: null`. Public; cacheable for 30 seconds. Header `x-search-engine: typesense|fallback`.',
  tags: ['storefront'],
  surface: 'store',
  access: 'public',
  query: z
    .object({
      q: TypedText.refine((text) => normaliseText(text) !== '', { message: 'Enter something to search for.' }),
      page: z.coerce.number().int().min(1).max(50).default(1),
      perPage: z.coerce.number().int().min(1).max(48).default(24),
      brand: repeatable(z.string().trim().min(1).max(200)),
      network: repeatable(z.string().trim().min(1).max(200)),
      country: repeatable(zCountryCode),
      categoryId: repeatable(z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER)),
      type: repeatable(z.enum(SERVICE_TYPES)),
      availability: z.enum(AVAILABILITIES).optional(),
      featured: z
        .enum(['true', 'false'])
        .transform((value) => value === 'true')
        .optional(),
      sort: z.enum(SEARCH_SORTS).default('relevance'),
      order: z.enum(['asc', 'desc']).optional(),
      ...BUYER_QUERY,
      minPrice: PriceBound.optional().describe('Lowest `price.gross` to show (inclusive), in `currency`.'),
      maxPrice: PriceBound.optional().describe(
        'Highest `price.gross` to show (inclusive), in `currency`. Not below `minPrice`.',
      ),
    })
    .strict(),
  success: { status: 200, schema: SearchPageSchema },
  errors: ['VALIDATION_FAILED', 'RATE_LIMITED'],
  examples: {
    response: {
      q: 'samsung frp',
      engine: 'typesense',
      total: 0,
      truncated: false,
      page: 1,
      perPage: 24,
      hits: [],
      facets: {
        brand: [{ value: 'Samsung', count: 3 }],
        network: [],
        country: [],
        category: [{ id: 1, name: 'Samsung Services', count: 3 }],
        type: [{ value: 'remote', count: 3 }],
        availability: { in_stock: 0, on_request: 3 },
      },
      priceRange: null,
      didYouMean: null,
      intent: null,
    },
  },
});
