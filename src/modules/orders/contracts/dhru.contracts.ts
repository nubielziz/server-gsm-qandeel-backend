// The Dhru Fusion v6.1 surface of the orders module (decision 026): the transport route `POST /api/index.php` and the contracts of the six
// order actions (`placeimeiorder`, `placeimeiorderbulk`, `getimeiorder`, `getimeiorderbulk`, `placefileorder`, `getfileorder`). The other two
// actions are owned by money (`accountinfo`) and catalog (`imeiservicelist`). The keys and spellings are the decision's; the parameters of
// the file actions are fixed here (decision 026 leaves them to this feature; MISMATCHES B166).
import { z } from 'zod';
import { MAX_ID, defineRoute } from '../../../common/contract';
import { defineDhruAction } from '../../../common/dhru';

/** The id of a service or an order as Dhru sends it: a number or the text of one. */
const DhruId = z.coerce
  .number({ error: 'Must be a number.' })
  .int('Must be a whole number.')
  .positive('Must be greater than zero.')
  .max(MAX_ID);

/** A value that is text or a number, read as text (an IMEI sent as a JSON number). */
const Text = z.union([z.string(), z.number()]).transform((value) => String(value).trim());

/** The parameters every placement shares. */
const PLACE_FIELDS = {
  ID: DhruId.describe('The service: the `SERVICEID` of `imeiservicelist`.'),
  QNT: z.coerce
    .number({ error: 'Must be a number.' })
    .int()
    .min(1)
    .max(100_000)
    .optional()
    .describe("The quantity; defaults to the service's minimum."),
  CUSTOMFIELD: z
    .unknown()
    .optional()
    .describe(
      'The values of the service custom fields by field name: base64 of a JSON object (an object is accepted too).',
    ),
};

/** The parameters of `placeimeiorder`. */
const PlaceImeiParams = z.object({
  ...PLACE_FIELDS,
  IMEI: Text.optional().describe(
    'The IMEI of an IMEI service (15 digits, Luhn); leave it out for a server or remote service.',
  ),
});

/** The parameters of `placefileorder`. */
const PlaceFileParams = z.object({
  ...PLACE_FIELDS,
  FILENAME: Text.optional().describe('The name of the file, when it is sent as `FILEDATA`.'),
  FILEDATA: z
    .string()
    .optional()
    .describe('The file: base64 of its content. A multipart request may send the file as a file part instead.'),
});

/** The parameters of `getimeiorder` and `getfileorder`. */
const GetOrderParams = z.object({ ID: DhruId.describe('The order: the `REFERENCEID` the placement answered.') });

/** The success entry of a placement. */
const PlacedSchema = z.object({
  MESSAGE: z.literal('Order received'),
  REFERENCEID: z.string().describe('Our order id.'),
});

/** The success entry of a status call. */
const StatusSchema = z.object({
  STATUS: z
    .union([z.literal(0), z.literal(1), z.literal(3), z.literal(4)])
    .describe('0 new, 1 in process, 3 rejected (refunded), 4 completed.'),
  CODE: z.string().describe('The result of a completed order, the reason of a rejected one; `""` while it runs.'),
});

const PLACE_ERRORS = [
  'UNAUTHORIZED',
  'FORBIDDEN',
  'ACCOUNT_SUSPENDED',
  'ACCOUNT_PENDING_APPROVAL',
  'IP_NOT_ALLOWED',
  'RATE_LIMITED',
  'MAINTENANCE',
  'NOT_FOUND',
  'INSUFFICIENT_FUNDS',
  'SERVICE_DISABLED',
  'PRICE_CHANGED',
  'DUPLICATE_ORDER',
  'INVALID_IMEI',
  'VALIDATION_FAILED',
] as const;

const GET_ERRORS = [
  'UNAUTHORIZED',
  'ACCOUNT_SUSPENDED',
  'ACCOUNT_PENDING_APPROVAL',
  'IP_NOT_ALLOWED',
  'RATE_LIMITED',
  'NOT_FOUND',
  'VALIDATION_FAILED',
] as const;

const PLACE_EXAMPLE_PARAMS = { ID: 5, IMEI: '352905112490861' } as const;
const PLACE_EXAMPLE = { MESSAGE: 'Order received', REFERENCEID: '48101' } as const;

/** The Dhru action `placeimeiorder`. */
export const dhruPlaceImeiOrder = defineDhruAction({
  key: 'DHRU placeimeiorder',
  summary: 'Place an IMEI, server or remote order',
  description:
    "Orders a service at the merchant's own price and holds it from the wallet. `ID` is the `SERVICEID` of `imeiservicelist`; an IMEI " +
    'service takes `IMEI`, a server or remote service its custom fields in `CUSTOMFIELD`. The answer is immediate: `REFERENCEID` is our ' +
    'order id (status 0). A price that rose more than the tolerance above the price last listed is refused with "Price changed. Please ' +
    'refresh the service list and order again."; a balance that is too low with "Not enough credits". A File service is placed with ' +
    '`placefileorder`.',
  params: PlaceImeiParams,
  success: PlacedSchema,
  errors: [...PLACE_ERRORS],
  examples: { request: PLACE_EXAMPLE_PARAMS, response: PLACE_EXAMPLE },
});

/** The Dhru action `placeimeiorderbulk`. */
export const dhruPlaceImeiOrderBulk = defineDhruAction({
  key: 'DHRU placeimeiorderbulk',
  summary: 'Place several orders',
  description:
    "`parameters` is an object keyed by the caller's request id, each entry the parameters of `placeimeiorder`. The answer has one entry " +
    'per request id: `{ "SUCCESS": [...] }` or `{ "ERROR": [...] }`. Each order is placed on its own (a refused one never stops the ' +
    'others); at most 100 per call.',
  bulk: true,
  params: PlaceImeiParams,
  success: PlacedSchema,
  errors: [...PLACE_ERRORS],
  examples: { request: PLACE_EXAMPLE_PARAMS, response: PLACE_EXAMPLE },
});

/** The Dhru action `getimeiorder`. */
export const dhruGetImeiOrder = defineDhruAction({
  key: 'DHRU getimeiorder',
  summary: 'Order status and result',
  description:
    '`STATUS` 0 new, 1 in process, 3 rejected (refunded), 4 completed; `CODE` is the result of a completed order or the reason of a ' +
    "rejected one. Another merchant's order, like an unknown id, is an error.",
  params: GetOrderParams,
  success: StatusSchema,
  errors: [...GET_ERRORS],
  examples: { request: { ID: 48101 }, response: { STATUS: 4, CODE: 'Unlocked: code 8842 1113' } },
});

/** The Dhru action `getimeiorderbulk`. */
export const dhruGetImeiOrderBulk = defineDhruAction({
  key: 'DHRU getimeiorderbulk',
  summary: 'Status of several orders',
  description:
    '`parameters` is an object keyed by the caller\'s request id, each entry `{ "ID": <order> }`; the answer has one entry per request ' +
    'id with the `STATUS` and `CODE` of `getimeiorder` or an error; at most 100 per call.',
  bulk: true,
  params: GetOrderParams,
  success: StatusSchema,
  errors: [...GET_ERRORS],
  examples: { request: { ID: 48101 }, response: { STATUS: 1, CODE: '' } },
});

/** The Dhru action `placefileorder`. */
export const dhruPlaceFileOrder = defineDhruAction({
  key: 'DHRU placefileorder',
  summary: 'Place a file order',
  description:
    'Orders a File service. The file is `FILENAME` and `FILEDATA` (base64) in `parameters`, or a file part of a `multipart/form-data` ' +
    'request; it is stored like `POST /v1/files` (up to 25 MiB). Everything else is as `placeimeiorder`. A service that is not a File ' +
    'service is refused.',
  params: PlaceFileParams,
  success: PlacedSchema,
  errors: [...PLACE_ERRORS, 'PAYLOAD_TOO_LARGE'],
  examples: { request: { ID: 9, FILENAME: 'firmware.bin', FILEDATA: 'AAECAw==' }, response: PLACE_EXAMPLE },
});

/** The Dhru action `getfileorder`. */
export const dhruGetFileOrder = defineDhruAction({
  key: 'DHRU getfileorder',
  summary: 'Result of a file order',
  description:
    'As `getimeiorder`; when the result is a file, `FILEID` is its id: download it with `GET /v1/files/:id`.',
  params: GetOrderParams,
  success: StatusSchema.extend({ FILEID: z.number().int().positive().optional() }),
  errors: [...GET_ERRORS],
  examples: { request: { ID: 48102 }, response: { STATUS: 4, CODE: 'Done', FILEID: 9002 } },
});

/** The form fields of a Dhru request (`application/x-www-form-urlencoded`, multipart or JSON). */
const DhruRequest = z.looseObject({
  username: z.string().optional().describe('The merchant username (`clients.username`).'),
  apiaccesskey: z.string().optional().describe('A merchant API key with the `dhru` scope.'),
  action: z.string().optional().describe('One of the eight actions below.'),
  requestformat: z.string().optional().describe('Ignored: every answer is JSON.'),
  parameters: z
    .union([z.string(), z.record(z.string(), z.unknown())])
    .optional()
    .describe(
      'The action parameters: base64 of a JSON object (bulk actions: an object keyed by the caller request id).',
    ),
});

/** `POST /api/index.php`: the one endpoint of the Dhru Fusion surface. */
export const dhruEndpoint = defineRoute({
  key: 'POST /api/index.php',
  summary: 'Dhru Fusion API',
  description:
    'The Dhru Fusion v6.1 compatible endpoint (decision 026): `username`, `apiaccesskey`, `action` and `parameters` (base64 of a JSON ' +
    'object) as a form body (`multipart/form-data` and JSON are accepted too). Eight actions: `accountinfo`, `imeiservicelist`, ' +
    '`placeimeiorder`, `placeimeiorderbulk`, `getimeiorder`, `getimeiorderbulk`, `placefileorder` and `getfileorder`. Every answer is ' +
    'HTTP 200 with the headers `X-Powered-By: DHRU-FUSION` and `dhru-fusion-api-version: 6.1` and the body `{ "SUCCESS": [ ... ], ' +
    '"apiversion": "6.1" }` or `{ "ERROR": [ { "MESSAGE": "..." } ], "apiversion": "6.1" }`; a bulk action answers `{ "<request id>": ' +
    '{ "SUCCESS" | "ERROR": [ ... ] }, ..., "apiversion": "6.1" }`. A wrong credential is "Authentication Failed", an unknown action ' +
    '"Invalid Action". The key must carry the `dhru` scope; the allowed addresses and the per-minute limit of the key apply.',
  tags: ['dhru'],
  surface: 'dhru',
  access: 'dhru-credentials',
  bodyType: 'form',
  body: DhruRequest,
  success: { status: 200, schema: z.record(z.string(), z.unknown()) },
  errors: [
    'UNAUTHORIZED',
    'FORBIDDEN',
    'ACCOUNT_SUSPENDED',
    'ACCOUNT_PENDING_APPROVAL',
    'IP_NOT_ALLOWED',
    'RATE_LIMITED',
    'MAINTENANCE',
  ],
  examples: {
    request: {
      username: 'zain-mobile-hub',
      apiaccesskey: 'gsm_…',
      action: 'getimeiorder',
      parameters: 'eyJJRCI6NDgxMDF9',
    },
    response: { SUCCESS: [{ STATUS: 4, CODE: 'Unlocked: code 8842 1113' }], apiversion: '6.1' },
  },
});
