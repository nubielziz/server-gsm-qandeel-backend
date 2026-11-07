// Field schemas shared by the order route contracts: the order and its timeline as the admin console reads them, and the order
// as the merchant portal reads it. The staff shapes equal `src/features/orders/types` of the console (docs/contract/endpoints/orders.md).
import { z } from 'zod';
import { zId, zIsoDateTime, zJsonObject, zMoney } from '../../../common/contract';
import { SERVICE_TYPES } from '../../catalog';
import {
  ORDER_DISPATCH_STATES,
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

/** The result the buyer gets: a code or text, an optional comment and an optional file. */
const OrderResult = z.object({
  code: z.string().nullable(),
  comment: z.string().nullable(),
  fileId: zId
    .nullable()
    .describe('The result file: `GET /admin/files/:id` (staff) or `GET /client/files/:id` (merchant).'),
});

/** The order as the admin console reads it (`GET /admin/orders` and `GET /admin/orders/:id`). */
export const StaffOrderSchema = z.object({
  id: zId.describe('The order id, also the Dhru REFERENCEID.'),
  createdAt: zIsoDateTime.describe('The placement time; the clock of the past-SLA predicate.'),
  taxAmount: zMoney,
  currency: z.string().describe("The buyer's display currency: `USD` for a merchant."),
  dispatchState: z.enum(ORDER_DISPATCH_STATES),
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
  channel: z.enum(['b2b', 'b2c']).describe('`b2b` for a merchant order, `b2c` for a storefront order.'),
  source: z.enum(ORDER_SOURCES),
  service: z.object({
    id: zId,
    name: z.string(),
    type: z.enum(SERVICE_TYPES),
    slaMinutes: z.number().int().min(1),
    category: z.string().nullable().optional(),
  }),
  client: NamedRef.nullable(),
  customer: NamedRef.extend({ email: z.string() }).nullable(),
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
  clientNote: z.string().nullable(),
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
    name: z
      .string()
      .nullable()
      .describe('The staff member, merchant, customer or supplier name; `null` for the system.'),
  }),
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
  clientNote: z.string().nullable(),
  inputFileId: zId.nullable(),
  canCancel: z.boolean().describe('`POST /client/orders/:id/cancel` would be accepted now.'),
  canVerify: z.boolean().describe('`POST /client/orders/:id/verify` would be accepted now.'),
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
