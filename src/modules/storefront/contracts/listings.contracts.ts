// Route contracts of the storefront listings (map domain H, stage 15): the "Services on sale" tab of the console. Shapes match
// the console's ServiceListing (docs/contract/endpoints/storefront.md, RESOLUTIONS b2c-7 and catalog-12, ANSWERS storefront Q1 and Q10).
import { z } from 'zod';
import { defineRoute, listQuery, zDecimal, zId, zIdParam, zMoney } from '../../../common/contract';
import { LocaleField, SlugField, titleField } from './shared';

/** The service behind a listing: the figures the table shows next to the retail price. */
const ListingService = z.object({
  id: zId,
  name: z.string(),
  code: z.string(),
  basePrice: zMoney.describe('The B2B base price merchants pay.'),
  cost: zMoney.describe('The effective cost (RESOLUTIONS catalog-1), so cost, `marginPct` and `floorPrice` agree.'),
});

/** A listing as the console reads it. */
const ListingRow = z.object({
  id: zId,
  serviceId: zId,
  locale: z.string(),
  slug: z.string(),
  publicTitle: z.string(),
  isListed: z.boolean(),
  isFeatured: z.boolean(),
  service: ListingService,
  retailPrice: zMoney
    .nullable()
    .describe('The storefront price of the service, net USD before VAT, shared by every language; `null` when unset.'),
  floorPrice: zMoney.describe(
    'The lowest retail price accepted: `max(round(basePrice x 1.10, 2), effective cost + minimum profit)` for the retail group.',
  ),
  marginPct: zDecimal
    .nullable()
    .describe('`(retail - cost) / retail x 100`, 4 decimals; `null` without a retail price.'),
  orders30d: z.number().int().min(0).describe("The service's non-rejected storefront orders of the last 30 days."),
  revenue30d: zMoney.describe('Their net `total_price`.'),
  locked: z.boolean().describe('The service can never be public: its category is B2B only, or it is disabled.'),
  lockedReason: z.string().nullable(),
});

const LISTING_EXAMPLE = {
  id: 5,
  serviceId: 5,
  locale: 'en',
  slug: 'atandt-usa-premier-unlock',
  publicTitle: 'AT&T USA Premier Unlock',
  isListed: true,
  isFeatured: true,
  service: { id: 5, name: 'AT&T USA Premier Unlock', code: 'IMEI-ATT-USA', basePrice: '17.2800', cost: '13.5000' },
  retailPrice: '25.9900',
  floorPrice: '19.0100',
  marginPct: '48.0569',
  orders30d: 12,
  revenue30d: '311.8800',
  locked: false,
  lockedReason: null,
} as const;

/** `GET /admin/service-listings`: the listings with the service join and the figures the server works out. */
export const listListings = defineRoute({
  key: 'GET /admin/service-listings',
  summary: 'List storefront listings',
  description:
    'One row per service and language. Archived services are gone (RESOLUTIONS catalog-3). `q` is a contains over the public ' +
    'title, the slug, the service name and the service code. Filters: `isListed` and `locked`. The counts above the table ask ' +
    'with `_start=0&_end=1` and read `x-total-count`. Default order: public title.',
  tags: ['storefront-listings'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'storefront:read',
  query: listQuery({
    sorts: ['publicTitle', 'isListed', 'slug', 'id'],
    defaultSort: { field: 'publicTitle', order: 'asc' },
    filters: { isListed: { type: 'boolean' }, locked: { type: 'boolean' } },
    search: ['publicTitle', 'slug', 'service.name', 'service.code'],
  }),
  success: { status: 200, schema: ListingRow },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'VALIDATION_FAILED'],
  examples: { response: [LISTING_EXAMPLE] },
});

/** `GET /admin/service-listings/:id`: one listing. */
export const showListing = defineRoute({
  key: 'GET /admin/service-listings/:id',
  summary: 'Show a storefront listing',
  tags: ['storefront-listings'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'storefront:read',
  params: z.object({ id: zIdParam }),
  success: { status: 200, schema: ListingRow },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'NOT_FOUND'],
  examples: { response: LISTING_EXAMPLE },
});

/** `POST /admin/service-listings`: put a service on the storefront page list in one language (not yet on the site). */
export const createListing = defineRoute({
  key: 'POST /admin/service-listings',
  summary: 'Create a storefront listing',
  description:
    'A new listing is not on the site yet (`isListed` false) and not featured. Without `slug` the server makes one from the ' +
    'title (lower case, `&` becomes `and`, other characters become `-`); a typed slug must already be lower-case words ' +
    'joined by hyphens. `serviceId` that names no live service (or an archived one) is `422` on `serviceId`. A service that ' +
    'can never be public (B2B only category, or disabled) is `409 LISTING_LOCKED`. A second listing of the same service in ' +
    'the same language, or a slug already used in that language, is `409 LISTING_EXISTS` (also when two requests race).',
  tags: ['storefront-listings'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'storefront:create',
  body: z.object({
    serviceId: zId,
    locale: LocaleField,
    publicTitle: titleField('Enter the title customers see.'),
    slug: SlugField.optional(),
  }),
  success: { status: 201, schema: ListingRow },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'VALIDATION_FAILED', 'LISTING_LOCKED', 'LISTING_EXISTS'],
  examples: {
    request: { serviceId: 5, locale: 'en', publicTitle: 'AT&T USA Premier Unlock' },
    response: { ...LISTING_EXAMPLE, isListed: false, isFeatured: false, retailPrice: null, marginPct: null },
  },
});

/** `PATCH /admin/service-listings/:id`: the "On the site" switch and the retail price dialog. */
export const updateListing = defineRoute({
  key: 'PATCH /admin/service-listings/:id',
  summary: 'Change a storefront listing',
  description:
    'Any of `isListed` and `retailPrice` (4-decimal net USD before VAT). `retailPrice` writes the retail group price of the ' +
    'service, so it applies to the listing of every language and only to new storefront checkouts; a price of zero or less, or ' +
    'under `floorPrice`, is `422` on `retailPrice` ("Below the storefront floor of $X."). Switching a disabled service on is ' +
    '`409 SERVICE_DISABLED`; switching on or pricing a service that can never be public is `409 LISTING_LOCKED`. Switching off ' +
    'is always allowed. Each change is audited (`listed on storefront`, `unlisted from storefront`, `changed retail price of`).',
  tags: ['storefront-listings'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'storefront:update',
  params: z.object({ id: zIdParam }),
  body: z
    .object({ isListed: z.boolean().optional(), retailPrice: zMoney.optional() })
    .refine(
      (body) => body.isListed !== undefined || body.retailPrice !== undefined,
      'Send at least one field to change.',
    ),
  success: { status: 200, schema: ListingRow },
  errors: [
    'UNAUTHORIZED',
    'FORBIDDEN',
    'CSRF_FAILED',
    'NOT_FOUND',
    'VALIDATION_FAILED',
    'LISTING_LOCKED',
    'SERVICE_DISABLED',
  ],
  examples: { request: { retailPrice: '25.9900' }, response: LISTING_EXAMPLE },
});
