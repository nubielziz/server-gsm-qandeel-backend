// Route contracts of the storefront listings (map domain H, stage 15): the "Services on sale" tab of the console, and the service picture
// of feature 22 (upload and removal, routes beyond the map). Shapes match the console's ServiceListing (docs/contract/endpoints/storefront.md,
// RESOLUTIONS b2c-7 and catalog-12, ANSWERS storefront Q1 and Q10).
import { z } from 'zod';
import {
  defineRoute,
  listQuery,
  zDecimal,
  zId,
  zIdParam,
  zIsoDateTime,
  zMoney,
  zUploadedFile,
} from '../../../common/contract';
import {
  ListingCountryField,
  ListingSortField,
  LocaleField,
  SeoDescriptionField,
  SeoTitleField,
  SlugField,
  markdown,
  oneLine,
  titleField,
} from './shared';

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
  summary: z.string().describe('One line under the title (this language).'),
  etaText: z
    .string()
    .describe('The delivery note shown instead of the service delivery time (this language); empty for none.'),
  brand: z.string().describe('Shared by every language of the service.'),
  carrier: z.string().describe('The network the service unlocks; shared by every language of the service.'),
  country: z.string().describe('ISO-2 country or empty; shared by every language of the service.'),
  sort: z.number().int().min(0).describe('The position in the shop; shared by every language of the service.'),
  seoTitle: z.string(),
  seoDescription: z.string(),
  isListed: z.boolean(),
  isFeatured: z.boolean().describe('Shared by every language of the service.'),
  listedAt: zIsoDateTime
    .nullable()
    .describe('When the listing first went on the site (set once, never reset); `null` until then.'),
  updatedAt: zIsoDateTime,
  imageUrl: z
    .string()
    .nullable()
    .describe(
      'The picture of the service, shared by every language: a root-relative `/store/v1/media/<sha256>.<ext>` path; `null` when none.',
    ),
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

/** One listing with its two Markdown bodies: what show, create and change answer (the list leaves the bodies out). */
const ListingDetail = ListingRow.extend({
  descriptionMd: z.string().describe('Markdown (this language).'),
  requirementsMd: z.string().describe('Markdown (this language).'),
});

const LISTING_EXAMPLE = {
  id: 5,
  serviceId: 5,
  locale: 'en',
  slug: 'atandt-usa-premier-unlock',
  publicTitle: 'AT&T USA Premier Unlock',
  summary: 'Unlock an AT&T iPhone.',
  etaText: '',
  brand: 'Apple',
  carrier: 'AT&T',
  country: 'US',
  sort: 2,
  seoTitle: '',
  seoDescription: '',
  isListed: true,
  isFeatured: true,
  listedAt: '2026-10-01T09:00:00.000Z',
  updatedAt: '2026-10-01T09:00:00.000Z',
  imageUrl: '/store/v1/media/9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08.webp',
  service: { id: 5, name: 'AT&T USA Premier Unlock', code: 'IMEI-ATT-USA', basePrice: '17.2800', cost: '13.5000' },
  retailPrice: '25.9900',
  floorPrice: '19.0100',
  marginPct: '48.0569',
  orders30d: 12,
  revenue30d: '311.8800',
  locked: false,
  lockedReason: null,
} as const;

const DETAIL_EXAMPLE = {
  ...LISTING_EXAMPLE,
  descriptionMd: 'We unlock the phone from the IMEI.',
  requirementsMd: '',
} as const;

/** The content fields POST and PATCH share (all optional): per language first, then the facts of the service. */
const CONTENT_FIELDS = {
  summary: oneLine(300).optional(),
  descriptionMd: markdown(20_000).optional(),
  requirementsMd: markdown(10_000).optional(),
  etaText: oneLine(80).optional(),
  seoTitle: SeoTitleField.optional(),
  seoDescription: SeoDescriptionField.optional(),
  brand: oneLine(80).optional().describe('Every language of the service.'),
  carrier: oneLine(80).optional().describe('Every language of the service.'),
  country: ListingCountryField.optional().describe('Empty or two letters; every language of the service.'),
  isFeatured: z.boolean().optional().describe('Every language of the service.'),
  sort: ListingSortField.optional().describe('Every language of the service.'),
};

/** `GET /admin/service-listings`: the listings with the service join and the figures the server works out. */
export const listListings = defineRoute({
  key: 'GET /admin/service-listings',
  summary: 'List storefront listings',
  description:
    'One row per service and language. Archived services are gone (RESOLUTIONS catalog-3). `q` is a contains over the public ' +
    'title, the slug, the service name and the service code. Filters: `isListed`, `locked` and `isFeatured`. Sorts: public title, ' +
    '`isListed`, `slug`, `id`, `listedAt` (first publication; never-listed rows last) and `sort`. The counts above the table ask ' +
    'with `_start=0&_end=1` and read `x-total-count`. Rows leave out the two Markdown bodies (`GET /admin/service-listings/:id` has them). ' +
    'Default order: public title.',
  tags: ['storefront-listings'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'storefront:read',
  query: listQuery({
    sorts: ['publicTitle', 'isListed', 'slug', 'id', 'listedAt', 'sort'],
    defaultSort: { field: 'publicTitle', order: 'asc' },
    filters: { isListed: { type: 'boolean' }, locked: { type: 'boolean' }, isFeatured: { type: 'boolean' } },
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
  description: 'The listing with its description and requirements (Markdown).',
  tags: ['storefront-listings'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'storefront:read',
  params: z.object({ id: zIdParam }),
  success: { status: 200, schema: ListingDetail },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'NOT_FOUND'],
  examples: { response: DETAIL_EXAMPLE },
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
    'the same language, or a slug already used in that language, is `409 LISTING_EXISTS` (also when two requests race). The ' +
    'content fields of `PATCH` (`summary`, `descriptionMd`, `requirementsMd`, `etaText`, `seoTitle`, `seoDescription`, and the ' +
    'service-wide `brand`, `carrier`, `country`, `isFeatured`, `sort`) may be sent too. Service-wide facts not sent are copied from ' +
    "the service's oldest listing (another language); sent ones are written to every language of the service.",
  tags: ['storefront-listings'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'storefront:create',
  body: z.object({
    serviceId: zId,
    locale: LocaleField,
    publicTitle: titleField('Enter the title customers see.'),
    slug: SlugField.optional(),
    ...CONTENT_FIELDS,
  }),
  success: { status: 201, schema: ListingDetail },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'VALIDATION_FAILED', 'LISTING_LOCKED', 'LISTING_EXISTS'],
  examples: {
    request: { serviceId: 5, locale: 'en', publicTitle: 'AT&T USA Premier Unlock' },
    response: {
      ...DETAIL_EXAMPLE,
      isListed: false,
      isFeatured: false,
      listedAt: null,
      imageUrl: null,
      retailPrice: null,
      marginPct: null,
    },
  },
});

/** `PATCH /admin/service-listings/:id`: the "On the site" switch, the retail price dialog and the content editor. */
export const updateListing = defineRoute({
  key: 'PATCH /admin/service-listings/:id',
  summary: 'Change a storefront listing',
  description:
    'Any of the fields below; at least one. `isListed` and `retailPrice` (4-decimal net USD before VAT) work as before: ' +
    '`retailPrice` writes the retail group price of the service, so it applies to the listing of every language and only to new ' +
    'storefront checkouts; a price of zero or less, or under `floorPrice`, is `422` on `retailPrice` ("Below the storefront floor ' +
    'of $X."). Switching a disabled service on is `409 SERVICE_DISABLED`; switching on or pricing a service that can never be ' +
    'public is `409 LISTING_LOCKED`. Switching off is always allowed. Switching on for the first time sets `listedAt`; it never ' +
    'resets. Content of this language only: `publicTitle`, `slug` (a form that is not lower-case words joined by hyphens is `422` ' +
    'on `slug`; one used by another listing of the language is `409 LISTING_EXISTS` on `slug`; changing it changes the public ' +
    'link), `summary`, `descriptionMd`, `requirementsMd`, `etaText`, `seoTitle`, `seoDescription`. Facts of the service, written ' +
    'to the listing of every language: `brand`, `carrier`, `country` (empty or two letters), `isFeatured`, `sort`. Every ' +
    'refusal is decided before the first write. Each change is audited (`listed on storefront`, `unlisted from storefront`, ' +
    '`changed retail price of`, `edited listing of`; the audit row keeps the length of the Markdown bodies, not their text).',
  tags: ['storefront-listings'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'storefront:update',
  params: z.object({ id: zIdParam }),
  body: z
    .object({
      isListed: z.boolean().optional(),
      retailPrice: zMoney.optional(),
      publicTitle: titleField('Enter the title customers see.').optional(),
      slug: SlugField.optional(),
      ...CONTENT_FIELDS,
    })
    .refine((body) => Object.values(body).some((value) => value !== undefined), 'Send at least one field to change.'),
  success: { status: 200, schema: ListingDetail },
  errors: [
    'UNAUTHORIZED',
    'FORBIDDEN',
    'CSRF_FAILED',
    'NOT_FOUND',
    'VALIDATION_FAILED',
    'LISTING_LOCKED',
    'LISTING_EXISTS',
    'SERVICE_DISABLED',
  ],
  examples: { request: { retailPrice: '25.9900' }, response: DETAIL_EXAMPLE },
});

/** `POST /admin/service-listings/:id/image`: upload the picture of the listing's service. */
export const uploadListingImage = defineRoute({
  key: 'POST /admin/service-listings/:id/image',
  summary: 'Upload the picture of a storefront service',
  description:
    '`multipart/form-data` with one part named `file`: a JPEG, PNG or WebP picture, at most 2 MiB, 200 to 4096 pixels on each side. ' +
    'The type is read from the content (the declared type and the file name are ignored). The picture is cleaned before it is ' +
    'stored (EXIF, XMP, IPTC, comments and text chunks are removed, anything after the end of the picture is cut) and stored once ' +
    'under the SHA-256 of the cleaned bytes. It becomes the picture of the service in every language (replacing the previous one) ' +
    'and the `imageUrl` of the answer and of the public service cards. Refusals are `422` on `file` with the code: `empty`, ' +
    '`unsupported_type`, `corrupt`, `animated`, `too_small`, `too_large_dimensions`, `rotated` (a JPEG whose EXIF turns it: save it ' +
    'upright); more than 2 MiB is `413`. A JSON or form body has no file part, so it is `422` on `file`; a body of a type the API does ' +
    'not read is `415`. Audited (`uploaded image for`).',
  tags: ['storefront-listings'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'storefront:update',
  params: z.object({ id: zIdParam }),
  bodyType: 'multipart',
  body: z.object({ file: zUploadedFile }),
  success: { status: 200, schema: ListingDetail },
  errors: [
    'UNAUTHORIZED',
    'FORBIDDEN',
    'CSRF_FAILED',
    'NOT_FOUND',
    'VALIDATION_FAILED',
    'PAYLOAD_TOO_LARGE',
    'UNSUPPORTED_MEDIA_TYPE',
    'RATE_LIMITED',
    'UNAVAILABLE',
  ],
  examples: { response: DETAIL_EXAMPLE },
});

/** `DELETE /admin/service-listings/:id/image`: remove the picture of the listing's service. */
export const removeListingImage = defineRoute({
  key: 'DELETE /admin/service-listings/:id/image',
  summary: 'Remove the picture of a storefront service',
  description:
    'The service has no picture any more, in every language (`imageUrl` becomes `null`). The stored file is kept. Answers `204` also ' +
    'when there was no picture. Audited (`removed image of`).',
  tags: ['storefront-listings'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'storefront:update',
  params: z.object({ id: zIdParam }),
  success: { status: 204 },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'NOT_FOUND'],
});
