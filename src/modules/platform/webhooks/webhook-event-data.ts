// Builds the `data` of a merchant's webhook event from what the outbox row carries and, where the row only has ids, from
// Postgres. One function per event, all returning public fields only (ALIGNMENT § 7, decision 017).
import type { z } from 'zod';
import type { EventContract } from '../../../common/contract';
import type { DbExecutor } from '../../../infra/db';
import type { OutboxJobData } from '../outbox/outbox.types';
import { invoiceForEvent, orderForEvent, serviceNameOf } from './webhook-foreign-reads';
import { invoicePaid, orderStatusChanged, servicePriceChanged, walletLowBalance } from './webhook-events';
import type { WebhookEventName } from './webhook-delivery.rules';

/** The contract of each subscribable event, by its type. */
export const EVENT_CONTRACTS: Readonly<Record<WebhookEventName, EventContract<z.ZodType>>> = {
  'order.status_changed': orderStatusChanged,
  'wallet.low_balance': walletLowBalance,
  'invoice.paid': invoicePaid,
  'service.price_changed': servicePriceChanged,
};

/** What the builder found: the merchant the event is for and the fields to send. */
export interface BuiltEvent {
  readonly clientId: number;
  readonly data: Record<string, unknown>;
}

const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const whole = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isInteger(value) ? value : undefined;

/**
 * Builds the data of an event.
 *
 * Why: the outbox row carries ids (decision 020); the merchant receives the public fields. A row whose source is gone (a deleted
 * order, a storefront order) has nothing to send. The caller checks the result against the event's contract before it is sent.
 *
 * @param db the database or a transaction
 * @param job the outbox job of the event
 * @param createdAt when the event was written (the fallback for a time the source lacks)
 * @returns the merchant and the data, or `undefined` when there is nothing to send
 */
export async function buildEventData(
  db: DbExecutor,
  job: Pick<OutboxJobData, 'type' | 'aggregateId' | 'payload'>,
  createdAt: Date,
): Promise<BuiltEvent | undefined> {
  const { payload } = job;
  const clientId = whole(payload['clientId']);
  switch (job.type) {
    case 'order.status_changed': {
      const order = await orderForEvent(db, whole(payload['orderId']) ?? job.aggregateId);
      const fromStatus = text(payload['fromStatus']);
      const toStatus = text(payload['toStatus']);
      if (!order || fromStatus === undefined || toStatus === undefined) return undefined;
      if (clientId !== undefined && clientId !== order.clientId) return undefined;
      return {
        clientId: order.clientId,
        data: {
          orderId: order.orderId,
          serviceId: order.serviceId,
          serviceName: order.serviceName,
          status: toStatus,
          previousStatus: fromStatus,
          imei: order.imei,
          quantity: order.quantity,
          unitPrice: order.unitPrice,
          totalPrice: order.totalPrice,
          currency: order.currency,
          resultCode: order.resultCode,
          resultComment: order.resultComment,
          placedAt: order.placedAt.toISOString(),
          completedAt: order.completedAt?.toISOString() ?? null,
        },
      };
    }
    case 'wallet.low_balance': {
      const currency = text(payload['currency']);
      const available = text(payload['available']);
      const threshold = text(payload['threshold']);
      if (clientId === undefined || currency === undefined || available === undefined || threshold === undefined) {
        return undefined;
      }
      return { clientId, data: { currency, available, threshold } };
    }
    case 'invoice.paid': {
      const invoice = await invoiceForEvent(db, whole(payload['invoiceId']) ?? job.aggregateId);
      if (!invoice || (clientId !== undefined && clientId !== invoice.clientId)) return undefined;
      return {
        clientId: invoice.clientId,
        data: {
          invoiceId: invoice.invoiceId,
          number: invoice.number,
          amount: invoice.amount,
          currency: invoice.currency,
          paidAt: (invoice.paidAt ?? createdAt).toISOString(),
        },
      };
    }
    case 'service.price_changed': {
      const serviceId = whole(payload['serviceId']) ?? job.aggregateId;
      const price = text(payload['price']);
      const currency = text(payload['currency']);
      const serviceName = await serviceNameOf(db, serviceId);
      if (clientId === undefined || price === undefined || currency === undefined || serviceName === undefined) {
        return undefined;
      }
      return {
        clientId,
        data: { serviceId, serviceName, previousPrice: text(payload['previousPrice']) ?? null, price, currency },
      };
    }
    default:
      return undefined;
  }
}
