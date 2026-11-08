// EventNotifier: turns an outbox event that a merchant may want to hear about into notifications (platform module, feature 12a): low
// balance, an order result, a paid invoice, an approved deposit, and the daily digest of price changes.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import { DbService } from '../../../infra/db';
import { QueuesService, UnrecoverableError, queueJobId } from '../../../infra/queues';
import type { OutboxJobData } from '../outbox/outbox.types';
import { WALLET_LOW_BALANCE_EVENT, SERVICE_PRICE_CHANGED_EVENT } from '../webhooks/merchant-event-routes';
import { invoiceForEvent, serviceNameOf } from '../webhooks/webhook-foreign-reads';
import { addDigestItem, digestCycleOf, digestKey, digestSendDelay, shortMoney, type DigestItem } from './digest-rules';
import { channelsFor } from './merchant-preferences';
import { NotificationEventRegistry } from './notification-events';
import { orderFacts, recipientOf } from './notification-foreign-reads';
import { itemsOf } from './notification-payload';
import { NOTIFICATION_SEND_EVENT, NotificationService } from './notification.service';
import {
  type NotificationPayload,
  findNotificationByKey,
  insertNotificationOnce,
  setPayload,
} from './notification.repository';
import type { NotificationChannel } from '../db/schema';

/** The outbox event type of a paid invoice (written by feature 8, whose merge adds its `notifications` route). */
export const INVOICE_PAID_EVENT = 'invoice.paid';
/** The outbox event type of an approved deposit (written by feature 8, whose merge adds its `notifications` route). */
export const DEPOSIT_APPROVED_EVENT = 'deposit.approved';
/** The outbox event type of an order's status change (registered by the orders module). */
export const ORDER_STATUS_CHANGED_EVENT = 'order.status_changed';
/** The job name of the planning job: it handles the outbox events routed to `notifications` for merchants. */
export const NOTIFICATION_PLAN_JOB = 'notification.plan';
/** The job name of the sending job. */
export const NOTIFICATION_SEND_JOB = NOTIFICATION_SEND_EVENT;

/** What the planning job did (kept briefly with the BullMQ job). */
export interface PlanResult {
  /** Notifications made now (the others existed from an earlier run of the same job). */
  readonly created: number;
  /** Why nothing was made. */
  readonly skipped?: string;
}

const whole = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isInteger(value) ? value : undefined;
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

/**
 * Plans the notifications of an outbox event.
 *
 * Why: brief 12a. The events reach the `notifications` queue next to the merchant webhooks (decision 020 amended: one job per route).
 * This job decides who hears about it and how: the merchant's own preferences pick the channels (`merchant-preferences.ts`), a message
 * needs an active template, and each notification is a row plus a `notification.send` event written in one transaction. The job is safe
 * to run twice: the dedupe key of a row is `outbox-<event id>:<channel>`, so a retry after a crash finds the rows and writes nothing new.
 * The price change event does not send at once: it joins the merchant's digest row for the day (one email or Telegram message a day,
 * user rule 9).
 *
 * Side effects: inserts `notifications` and `outbox_events` rows; for a new digest row adds a delayed `notification.send` job.
 *
 * @see docs/queues.md (notifications)
 */
@Injectable()
export class EventNotifier {
  constructor(
    private readonly db: DbService,
    private readonly notifications: NotificationService,
    private readonly registry: NotificationEventRegistry,
    private readonly queues: QueuesService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Handles one outbox event.
   *
   * @param job the outbox job (`type`, `aggregateId`, ids in `payload`)
   * @returns what was made, or why nothing was
   * @throws {UnrecoverableError} when the event is one this job knows but carries no merchant (a programming error: retrying cannot help)
   * @throws {Error} when Postgres or the queue Redis fails (the job is retried; the dedupe keys make that safe)
   */
  async plan(job: OutboxJobData): Promise<PlanResult> {
    switch (job.type) {
      case ORDER_STATUS_CHANGED_EVENT:
        return this.orderResult(job);
      case WALLET_LOW_BALANCE_EVENT:
        return this.lowBalance(job);
      case INVOICE_PAID_EVENT:
        return this.invoicePaid(job);
      case DEPOSIT_APPROVED_EVENT:
        return this.depositApproved(job);
      case SERVICE_PRICE_CHANGED_EVENT:
        return this.priceChanged(job);
      default:
        return { created: 0, skipped: 'unknown_event' };
    }
  }

  /** `order.completed` or `order.failed` for a merchant that chose them. */
  private async orderResult(job: OutboxJobData): Promise<PlanResult> {
    const clientId = job.payload['clientId'];
    // A storefront order has no merchant: its customer mails belong to the storefront features.
    if (clientId === null) return { created: 0, skipped: 'no_merchant' };
    const toStatus = text(job.payload['toStatus']);
    const key = toStatus === 'completed' ? 'order.completed' : toStatus === 'rejected' ? 'order.failed' : undefined;
    if (key === undefined) return { created: 0, skipped: 'not_notified' };
    const orderId = whole(job.payload['orderId']) ?? job.aggregateId;
    const facts = await orderFacts(this.db.db, orderId);
    if (!facts || (typeof clientId === 'number' && clientId !== facts.clientId))
      return { created: 0, skipped: 'source_gone' };
    return this.notifyMerchant(job, key, facts.clientId, (merchantName) => ({
      merchantName,
      orderId: String(facts.orderId),
      service: facts.serviceName,
      resultCode: facts.resultCode,
      resultComment: facts.resultComment,
    }));
  }

  /** `wallet.low_balance`. */
  private async lowBalance(job: OutboxJobData): Promise<PlanResult> {
    const clientId = this.merchantOf(job);
    const currency = text(job.payload['currency']);
    const available = text(job.payload['available']);
    const threshold = text(job.payload['threshold']);
    if (currency === undefined || available === undefined || threshold === undefined) {
      throw new UnrecoverableError(`The ${job.type} event ${job.eventId} lacks its figures.`);
    }
    return this.notifyMerchant(job, 'wallet.low_balance', clientId, (merchantName) => ({
      merchantName,
      currency,
      available: shortMoney(available),
      threshold: shortMoney(threshold),
    }));
  }

  /** `invoice.paid`: feature 8 writes it with the invoice as the aggregate. */
  private async invoicePaid(job: OutboxJobData): Promise<PlanResult> {
    const invoice = await invoiceForEvent(this.db.db, whole(job.payload['invoiceId']) ?? job.aggregateId);
    if (!invoice) return { created: 0, skipped: 'source_gone' };
    return this.notifyMerchant(job, 'invoice.paid', invoice.clientId, (merchantName) => ({
      merchantName,
      invoiceNumber: invoice.number,
      amount: shortMoney(invoice.amount),
      currency: invoice.currency,
    }));
  }

  /** `deposit.approved`: feature 8 writes it with `clientId`, `amount` and `currency`. */
  private async depositApproved(job: OutboxJobData): Promise<PlanResult> {
    const clientId = this.merchantOf(job);
    const amount = text(job.payload['amount']);
    const currency = text(job.payload['currency']);
    if (amount === undefined || currency === undefined) {
      throw new UnrecoverableError(`The ${job.type} event ${job.eventId} lacks its amount.`);
    }
    return this.notifyMerchant(job, 'deposit.approved', clientId, (merchantName) => ({
      merchantName,
      amount: shortMoney(amount),
      currency,
    }));
  }

  /** The merchant of an event that must have one. */
  private merchantOf(job: OutboxJobData): number {
    const clientId = whole(job.payload['clientId']);
    if (clientId === undefined)
      throw new UnrecoverableError(`The ${job.type} event ${job.eventId} carries no clientId.`);
    return clientId;
  }

  /** Makes one notification per channel the merchant uses for the event, in one transaction. */
  private async notifyMerchant(
    job: OutboxJobData,
    key: string,
    clientId: number,
    variables: (merchantName: string) => Record<string, string>,
  ): Promise<PlanResult> {
    return this.db.runInTransaction(async ({ tx }) => {
      const merchant = await recipientOf(tx, 'client', clientId);
      if (!merchant) return { created: 0, skipped: 'merchant_gone' };
      const definition = this.registry.get(key, 'merchant');
      if (!definition) return { created: 0, skipped: 'unknown_event' };
      const channels = channelsFor(definition, merchant.prefs, merchant.telegramChatId !== null);
      if (channels.length === 0) return { created: 0, skipped: 'opted_out' };
      let created = 0;
      let skipped: string | undefined;
      for (const channel of channels) {
        const result = await this.notifications.enqueue(
          { tx },
          {
            event: key,
            recipient: { type: 'client', id: clientId },
            channel,
            variables: variables(merchant.name),
            dedupeKey: `outbox-${job.eventId}:${channel}`,
          },
        );
        if (result.status === 'queued' && result.created) created += 1;
        if (result.status === 'skipped') skipped = result.reason;
      }
      return created === 0 && skipped !== undefined ? { created, skipped } : { created };
    });
  }

  /** `service.price_changed`: joins the merchant's digest of the day on each channel it uses. */
  private async priceChanged(job: OutboxJobData): Promise<PlanResult> {
    const clientId = this.merchantOf(job);
    const serviceId = whole(job.payload['serviceId']) ?? job.aggregateId;
    const price = text(job.payload['price']);
    const currency = text(job.payload['currency']);
    const serviceName = await serviceNameOf(this.db.db, serviceId);
    if (price === undefined || currency === undefined || serviceName === undefined)
      return { created: 0, skipped: 'source_gone' };
    const item: DigestItem = {
      eventId: job.eventId,
      serviceId,
      serviceName,
      previousPrice: text(job.payload['previousPrice']) ?? null,
      price,
      currency,
    };
    const merchant = await recipientOf(this.db.db, 'client', clientId);
    if (!merchant) return { created: 0, skipped: 'merchant_gone' };
    const definition = this.registry.get('service.price_changed', 'merchant');
    if (!definition) return { created: 0, skipped: 'unknown_event' };
    const channels = channelsFor(definition, merchant.prefs, merchant.telegramChatId !== null);
    if (channels.length === 0) return { created: 0, skipped: 'opted_out' };
    let created = 0;
    for (const channel of channels) if (await this.collect(clientId, merchant.name, channel, item)) created += 1;
    return { created };
  }

  /**
   * Adds an item to the merchant's digest row of the current period, making the row (and the job that sends it) when it is the first.
   *
   * Why: the row is the digest: its `dedupe_key` names the merchant, channel and period, so one row exists per period. A row that was
   * closed by its send job (or sent) is left alone and the item joins the next period's row, so no change is lost and no second
   * message goes out in one period. The delayed send job is added inside the transaction, before the commit: if Redis is down the row is
   * rolled back and the planning job retries; a job whose row never committed finds nothing and ends. The job waits at least 10 seconds
   * (`digestSendDelay`), so it cannot run before the commit even for a change a few milliseconds before 06:00 UTC.
   *
   * @returns true when this call made the row
   */
  private async collect(
    clientId: number,
    merchantName: string,
    channel: NotificationChannel,
    item: DigestItem,
  ): Promise<boolean> {
    return this.db.runInTransaction(async ({ tx }) => {
      const check = await this.notifications.check(tx, {
        event: 'service.price_changed',
        recipient: { type: 'client', id: clientId },
        channel,
      });
      if ('skipped' in check) return false;
      const now = this.clock.now();
      let cycle = digestCycleOf(now);
      // One hop is enough: the next period's row cannot be closed before it exists.
      for (let hop = 0; hop < 2; hop += 1) {
        const key = digestKey('service.price_changed', channel, clientId, cycle);
        const payload: NotificationPayload = { variables: { merchantName }, items: [item], cycle: cycle.day };
        const { row, created } = await insertNotificationOnce(tx, {
          recipientType: 'client',
          recipientId: clientId,
          channel,
          event: 'service.price_changed',
          payload,
          status: 'queued',
          dedupeKey: key,
          createdAt: now,
          updatedAt: now,
        });
        if (created) {
          await this.queues.add(
            'notifications',
            NOTIFICATION_SEND_JOB,
            { notificationId: row.id },
            { jobId: queueJobId('notification', row.id), delay: digestSendDelay(cycle, now) },
          );
          return true;
        }
        const locked = await findNotificationByKey(tx, key, true);
        const stored = (locked?.payload ?? {}) as NotificationPayload;
        if (!locked || locked.status !== 'queued' || stored.closed === true) {
          cycle = digestCycleOf(cycle.sendAt);
          continue;
        }
        const existing = itemsOf(stored);
        const items = addDigestItem(existing, item);
        if (items.length !== existing.length) await setPayload(tx, locked.id, { ...stored, items }, now);
        return false;
      }
      return false;
    });
  }
}
