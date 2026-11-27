// Field schemas shared by the order route contracts: the order and its timeline as the admin console reads them, and the order
// as the merchant portal reads it. The staff shapes equal `src/features/orders/types` of the console (docs/contract/endpoints/orders.md).
import { z } from 'zod';
import { zId, zIsoDateTime, zJsonObject, zMoney } from '../../../common/contract';
import { SERVICE_TYPES } from '../../catalog';
import { CANCEL_BLOCKED_REASONS, CANCEL_WINDOW_MS, VERIFY_BLOCKED_REASONS } from '../domain/merchant-actions';
import { WIRE_DISPATCH_STATES } from '../domain/order-machine';
import {
  ORDER_EVENT_ACTOR_TYPES,
  ORDER_EVENT_TYPES,
  ORDER_SOURCES,
  ORDER_STATUSES,
  ORDER_VERIFICATION_STATUSES,
} from '../db/schema';

/** The five queues the console shows. */
export const ORDER_QUEUES = ['pending', 'manual', 'needs_attention', 'verification', 'review'] as const;

/** An id and a name, the join shape of an order row. */
const NamedRef = z.object({ id: zId, name: z.string() });

/**
 * The buyer of an order as the console reads it (decision 064): one shape for a merchant, a shop customer and a guest.
 *
 * Why: decision 064: `account` replaces the `client` and `customer` keys (no compatibility fields: the console ships in the same release);
 * the rank says which kind of buyer it is and `guest` that the account has no login.
 */
export const StaffOrderAccountSchema = z.object({
  id: zId.describe("The buyer account's id; a merchant's number is its account number."),
  name: z.string().describe("The account's name, or its masked address when it has no name."),
  email: z
    .string()
    .describe(
      "The account's address; masked (`ja•••@example.com`) unless the caller holds `clients:read` (decision 047), for an account of any rank.",
    ),
  rank: z
    .object({ id: zId, name: z.string(), kind: z.enum(['retail', 'merchant']) })
    .describe("The buyer's rank today, not the rank it had when it ordered."),
  guest: z.boolean().describe('True for a guest row: an address that ordered in the shop without a login.'),
});

/** The result the buyer gets: a code or text, an optional comment and an optional file. */
const OrderResult = z.object({
  code: z.string().nullable(),
  comment: z.string().nullable(),
  fileId: zId
    .nullable()
    .describe('The result file: `GET /admin/files/:id` (staff) or `GET /client/files/:id` (merchant).'),
});

/**
 * One custom field answer of an order, for a person to read (decision 065).
 *
 * Why: `inputs` is keyed by the hidden field keys; the order screens show the label of the field and the value that was given.
 */
export const OrderAnswerSchema = z.object({
  key: z.string().describe("The field's key, the key of this answer in `inputs`."),
  label: z
    .string()
    .describe(
      'The label of the field as it is now; the key itself when the service has no such field any more (it was deleted).',
    ),
  value: z.string().describe('The value that was given, as text.'),
});

/** The order as the admin console reads it (`GET /admin/orders` and `GET /admin/orders/:id`). */
export const StaffOrderSchema = z.object({
  id: zId.describe('The order id, also the Dhru REFERENCEID.'),
  createdAt: zIsoDateTime.describe('The placement time; the clock of the past-SLA predicate.'),
  taxAmount: zMoney,
  currency: z.string().describe("The buyer's display currency: `USD` for a merchant."),
  dispatchState: z
    .enum(WIRE_DISPATCH_STATES)
    .describe(
      'The internal dispatch state (decision 025); an order whose send is in progress reads `pending` (decision 044).',
    ),
  imei: z.string().describe("The order's main input (IMEI, account, serial or file name); `''` when it has none."),
  quantity: z.number().int().min(1),
  inputs: zJsonObject.describe('The custom field values by field key.'),
  unitPrice: zMoney,
  totalPrice: zMoney.describe('Net of tax: the gross price is `totalPrice + taxAmount`.'),
  unitCost: zMoney,
  totalCost: zMoney,
  pricingSnapshot: zJsonObject.describe(
    'How the price was resolved: the source, the steps, the floor and any recorded raise.',
  ),
  status: z.enum(ORDER_STATUSES),
  queue: z.enum(ORDER_QUEUES).nullable().describe('Derived from the status and the dispatch state (decision 025).'),
  reviewReason: z.string().nullable().describe('Why the order waits in a review queue; `null` outside one.'),
  channel: z
    .enum(['b2b', 'b2c'])
    .describe(
      'Derived from `source`: `b2c` for a storefront order (paid first), `b2b` for every door that holds from the wallet.',
    ),
  source: z.enum(ORDER_SOURCES),
  service: z.object({
    id: zId,
    name: z.string(),
    type: z.enum(SERVICE_TYPES),
    slaMinutes: z.number().int().min(1),
    category: z.string().nullable().optional(),
  }),
  account: StaffOrderAccountSchema,
  supplier: NamedRef.nullable(),
  supplierRef: z.string().nullable(),
  attempts: z
    .number()
    .int()
    .min(0)
    .describe('How many times the order was sent to a supplier (the `dispatch` events).'),
  result: OrderResult,
  verificationStatus: z.enum(ORDER_VERIFICATION_STATUSES).nullable(),
  inputFileId: zId.nullable(),
  adminNote: z.string().nullable(),
  sentAt: zIsoDateTime.nullable(),
  completedAt: zIsoDateTime.nullable().describe('Set for a completed and for a rejected order; `null` while open.'),
});

/** One line of the order timeline as the admin console reads it. */
export const StaffEventSchema = z.object({
  id: zId,
  type: z.enum(ORDER_EVENT_TYPES),
  fromStatus: z.enum(ORDER_STATUSES).nullable(),
  toStatus: z.enum(ORDER_STATUSES).nullable(),
  actor: z.object({
    type: z.enum(ORDER_EVENT_ACTOR_TYPES),
    id: zId.nullable(),
    name: z.string().nullable().describe('The staff member, account or supplier name; `null` for the system.'),
  }),
  account: z
    .object({ id: zId })
    .nullable()
    .describe(
      'The account the actor is: an `account` actor, or an old `client` or `customer` row resolved through the map of old numbers; `null` for staff, a supplier, the system and an old number the map does not know.',
    ),
  data: zJsonObject.describe('Details of the line; `message` is the sentence the console shows as it is.'),
  createdAt: zIsoDateTime,
});

/** The order as the merchant portal reads it: what the merchant paid and got, never cost, supplier, notes or risk. */
export const MerchantOrderSchema = z.object({
  id: zId.describe('The order id, also the Dhru REFERENCEID.'),
  status: z.enum(ORDER_STATUSES),
  imei: z.string().describe("The order's main input; `''` when it has none."),
  quantity: z.number().int().min(1),
  inputs: zJsonObject,
  unitPrice: zMoney,
  totalPrice: zMoney,
  currency: z.string().describe('`USD`.'),
  service: z.object({ id: zId, name: z.string(), type: z.enum(SERVICE_TYPES) }),
  source: z.enum(ORDER_SOURCES),
  result: OrderResult,
  verificationStatus: z.enum(ORDER_VERIFICATION_STATUSES).nullable(),
  inputFileId: zId.nullable(),
  canCancel: z.boolean().describe('`POST /client/orders/:id/cancel` would be accepted now.'),
  cancelUntil: zIsoDateTime
    .nullable()
    .describe(
      `Until when the order waits before it is sent, so it can still be cancelled (decision 075): an order placed on the website for a ` +
        `service that allows cancellation is sent ${CANCEL_WINDOW_MS / 60_000} minutes after it was placed. Set only while \`canCancel\` is ` +
        'true and the order is inside that window; `null` otherwise (a cancellable manual or held order has no deadline).',
    ),
  cancelBlocked: z
    .enum(CANCEL_BLOCKED_REASONS)
    .nullable()
    .describe(
      'Why the order cannot be cancelled now, `null` exactly when `canCancel` is true. The first that applies: `closed` (completed or ' +
        'rejected), `not_allowed` (the service does not allow cancellation), `already_sent` (sent to a supplier, or claimed for a send, at ' +
        'least once: the cancel would be `409 ALREADY_SENT`), `in_progress` (anything else: staff are working on it).',
    ),
  canVerify: z.boolean().describe('`POST /client/orders/:id/verify` would be accepted now.'),
  verifyUntil: zIsoDateTime
    .nullable()
    .describe(
      "Until when a verification can be asked for: `completedAt` plus the service's `verify_window_h` hours. Set only while " +
        '`canVerify` is true, `null` otherwise.',
    ),
  verifyBlocked: z
    .enum(VERIFY_BLOCKED_REASONS)
    .nullable()
    .describe(
      'Why a verification cannot be asked for now, `null` exactly when `canVerify` is true. The first that applies: ' +
        '`already_requested` (asked once already), `not_allowed` (the service does not allow verification), `not_completed` (the order is ' +
        'not completed), `window_passed` (the window has passed, or the service has a window of 0 hours).',
    ),
  createdAt: zIsoDateTime,
  completedAt: zIsoDateTime.nullable(),
});

/** One timeline line a merchant may see. */
export const MerchantEventSchema = z.object({
  id: zId,
  type: z.enum(ORDER_EVENT_TYPES),
  message: z.string().describe("The console's sentence for the line, `''` when it has none."),
  createdAt: zIsoDateTime,
});

/** The sorts of every order list. */
export const ORDER_SORTS = ['createdAt', 'totalPrice', 'status', 'id'] as const;
