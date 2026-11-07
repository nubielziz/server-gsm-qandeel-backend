// Order views: the rows of the read model turned into what the routes send. The staff view is the console's `Order` (cost, supplier,
// notes); the merchant view hides everything that is not the merchant's to see (cost, supplier, internal notes, risk).
import type { JsonObject } from '../../../common/contract';
import { deriveQueue } from '../domain/order-machine';
import type { OrderQueue } from '../domain/order-machine';
import type {
  Order,
  OrderDispatchState,
  OrderEvent,
  OrderEventActorType,
  OrderEventType,
  OrderSource,
  OrderStatus,
  OrderVerificationStatus,
} from '../db/schema';
import type { OrderRow } from '../infra/order-read.repository';

/** A named record in a join. */
export interface NamedRef {
  readonly id: number;
  readonly name: string;
}

/** The order as the admin console reads it (`Order` of `src/features/orders/types`). */
export interface StaffOrderView {
  readonly id: number;
  readonly createdAt: string;
  readonly taxAmount: string;
  readonly currency: string;
  readonly dispatchState: OrderDispatchState;
  readonly imei: string;
  readonly quantity: number;
  readonly inputs: JsonObject;
  readonly unitPrice: string;
  readonly totalPrice: string;
  readonly unitCost: string;
  readonly totalCost: string;
  readonly pricingSnapshot: JsonObject;
  readonly status: OrderStatus;
  readonly queue: OrderQueue | null;
  readonly reviewReason: string | null;
  readonly channel: 'b2b' | 'b2c';
  readonly source: OrderSource;
  readonly service: { id: number; name: string; type: Order['type']; slaMinutes: number; category: string | null };
  readonly client: NamedRef | null;
  readonly customer: (NamedRef & { email: string }) | null;
  readonly supplier: NamedRef | null;
  readonly supplierRef: string | null;
  readonly attempts: number;
  readonly result: { code: string | null; comment: string | null; fileId: number | null };
  readonly verificationStatus: OrderVerificationStatus | null;
  readonly inputFileId: number | null;
  readonly clientNote: string | null;
  readonly adminNote: string | null;
  readonly sentAt: string | null;
  readonly completedAt: string | null;
}

/** The queues that carry a reason: a person has to act, and the reason says why. */
const REASON_QUEUES: readonly OrderQueue[] = ['manual', 'needs_attention', 'verification', 'review'];

/**
 * Tells whether the review reason of an order should be sent: only while it waits in a queue a person works.
 *
 * @param order the order
 * @returns true for the manual, needs-attention, verification and review queues
 */
export function carriesReason(order: Pick<Order, 'status' | 'dispatchState' | 'verificationStatus'>): boolean {
  const queue = deriveQueue(order);
  return queue !== null && REASON_QUEUES.includes(queue);
}

const iso = (date: Date | null): string | null => (date === null ? null : date.toISOString());

/**
 * Builds the staff view of one order.
 *
 * @param row the order with its joined names
 * @param extras the dispatch count and the review reason read for the page
 * @returns the view the console reads
 */
export function toStaffOrder(
  row: OrderRow,
  extras: { readonly attempts: number; readonly reason: string | null },
): StaffOrderView {
  const { order } = row;
  return {
    id: order.id,
    createdAt: order.createdAt.toISOString(),
    taxAmount: order.taxAmount,
    currency: order.currency,
    dispatchState: order.dispatchState,
    imei: order.imei ?? '',
    quantity: order.quantity,
    inputs: order.inputs as JsonObject,
    unitPrice: order.unitPrice,
    totalPrice: order.totalPrice,
    unitCost: order.unitCost,
    totalCost: order.totalCost,
    pricingSnapshot: order.pricingSnapshot as JsonObject,
    status: order.status,
    queue: deriveQueue(order),
    reviewReason: carriesReason(order) ? extras.reason : null,
    channel: order.clientId === null ? 'b2c' : 'b2b',
    source: order.source,
    service: {
      id: order.serviceId,
      name: row.serviceName,
      type: order.type,
      slaMinutes: row.slaMinutes,
      category: row.categoryName,
    },
    client: order.clientId === null ? null : { id: order.clientId, name: row.clientName ?? '' },
    customer:
      order.customerId === null
        ? null
        : { id: order.customerId, name: row.customerName ?? '', email: row.customerEmail ?? '' },
    supplier: order.supplierId === null ? null : { id: order.supplierId, name: row.supplierName ?? '' },
    supplierRef: order.supplierRef,
    attempts: extras.attempts,
    result: { code: order.resultCode, comment: order.resultComment, fileId: order.resultFileId },
    verificationStatus: order.verificationStatus,
    inputFileId: order.inputFileId,
    clientNote: order.clientNote,
    adminNote: order.adminNote,
    sentAt: iso(order.sentAt),
    completedAt: iso(order.completedAt),
  };
}

/** One timeline line as the console reads it. */
export interface StaffEventView {
  readonly id: number;
  readonly type: OrderEventType;
  readonly fromStatus: OrderStatus | null;
  readonly toStatus: OrderStatus | null;
  readonly actor: { type: OrderEventActorType; id: number | null; name: string | null };
  readonly data: JsonObject;
  readonly createdAt: string;
}

/**
 * Builds a staff timeline line.
 *
 * @param event the stored event
 * @param actorName the actor's joined name, when it has one
 * @returns the line the console reads
 */
export function toStaffEvent(event: OrderEvent, actorName: string | undefined): StaffEventView {
  return {
    id: event.id,
    type: event.type,
    fromStatus: event.fromStatus,
    toStatus: event.toStatus,
    actor: { type: event.actorType, id: event.actorId, name: actorName ?? null },
    data: event.data as JsonObject,
    createdAt: event.createdAt.toISOString(),
  };
}

/** The order as the merchant portal reads it: what the merchant paid and got, never cost, supplier, notes or risk. */
export interface MerchantOrderView {
  readonly id: number;
  readonly status: OrderStatus;
  readonly imei: string;
  readonly quantity: number;
  readonly inputs: JsonObject;
  readonly unitPrice: string;
  readonly totalPrice: string;
  readonly currency: string;
  readonly service: { id: number; name: string; type: Order['type'] };
  readonly source: OrderSource;
  readonly result: { code: string | null; comment: string | null; fileId: number | null };
  readonly verificationStatus: OrderVerificationStatus | null;
  readonly clientNote: string | null;
  readonly inputFileId: number | null;
  readonly canCancel: boolean;
  readonly canVerify: boolean;
  readonly createdAt: string;
  readonly completedAt: string | null;
}

const HOUR_MS = 3_600_000;

/**
 * Tells whether the merchant may cancel the order now.
 *
 * Why: decision 025: only while the order was never sent (`pending`, `manual` or `held`) and the service allows it.
 *
 * @param row the order with its service's rules
 * @returns true when `POST /client/orders/:id/cancel` would be accepted
 */
export function canCancel(row: OrderRow): boolean {
  const { order } = row;
  return (
    row.allowCancel &&
    (order.status === 'pending' || order.status === 'processing') &&
    (order.dispatchState === 'pending' || order.dispatchState === 'manual' || order.dispatchState === 'held')
  );
}

/**
 * Tells whether the merchant may ask for verification now.
 *
 * Why: ANSWERS orders Q11: on a completed order, once, within `verify_window_h` hours of completion, when the service allows it.
 *
 * @param row the order with its service's rules
 * @param now the injected clock's time
 * @returns true when `POST /client/orders/:id/verify` would be accepted
 */
export function canVerify(row: OrderRow, now: Date): boolean {
  const { order } = row;
  return (
    row.allowVerify &&
    order.status === 'completed' &&
    order.verificationStatus === null &&
    order.completedAt !== null &&
    now.getTime() - order.completedAt.getTime() <= row.verifyWindowH * HOUR_MS
  );
}

/**
 * Builds the merchant view of one order.
 *
 * @param row the order with its joined names and its service's rules
 * @param now the injected clock's time (the verify window)
 * @returns the view the portal reads
 */
export function toMerchantOrder(row: OrderRow, now: Date): MerchantOrderView {
  const { order } = row;
  return {
    id: order.id,
    status: order.status,
    imei: order.imei ?? '',
    quantity: order.quantity,
    inputs: order.inputs as JsonObject,
    unitPrice: order.unitPrice,
    totalPrice: order.totalPrice,
    currency: order.currency,
    service: { id: order.serviceId, name: row.serviceName, type: order.type },
    source: order.source,
    result: { code: order.resultCode, comment: order.resultComment, fileId: order.resultFileId },
    verificationStatus: order.verificationStatus,
    clientNote: order.clientNote,
    inputFileId: order.inputFileId,
    canCancel: canCancel(row),
    canVerify: canVerify(row, now),
    createdAt: order.createdAt.toISOString(),
    completedAt: iso(order.completedAt),
  };
}

/** The timeline types a merchant may see: nothing about suppliers, risk, notes or the settlement (it shows the cost). */
export const MERCHANT_EVENT_TYPES = [
  'created',
  'hold',
  'accepted',
  'completed',
  'rejected',
  'release',
  'refund',
  'reopened',
  'verification',
] as const satisfies readonly OrderEventType[];

/** One timeline line as the merchant reads it. */
export interface MerchantEventView {
  readonly id: number;
  readonly type: OrderEventType;
  readonly message: string;
  readonly createdAt: string;
}

/**
 * Builds a merchant timeline line.
 *
 * @param event the stored event
 * @returns id, type, the console's sentence and the time
 */
export function toMerchantEvent(event: OrderEvent): MerchantEventView {
  const message = event.data.message;
  return {
    id: event.id,
    type: event.type,
    message: typeof message === 'string' ? message : '',
    createdAt: event.createdAt.toISOString(),
  };
}
