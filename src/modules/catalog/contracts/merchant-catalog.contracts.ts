// Route contracts of the merchant catalog (map domain B, routes /client/services and /client/prices/export, stage 4): the
// services the signed-in merchant may buy at its own prices, the field schema of one service for the order form, and its price
// list as a CSV file. The console has no screen for these (the merchant portal is another frontend): the shapes follow
// ALIGNMENT § 7 and RESOLUTIONS catalog-3 and -4, and are written up in the module README.
import { z } from 'zod';
import { defineRoute, listQuery, zId, zIdParam, zMoney } from '../../../common/contract';
import { SERVICE_FIELD_TYPES, SERVICE_OPTION_LISTS, SERVICE_TYPES } from '../db/schema';
import { NamedRef } from './shared';

/** A service at the merchant's price. Cost, floor, margin and supplier details are never sent to a merchant. */
export const CatalogRow = z.object({
  id: zId,
  name: z.string(),
  code: z.string(),
  type: z.enum(SERVICE_TYPES),
  category: NamedRef,
  price: zMoney.describe(
    'What this merchant pays: its client price, group price or the base price after rules, discount, rounding and floor.',
  ),
  currency: z.string().describe('The currency of `price`: `USD`.'),
  deliveryTime: z.string().describe('Display text such as `15 min` or `2 hours`.'),
  slaMinutes: z.number().int().min(1),
  info: z.string(),
  minQty: z.number().int().min(1),
  maxQty: z.number().int().min(1),
  qtyOptions: z
    .array(z.number().int())
    .describe('The quantities offered when the service sells fixed packs; empty otherwise.'),
});

/** The most service ids one `GET /client/services` request may name in `ids`. */
export const CLIENT_SERVICE_IDS_LIMIT = 100;

/**
 * The `ids` parameter of `GET /client/services`: a comma-separated list of service ids, at most {@link CLIENT_SERVICE_IDS_LIMIT}.
 *
 * Why: the shop shows a merchant its own prices on the normal pages and asks for the services visible on one page in a single call,
 * without reading the whole catalog (decision 066).
 *
 * Each piece must be a positive whole number written without spaces; an empty value, an empty piece, a repeated key and a longer list are
 * refused with the usual `422 VALIDATION_FAILED` on `ids`. A repeated id counts once.
 */
const ServiceIdList = z
  .string('Send the ids as one comma-separated value, such as ids=5,9,12.')
  .transform((text, ctx) => {
    const pieces = text.split(',');
    if (pieces.length > CLIENT_SERVICE_IDS_LIMIT) {
      ctx.addIssue({ code: 'custom', message: `Send at most ${CLIENT_SERVICE_IDS_LIMIT} ids.` });
      return z.NEVER;
    }
    const ids: number[] = [];
    for (const piece of pieces) {
      const id = zIdParam.safeParse(piece);
      if (!id.success) {
        ctx.addIssue({ code: 'custom', message: 'Must be comma-separated service ids: positive whole numbers.' });
        return z.NEVER;
      }
      ids.push(id.data);
    }
    return [...new Set(ids)];
  });

/** One custom input of the order form. The name the supplier expects is not sent. */
export const CatalogField = z.object({
  key: z.string(),
  label: z.string(),
  fieldType: z
    .enum(SERVICE_FIELD_TYPES)
    .describe(
      '`imei` holds one IMEI: read as digits (spaces and dashes removed), 15 digits with a valid Luhn check digit (else ' +
        '`422 INVALID_IMEI`, code `invalid_imei` on `inputs.<key>`).',
    ),
  required: z.boolean(),
  options: z.array(z.string()).describe('The choices of a `select` field.'),
  regex: z.string().describe('`""` when there is no pattern.'),
  isMainInput: z
    .boolean()
    .describe(
      "The service's main input (at most one field): its value is what the supplier receives as the IMEI. It is judged like any " +
        'other field, by its own type (an IMEI only for the type `imei`), `required` and pattern.',
    ),
});

/** One model, network or MEP choice. The supplier's own value is not sent. */
export const CatalogOption = z.object({ list: z.enum(SERVICE_OPTION_LISTS), value: z.string(), label: z.string() });

const ROW_EXAMPLE = {
  id: 5,
  name: 'AT&T USA Unlock',
  code: 'IMEI-ATT-USA',
  type: 'imei',
  category: { id: 4, name: 'Carrier unlock' },
  price: '16.9300',
  currency: 'USD',
  deliveryTime: '1 day',
  slaMinutes: 1440,
  info: '',
  minQty: 1,
  maxQty: 1,
  qtyOptions: [],
} as const;

/** `GET /client/services`: the catalog at the merchant's prices. */
export const listClientServices = defineRoute({
  key: 'GET /client/services',
  summary: 'My catalog',
  description:
    'The services the signed-in merchant may order, at the price it pays (client price, else group price, else the base price ' +
    'after the pricing rule, the group discount, rounding and the floor). Live and `active` services in an active category whose ' +
    "allowed groups are empty or include the merchant's group; archived and disabled services are never listed. Default order: " +
    'category order, then name, so the client can group by `category`. Filters: `type`, `categoryId`; `q` searches name, code and ' +
    'category; `ids` (comma-separated service ids, at most 100, each a positive whole number) keeps only those services, in the same ' +
    "rows: an id that is unknown, archived, off or hidden from the merchant's group is simply absent, and a bad value is `422` on " +
    '`ids`. The page range applies as for every list (default 25 rows), so send `_end=100` with up to 100 ids to read them all in ' +
    "one call; `x-total-count` counts the services found among them. Every price shown is remembered as the merchant's listed price " +
    '(price protection, user rule 9), a request with `ids` included, so a request that ' +
    'the browser marks as started by another site (`Sec-Fetch-Site: cross-site` or `same-site`, without an `Origin` that is one of ' +
    "the shop's origins) is `403 CSRF_FAILED` and remembers nothing; the portal's own server calls, which carry neither header, " +
    'are answered.',
  tags: ['client-catalog'],
  surface: 'client',
  access: 'merchant-session',
  originCheck: 'fetch-metadata',
  query: listQuery({
    sorts: ['category', 'name', 'type', 'id'],
    defaultSort: [
      { field: 'category', order: 'asc' },
      { field: 'name', order: 'asc' },
    ],
    filters: {
      type: { type: 'enum', values: SERVICE_TYPES, ops: ['eq', 'ne'] },
      categoryId: { type: 'id', ops: ['eq'] },
    },
    search: ['name', 'code', 'category.name'],
    extra: {
      ids: ServiceIdList.optional().describe(
        'Comma-separated service ids (at most 100, each a positive whole number): only these services, when the merchant may see them. ' +
          'Combines with the other filters; the page range still applies.',
      ),
    },
  }),
  success: { status: 200, schema: CatalogRow },
  errors: ['UNAUTHORIZED', 'VALIDATION_FAILED', 'CSRF_FAILED'],
  examples: { response: [ROW_EXAMPLE] },
});

/** `GET /client/services/:id`: one service with the field schema of the order form. */
export const showClientService = defineRoute({
  key: 'GET /client/services/:id',
  summary: 'One service of my catalog',
  description:
    'The catalog row plus the custom `fields` in order and the model, network and MEP `options` the order form needs. The form draws ' +
    'only these fields: on an IMEI service the IMEI is typed into the field with `isMainInput` (sent under its key in `inputs`; a ' +
    'service without one takes the IMEI as `imei`). A service ' +
    'the merchant may not see (unknown, archived, off, or hidden from its group) is `404`. The price shown is remembered as the ' +
    'listed price, so a request that the browser marks as started by another site (`Sec-Fetch-Site: cross-site` or `same-site`, ' +
    "without an `Origin` that is one of the shop's origins) is `403 CSRF_FAILED` and remembers nothing; the portal's own server " +
    'calls, which carry neither header, are answered.',
  tags: ['client-catalog'],
  surface: 'client',
  access: 'merchant-session',
  originCheck: 'fetch-metadata',
  params: z.object({ id: zIdParam }),
  success: {
    status: 200,
    schema: CatalogRow.extend({ fields: z.array(CatalogField), options: z.array(CatalogOption) }),
  },
  errors: ['UNAUTHORIZED', 'NOT_FOUND', 'CSRF_FAILED'],
  examples: {
    response: {
      ...ROW_EXAMPLE,
      fields: [
        {
          key: 'imei',
          label: 'IMEI',
          fieldType: 'imei',
          required: true,
          options: [],
          regex: '',
          isMainInput: true,
        },
        {
          key: 'carrier_account',
          label: 'Carrier account',
          fieldType: 'text',
          required: false,
          options: [],
          regex: '',
          isMainInput: false,
        },
      ],
      options: [{ list: 'model', value: 'iphone15', label: 'iPhone 15' }],
    },
  },
});

/** `GET /client/prices/export`: the merchant's price list as a CSV file. */
export const exportClientPrices = defineRoute({
  key: 'GET /client/prices/export',
  summary: 'Export my price list',
  description:
    "The whole visible catalog at the merchant's prices as `text/csv` (header `serviceId,code,name,type,category,price,currency," +
    'deliveryTime`, CRLF line ends, up to 10,000 services, category order then name). Optional filters `type` and `categoryId`. ' +
    "A cell that starts with `=`, `+`, `-` or `@` is written as text. Every price in the file is remembered as the merchant's listed " +
    'price, so the route is answered only to a request started by the portal itself (`Sec-Fetch-Site: same-origin`, or an ' +
    "`Origin` that is one of the shop's origins); anything else is `403 CSRF_FAILED` and remembers nothing. Never cached.",
  tags: ['client-catalog'],
  surface: 'client',
  access: 'merchant-session',
  originCheck: true,
  query: z.object({ type: z.enum(SERVICE_TYPES).optional(), categoryId: zIdParam.optional() }),
  success: { status: 200, contentType: 'text/csv' },
  errors: ['UNAUTHORIZED', 'VALIDATION_FAILED', 'CSRF_FAILED'],
});
