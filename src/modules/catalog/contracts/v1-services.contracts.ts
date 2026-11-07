// Route contracts of the catalog over REST v1 (map domain B, stage 7): `GET /v1/services` and `GET /v1/services/:id`, plus the Dhru
// action `imeiservicelist` (decision 026). No console screen calls them; the shapes follow ALIGNMENT § 7, B159 (the portal catalog) and
// the keys of decision 026 (`LIST`, `GROUPNAME`, `SERVICES`, `SERVICEID`, `Requires.*`).
import { z } from 'zod';
import { defineRoute, zCursor, zCursorLimit, zCursorPage, zIdParam, zMoney } from '../../../common/contract';
import { defineDhruAction } from '../../../common/dhru';
import { SERVICE_TYPES } from '../db/schema';
import { CatalogField, CatalogOption, CatalogRow } from './merchant-catalog.contracts';

/** What a service lets the merchant do with its orders, next to the row of the portal catalog. */
const V1Service = CatalogRow.extend({
  allowCancel: z
    .boolean()
    .describe('`POST /v1/orders/:id/cancel` is accepted for an order of this service that was never sent.'),
  allowVerify: z.boolean().describe('`POST /v1/orders/:id/verify` is accepted for a completed order of this service.'),
  verifyWindowH: z
    .number()
    .int()
    .min(0)
    .describe('Hours after completion in which verification is accepted; `0` means no window.'),
});

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
  allowCancel: false,
  allowVerify: true,
  verifyWindowH: 48,
} as const;

const SERVICE_ERRORS = [
  'UNAUTHORIZED',
  'FORBIDDEN',
  'IP_NOT_ALLOWED',
  'ACCOUNT_SUSPENDED',
  'ACCOUNT_PENDING_APPROVAL',
  'RATE_LIMITED',
] as const;

/** `GET /v1/services`. */
export const listV1Services = defineRoute({
  key: 'GET /v1/services',
  summary: 'Service catalog',
  description:
    'The services the merchant may order, at the price it pays (client price, else group price, else the base price after the pricing ' +
    'rule, the group discount, rounding and the floor), in id order, in pages: `limit` (1 to 100, default 50) and `cursor` (the ' +
    '`nextCursor` of the previous page). Filters: `type`, `categoryId`; `q` is a case-insensitive contains over name, code and category. ' +
    "Archived and disabled services and categories the merchant's group may not see are never listed. Every price shown is remembered " +
    "as the merchant's listed price: an order that costs much more than the price last shown is refused with `PRICE_CHANGED` " +
    '(user rule 9). Scope `services:read`.',
  tags: ['services'],
  surface: 'v1',
  access: 'api-key',
  permission: 'services:read',
  query: z.object({
    limit: zCursorLimit,
    cursor: zCursor,
    type: z.enum(SERVICE_TYPES).optional(),
    categoryId: zIdParam.optional(),
    q: z.string().trim().min(1).max(100).optional().describe('Search text.'),
  }),
  success: { status: 200, schema: zCursorPage(V1Service) },
  errors: [...SERVICE_ERRORS, 'VALIDATION_FAILED'],
  examples: { response: { data: [ROW_EXAMPLE], nextCursor: null } },
});

/** `GET /v1/services/:id`. */
export const showV1Service = defineRoute({
  key: 'GET /v1/services/:id',
  summary: 'One service',
  description:
    'The catalog row plus the custom `fields` in order and the model, network and MEP `options` an order needs; the quantity rules ' +
    '(`minQty`, `maxQty`, `qtyOptions`) are part of the row. A service the merchant may not see (unknown, archived, off, or hidden from ' +
    'its group) is `404`. The price shown is remembered as the listed price. Scope `services:read`.',
  tags: ['services'],
  surface: 'v1',
  access: 'api-key',
  permission: 'services:read',
  params: z.object({ id: zIdParam }),
  success: {
    status: 200,
    schema: V1Service.extend({ fields: z.array(CatalogField), options: z.array(CatalogOption) }),
  },
  errors: [...SERVICE_ERRORS, 'NOT_FOUND', 'VALIDATION_FAILED'],
  examples: {
    response: {
      ...ROW_EXAMPLE,
      fields: [{ key: 'imei', label: 'IMEI', fieldType: 'text', required: true, options: [], regex: '^[0-9]{15}$' }],
      options: [{ list: 'model', value: 'iphone15', label: 'iPhone 15' }],
    },
  },
});

/** One custom input of a service as the Dhru list describes it. */
const DhruCustomField = z.object({
  type: z.string().describe('`serviceimei`, `serviceserver` or `serviceremote`.'),
  fieldname: z.string().describe('The field key: the name `CUSTOMFIELD` takes.'),
  fieldtype: z.enum(['text', 'textarea', 'dropdown']),
  description: z.string().describe('The label.'),
  fieldoptions: z.string().describe('The choices of a dropdown, comma separated; `""` otherwise.'),
  required: z.union([z.literal(1), z.literal(0)]),
});

/** One service of the Dhru list. */
const DhruService = z.object({
  SERVICEID: z.string().describe('Our service id: the `ID` of `placeimeiorder`.'),
  SERVICETYPE: z.enum(['IMEI', 'SERVER', 'REMOTE']),
  SERVICENAME: z.string(),
  CREDIT: zMoney.describe("The merchant's price."),
  INFO: z.string(),
  TIME: z.string().describe('The delivery time, `15 min`, `2 hours`.'),
  QNT: z.enum(['0', '1']).describe('`1` when the service sells more than one quantity.'),
  QNTOPTIONS: z.string().describe('The packs a service sells, comma separated; `""` when it sells a range.'),
  MINQNT: z.string(),
  MAXQNT: z.string(),
  'Requires.Network': z.string(),
  'Requires.Mobile': z.string(),
  'Requires.Provider': z.string(),
  'Requires.PIN': z.string(),
  'Requires.KBH': z.string(),
  'Requires.MEP': z.string(),
  'Requires.PRD': z.string(),
  'Requires.Type': z.string(),
  'Requires.Locks': z.string(),
  'Requires.SN': z.string(),
  'Requires.SecRO': z.string(),
  'Requires.Reference': z.string(),
  'Requires.Custom': z.array(DhruCustomField),
});

const DHRU_EXAMPLE_SERVICE = {
  SERVICEID: '5',
  SERVICETYPE: 'IMEI',
  SERVICENAME: 'AT&T USA Unlock',
  CREDIT: '16.9300',
  INFO: '',
  TIME: '1 day',
  QNT: '0',
  QNTOPTIONS: '',
  MINQNT: '1',
  MAXQNT: '1',
  'Requires.Network': 'None',
  'Requires.Mobile': 'None',
  'Requires.Provider': 'None',
  'Requires.PIN': 'None',
  'Requires.KBH': 'None',
  'Requires.MEP': 'None',
  'Requires.PRD': 'None',
  'Requires.Type': 'None',
  'Requires.Locks': 'None',
  'Requires.SN': 'None',
  'Requires.SecRO': 'None',
  'Requires.Reference': 'None',
  'Requires.Custom': [],
} as const;

/** The Dhru action `imeiservicelist`: the services grouped by category, at the merchant's prices. */
export const dhruServiceList = defineDhruAction({
  key: 'DHRU imeiservicelist',
  summary: 'IMEI service list',
  description:
    'The IMEI, server and remote services the merchant may order, grouped by category, at its own price (`CREDIT`), with the quantity ' +
    'rules and the custom fields (`Requires.Custom`). File services are not listed. Archived and disabled services and categories the ' +
    "merchant's group may not see are never listed. Every price shown is remembered as the merchant's listed price (user rule 9).",
  success: z.object({
    MESSAGE: z.literal('IMEI Service List'),
    LIST: z.record(
      z.string(),
      z.object({
        GROUPNAME: z.string(),
        GROUPTYPE: z.enum(['IMEI', 'SERVER', 'REMOTE']),
        SERVICES: z.record(z.string(), DhruService),
      }),
    ),
  }),
  errors: ['UNAUTHORIZED', 'ACCOUNT_SUSPENDED', 'ACCOUNT_PENDING_APPROVAL', 'IP_NOT_ALLOWED', 'RATE_LIMITED'],
  examples: {
    response: {
      MESSAGE: 'IMEI Service List',
      LIST: {
        'Carrier unlock': {
          GROUPNAME: 'Carrier unlock',
          GROUPTYPE: 'IMEI',
          SERVICES: { '5': DHRU_EXAMPLE_SERVICE },
        },
      },
    },
  },
});
