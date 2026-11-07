// Route contracts of the merchant catalog (map domain B, routes /client/services and /client/prices/export, stage 4): the
// services the signed-in merchant may buy at its own prices, the field schema of one service for the order form, and its price
// list as a CSV file. The console has no screen for these (the merchant portal is another frontend): the shapes follow
// ALIGNMENT § 7 and RESOLUTIONS catalog-3 and -4, and are written up in the module README.
import { z } from 'zod';
import { defineRoute, listQuery, zId, zIdParam, zMoney } from '../../../common/contract';
import { SERVICE_FIELD_TYPES, SERVICE_OPTION_LISTS, SERVICE_TYPES } from '../db/schema';
import { NamedRef } from './shared';

/** A service at the merchant's price. Cost, floor, margin and supplier details are never sent to a merchant. */
const CatalogRow = z.object({
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

/** One custom input of the order form. The name the supplier expects is not sent. */
const CatalogField = z.object({
  key: z.string(),
  label: z.string(),
  fieldType: z.enum(SERVICE_FIELD_TYPES),
  required: z.boolean(),
  options: z.array(z.string()).describe('The choices of a `select` field.'),
  regex: z.string().describe('`""` when there is no pattern.'),
});

/** One model, network or MEP choice. The supplier's own value is not sent. */
const CatalogOption = z.object({ list: z.enum(SERVICE_OPTION_LISTS), value: z.string(), label: z.string() });

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
    "category. Every price shown is remembered as the merchant's listed price (price protection, user rule 9).",
  tags: ['client-catalog'],
  surface: 'client',
  access: 'merchant-session',
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
  }),
  success: { status: 200, schema: CatalogRow },
  errors: ['UNAUTHORIZED', 'ACCOUNT_PENDING_APPROVAL', 'VALIDATION_FAILED'],
  examples: { response: [ROW_EXAMPLE] },
});

/** `GET /client/services/:id`: one service with the field schema of the order form. */
export const showClientService = defineRoute({
  key: 'GET /client/services/:id',
  summary: 'One service of my catalog',
  description:
    'The catalog row plus the custom `fields` in order and the model, network and MEP `options` the order form needs. A service ' +
    'the merchant may not see (unknown, archived, off, or hidden from its group) is `404`. The price shown is remembered as the ' +
    'listed price.',
  tags: ['client-catalog'],
  surface: 'client',
  access: 'merchant-session',
  params: z.object({ id: zIdParam }),
  success: {
    status: 200,
    schema: CatalogRow.extend({ fields: z.array(CatalogField), options: z.array(CatalogOption) }),
  },
  errors: ['UNAUTHORIZED', 'ACCOUNT_PENDING_APPROVAL', 'NOT_FOUND'],
  examples: {
    response: {
      ...ROW_EXAMPLE,
      fields: [{ key: 'imei', label: 'IMEI', fieldType: 'text', required: true, options: [], regex: '^[0-9]{15}$' }],
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
    'price. Never cached.',
  tags: ['client-catalog'],
  surface: 'client',
  access: 'merchant-session',
  query: z.object({ type: z.enum(SERVICE_TYPES).optional(), categoryId: zIdParam.optional() }),
  success: { status: 200, contentType: 'text/csv' },
  errors: ['UNAUTHORIZED', 'ACCOUNT_PENDING_APPROVAL', 'VALIDATION_FAILED'],
});
