// The four calls this backend makes to a supplier's Dhru Fusion v6.1 API (decision 026): the `SUPPLIER ...` keys of the map (stage 6). They are
// not routes we serve; each contract holds what the client sends and the answer it accepts, and `domain/dhru-protocol.ts` reads every answer through it.
import { z } from 'zod';
import { type SupplierCallParamsOf, defineSupplierCall } from '../../../common/contract';
import { amountText } from '../domain/amount-text';

/**
 * A text or a number; any other value counts as absent.
 *
 * Why: suppliers differ in how they spell ids, names and times (`4411` or `"4411"`), and one odd field in a service list must never fail the
 * whole call. The fields the client needs (the credit, the REFERENCEID, the STATUS) do not use it.
 */
const Loose = z.union([z.string(), z.number()]).optional().catch(undefined);

/** A number, or text with a number in it (`"1240.50"`, `"$1,200.50"`): how a supplier writes a balance. */
const Credit = z
  .union([z.string(), z.number()])
  .refine((value) => amountText(value) !== undefined, 'Must be a number such as "1240.50"');

/** The Dhru standard writes `STATUS` as a number; some suppliers send its text. Unknown values are refused like a missing one. */
const KNOWN_STATUSES: readonly number[] = [0, 1, 2, 3, 4];

const Status = z.union([z.string(), z.number()]).refine((value) => {
  const text = String(value).trim();
  return text !== '' && KNOWN_STATUSES.includes(Number(text));
}, 'Must be 0, 1, 2, 3 or 4');

/** The block `accountinfo` answers with. */
const AccountDetails = z.looseObject({
  credit: Credit.describe(
    'Our prepaid balance at the supplier, in its own currency. Read as a number: `"$1,200.50"` is accepted.',
  ),
  currency: Loose.describe('The currency of the balance, for example `USD`. Optional.'),
  mail: Loose.describe('The e-mail of our account at the supplier. Optional.'),
});

/**
 * `accountinfo`: our balance at the supplier (the connection test, the sync and the balance check).
 *
 * Why: the map row `SUPPLIER accountinfo` (رصيدنا عند المورد); the balance feeds the supplier health and the low-balance alert.
 */
export const accountInfoCall = defineSupplierCall({
  key: 'SUPPLIER accountinfo',
  summary: 'Our balance at the supplier',
  description:
    'Asks the supplier how much prepaid credit we have. The standard spells the answer key `AccoutInfo` (sic); `AccountInfo` is accepted too ' +
    '(when both come, a well-formed `AccoutInfo` wins and a malformed one gives way to `AccountInfo`). ' +
    'A missing block or a credit that is not a number is an unusable answer: the call is logged as failed. Extra fields are ignored.',
  success: z
    .looseObject({
      message: Loose.describe('`Your Accout Info`. Not read.'),
      AccoutInfo: AccountDetails.optional()
        .catch(undefined)
        .describe('The balance block, spelled as in the Dhru standard.'),
      AccountInfo: AccountDetails.optional()
        .catch(undefined)
        .describe('The balance block with the corrected spelling.'),
    })
    .refine(
      (entry) => entry.AccoutInfo !== undefined || entry.AccountInfo !== undefined,
      'Needs AccoutInfo (or AccountInfo) with a readable credit',
    ),
  examples: {
    response: {
      message: 'Your Accout Info',
      AccoutInfo: { credit: '1240.50', mail: 'ops@supplier.example', currency: 'USD' },
    },
    error: { MESSAGE: 'Authentication Failed' },
  },
});

/** One service of the list. Every field is optional here: the client leaves out a service that has no id, no name or no readable price. */
const ServiceEntry = z.looseObject({
  SERVICEID: Loose.describe("The supplier's service id; the key of the entry in `SERVICES` when it is missing."),
  SERVICETYPE: Loose.describe('`IMEI`, `SERVER` or `REMOTE`; used when the group has no `GROUPTYPE`.'),
  SERVICENAME: Loose.describe('The name (kept to 300 characters). A service without a name is left out.'),
  CREDIT: Loose.describe('The price in supplier credits. A service without a readable price is left out.'),
  TIME: Loose.describe('The delivery time as text, for example `1-2 hours`.'),
  'Requires.Custom': z
    .array(z.unknown())
    .optional()
    .catch(undefined)
    .describe(
      'The custom fields the service needs: `{ type, fieldname, fieldtype, description, fieldoptions, required }` each.',
    ),
});

/** One group of the list. */
const ServiceGroup = z.looseObject({
  GROUPNAME: Loose.describe('The group name; the key of the group in `LIST` when it is missing.'),
  GROUPTYPE: Loose.describe('`IMEI`, `SERVER` or `REMOTE`.'),
  SERVICES: z
    .record(z.string(), ServiceEntry.optional().catch(undefined))
    .optional()
    .catch(undefined)
    .describe('The services of the group by id. A group without `SERVICES` is skipped.'),
});

/**
 * `imeiservicelist`: the supplier's services and their cost (the price sync and the import).
 *
 * Why: the map row `SUPPLIER imeiservicelist` (خدمات المورد وتكلفتها للمزامنة); the credit of each service is the cost the pricing rules start from.
 */
export const serviceListCall = defineSupplierCall({
  key: 'SUPPLIER imeiservicelist',
  summary: "The supplier's services and their cost",
  description:
    'Asks for the whole catalogue: `LIST` is an object of groups, each with a `SERVICES` object of services. The client keeps each service once ' +
    '(the first one wins when an id repeats) and leaves out a service without an id, a name or a readable price; a field of the wrong type counts ' +
    'as missing, and every `Requires.*` flag is kept. The log keeps the count of services, not the list.',
  success: z.looseObject({
    MESSAGE: Loose.describe('`IMEI Service List`. Not read.'),
    LIST: z
      .record(z.string(), ServiceGroup.optional().catch(undefined))
      .optional()
      .catch(undefined)
      .describe('The groups by name. A list that is missing or empty means the supplier has no services.'),
  }),
  examples: {
    response: {
      MESSAGE: 'IMEI Service List',
      LIST: {
        'Carrier unlock': {
          GROUPNAME: 'Carrier unlock',
          GROUPTYPE: 'IMEI',
          SERVICES: {
            '4411': {
              SERVICEID: '4411',
              SERVICETYPE: 'IMEI',
              SERVICENAME: 'AT&T USA Premier',
              CREDIT: '13.5000',
              TIME: '1-2 hours',
              'Requires.Network': 'None',
            },
          },
        },
      },
    },
    error: { MESSAGE: 'Authentication Failed' },
  },
});

/** The parameters of `placeimeiorder`, as decoded from the `parameters` field the client sends. */
const PlaceOrderParams = z.object({
  ID: z.string().min(1).describe("The supplier's service id (`supplier_services.remote_id`)."),
  IMEI: z
    .string()
    .optional()
    .describe('The main input: the IMEI, or the first required field. Left out when the order has none.'),
  QNT: z.number().int().min(1).describe('The quantity.'),
  CUSTOMFIELD: z
    .record(z.string(), z.string())
    .optional()
    .describe(
      "The custom field values by the supplier's field names. On the wire it is base64 of this JSON object (decision 026).",
    ),
});

/** The decoded parameters `placeimeiorder` is sent with: the driver builds its request as this type. */
export type PlaceOrderParameters = SupplierCallParamsOf<typeof placeOrderCall>;

/**
 * `placeimeiorder`: sends an order to the supplier and stores its REFERENCEID as `supplier_ref` (the dispatch job).
 *
 * Why: the map row `SUPPLIER placeimeiorder · bulk` (إرسال الطلب وحفظ supplier_ref); the REFERENCEID is how the poll job asks for the result.
 */
export const placeOrderCall = defineSupplierCall({
  key: 'SUPPLIER placeimeiorder+placeimeiorderbulk',
  summary: 'Send an order to the supplier',
  description:
    'Places one order and keeps the `REFERENCEID` of the answer (kept to 200 characters) as the supplier reference. An answer without a ' +
    'REFERENCEID is unusable: the order goes to attention, it is never sent again by itself. The bulk variant `placeimeiorderbulk` (parameters ' +
    'keyed by a request id) is described by the Dhru standard but this backend never sends it: each order is its own job, so a refusal never ' +
    'stops another order and every order has its own log row.',
  sendsBulk: false,
  params: PlaceOrderParams,
  success: z.looseObject({
    MESSAGE: Loose.describe('`Order received`. Not read.'),
    REFERENCEID: z
      .union([z.string(), z.number()])
      .refine((value) => String(value).trim() !== '', 'Must not be blank')
      .describe("The supplier's reference of the order."),
  }),
  examples: {
    request: { ID: '4411', IMEI: '352905112490861', QNT: 1, CUSTOMFIELD: { AccountUser: 'ali' } },
    response: { MESSAGE: 'Order received', REFERENCEID: '88121' },
    error: { MESSAGE: 'Not enough credits' },
  },
});

/** The parameters of `getimeiorder`. */
const GetOrderParams = z.object({
  ID: z.string().min(1).describe("The supplier's reference of the order: the `REFERENCEID` of the placement."),
});

/** The decoded parameters `getimeiorder` is sent with: the driver builds its request as this type. */
export type GetOrderParameters = SupplierCallParamsOf<typeof getOrderCall>;

/**
 * `getimeiorder`: asks the supplier for the status and the result of an order (the poll job and staff's fetch).
 *
 * Why: the map row `SUPPLIER getimeiorder · bulk` (سحب الحالة والنتيجة): STATUS 4 completes the order, STATUS 3 rejects it and releases the hold.
 */
export const getOrderCall = defineSupplierCall({
  key: 'SUPPLIER getimeiorder+getimeiorderbulk',
  summary: 'Ask the supplier for the status of an order',
  description:
    '`STATUS` 4 is completed and 3 rejected; `CODE` is the result of a completed order or the reason of a rejected one. 0 and 1 mean the order is ' +
    'still running (2 is accepted as running too; the standard does not use it) and the CODE is ignored. A missing or unknown STATUS is an ' +
    'unusable answer: the order stays as it is and is asked again. The bulk variant `getimeiorderbulk` is described by the Dhru standard but ' +
    'this backend never sends it: each poll job asks about one order.',
  sendsBulk: false,
  params: GetOrderParams,
  success: z.looseObject({
    STATUS: Status.describe('0 new, 1 in process, 3 rejected (refunded), 4 completed. Text such as `"4"` is accepted.'),
    CODE: Loose.describe('The result of a completed order, the reason of a rejected one; empty while it runs.'),
  }),
  examples: {
    request: { ID: '88121' },
    response: { STATUS: 4, CODE: 'Unlocked: code 8842 1113' },
    error: { MESSAGE: 'Order not found' },
  },
});

/**
 * The four supplier calls, in the order of the map.
 *
 * Why: public so a tool or a test can list what this backend sends to a supplier without knowing the contracts file; loading the module's
 * index also registers them (the contract tests read the registry).
 */
export const SUPPLIER_CALLS = [accountInfoCall, serviceListCall, placeOrderCall, getOrderCall] as const;
