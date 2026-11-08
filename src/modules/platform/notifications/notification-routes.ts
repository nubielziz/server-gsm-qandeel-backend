// Registers the outbox routes of the notifications (platform module, decision 020 amended by feature 12a): the events a merchant is told
// about reach the `notifications` queue next to their other consumers, and `notification.send` is the event that sends one row.
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { OutboxRouteRegistry } from '../outbox/outbox-routes';
import { SERVICE_PRICE_CHANGED_EVENT, WALLET_LOW_BALANCE_EVENT } from '../webhooks/merchant-event-routes';
import { INVOICE_PAID_EVENT, NOTIFICATION_PLAN_JOB, ORDER_STATUS_CHANGED_EVENT } from './event-notifier';
import { NOTIFICATION_SEND_EVENT } from './notification.service';

/**
 * Routes the events that notifications are made from.
 *
 * Why: brief 12a: `order.status_changed`, `wallet.low_balance`, `service.price_changed` and feature 8's `invoice.paid` go to
 * `notifications` as well as to `merchant-webhooks` (their producers do not change); one job per route, the job name
 * `notification.plan`. `notification.send` is this feature's own event: the row and the event are written together, and the relay
 * turns the event into the sending job. `deposit.approved` has no route: every credited top-up already writes `invoice.paid`, so a
 * second event would tell the merchant twice (B-entry of 12a).
 *
 * Side effects: registers five routes with the `notifications` queue at boot (the API and the worker both load this class).
 */
@Injectable()
export class NotificationRoutes implements OnModuleInit {
  constructor(private readonly routes: OutboxRouteRegistry) {}

  /** Registers the routes. */
  onModuleInit(): void {
    for (const type of [
      ORDER_STATUS_CHANGED_EVENT,
      WALLET_LOW_BALANCE_EVENT,
      SERVICE_PRICE_CHANGED_EVENT,
      INVOICE_PAID_EVENT,
    ]) {
      this.routes.register({ type, queue: 'notifications', jobName: NOTIFICATION_PLAN_JOB });
    }
    this.routes.register({ type: NOTIFICATION_SEND_EVENT, queue: 'notifications' });
  }
}
