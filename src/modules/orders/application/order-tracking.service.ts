// OrderTrackingService: what the holder of a tracking token sees of an order (feature 14a, map `GET /store/v1/orders/:token`).
import { Injectable } from '@nestjs/common';
import type { ResultOf } from '../../../common/contract';
import { AppError } from '../../../common/errors';
import { DbService } from '../../../infra/db';
import type { SERVICE_TYPES } from '../../catalog';
import type { trackStoreOrder } from '../contracts/order-tracking.contracts';
import { TRACKING_EVENT_TYPES, TRACKING_EVENT_WORDS, maskInput } from '../domain/tracking';
import { findOrderEventsOfTypes, findTrackedOrder } from '../infra/tracking.repository';

/** What the route answers. */
export type TrackedOrderView = ResultOf<typeof trackStoreOrder>;

/**
 * Builds the public tracking view of an order.
 *
 * Why: the buyer of a storefront order follows it by a link with an unguessable token and no account (map: "tracking page by token:
 * status, result and timeline"). Everything staff-only stays out: no supplier, no cost, no risk hold (a held order simply reads
 * `pending`), no internal note, and the main input is masked. The timeline uses fixed words for the few event types a buyer cares
 * about, never the stored `data.message`.
 *
 * Side effects: none (reads only).
 */
@Injectable()
export class OrderTrackingService {
  constructor(private readonly db: DbService) {}

  /**
   * Reads one order for its token holder.
   *
   * @param orderId the order id the token resolved to
   * @returns the tracking view
   * @throws {AppError} `NOT_FOUND` when the order no longer exists
   */
  async show(orderId: number): Promise<TrackedOrderView> {
    const row = await findTrackedOrder(this.db.db, orderId);
    if (!row) throw new AppError('NOT_FOUND', { detail: 'This link is not valid.' });
    const { order } = row;
    const events = await findOrderEventsOfTypes(this.db.db, order.id, TRACKING_EVENT_TYPES);
    return {
      status: order.status,
      service: {
        name: row.serviceName,
        type: row.serviceType as (typeof SERVICE_TYPES)[number],
        deliveryTime: row.deliveryTime,
      },
      input: maskInput(order.imei),
      quantity: order.quantity,
      placedAt: order.placedAt.toISOString(),
      completedAt: order.completedAt?.toISOString() ?? null,
      result: order.status === 'completed' ? { code: order.resultCode, comment: order.resultComment } : null,
      timeline: events.flatMap((event) => {
        const message = TRACKING_EVENT_WORDS[event.type as keyof typeof TRACKING_EVENT_WORDS];
        return message === undefined ? [] : [{ type: event.type, message, createdAt: event.createdAt.toISOString() }];
      }),
    };
  }
}
