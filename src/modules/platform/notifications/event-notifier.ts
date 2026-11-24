// EventNotifier: turns an outbox event that an account holding a merchant wallet may want to hear about into notifications (platform module,
// feature 12a): low balance, an order result, a paid invoice, an approved deposit, and the daily digest of price changes. The text is the
// merchant's by the door of the order or the kind of the wallet, never by the rank the account holds when the job runs (decision 064).
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import { DbService } from '../../../infra/db';
import { QueuesService, UnrecoverableError, queueJobId } from '../../../infra/queues';
import type { OutboxJobData } from '../outbox/outbox.types';
import { addDigestItem, digestCycleOf, digestKey, digestSendDelay, shortMoney, type DigestItem } from './digest-rules';
import { NotificationInbox } from './inbox/notification-inbox';
import { channelsFor } from './merchant-preferences';
import { NotificationEventRegistry } from './notification-events';
import { invoiceFacts, orderFacts, recipientOf, serviceNameOf, withAudience } from './notification-foreign-reads';
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
/** The outbox event type of an order's status change (written by the orders module). */
export const ORDER_STATUS_CHANGED_EVENT = 'order.status_changed';
/** The outbox event type of the low-balance alert (written by the money module's posting hook). */
export const WALLET_LOW_BALANCE_EVENT = 'wallet.low_balance';
/** The outbox event type of a price change (written by the catalog's price change scan). */
export const SERVICE_PRICE_CHANGED_EVENT = 'service.price_changed';
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
 * Why: brief 12a. The events reach the `notifications` queue (decision 020: the relay adds one job per route of an event type).
 * This job decides who hears about it and how: the merchant's own preferences pick the channels (`merchant-preferences.ts`), a message
 * needs an active template, and each notification is a row plus a `notification.send` event written in one transaction. The job is safe
 * to run twice: the dedupe key of a row is `outbox-<event id>:<channel>`, so a retry after a crash finds the rows and writes nothing new.
 * The price change event does not send at once: it joins the merchant's digest row for the day (one email a day,
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
    private readonly inbox: NotificationInbox,
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
      case SERVICE_PRICE_CHANGED_EVENT:
        return this.priceChanged(job);
      default:
        return { created: 0, skipped: 'unknown_event' };
    }
  }

  /**
   * `order.completed` or `order.failed` for an account that chose them, for an order held from a wallet.
   *
   * Why: the door decides whose notice applies (decision 064): an order of the `store` door is paid first through the shop and its mails
   * (the customer text, with the tracking link) belong to the storefront flows, whatever rank its account has today; any other door gets the
   * merchant text. The door is read from the order (the payload's is only a hint).
   */
  private async orderResult(job: OutboxJobData): Promise<PlanResult> {
    if (job.payload['source'] === 'store') return { created: 0, skipped: 'no_merchant' };
    const toStatus = text(job.payload['toStatus']);
    const key = toStatus === 'completed' ? 'order.completed' : toStatus === 'rejected' ? 'order.failed' : undefined;
    if (key === undefined) return { created: 0, skipped: 'not_notified' };
    const orderId = whole(job.payload['orderId']) ?? job.aggregateId;
    const facts = await orderFacts(this.db.db, orderId);
    // The order is gone, or it is not the one the event was about (the payload's account is a hint, never the recipient).
    const claimed = whole(job.payload['accountId']);
    if (!facts || (claimed !== undefined && claimed !== facts.accountId)) return { created: 0, skipped: 'source_gone' };
    if (facts.source === 'store') return { created: 0, skipped: 'no_merchant' };
    return this.notifyMerchant(job, key, facts.accountId, (merchantName) => ({
      merchantName,
      orderId: String(facts.orderId),
      service: facts.serviceName,
      resultCode: facts.resultCode,
      resultComment: facts.resultComment,
    }));
  }

  /** `wallet.low_balance` (only a merchant-kind wallet raises it). */
  private async lowBalance(job: OutboxJobData): Promise<PlanResult> {
    const accountId = this.accountOf(job);
    const currency = text(job.payload['currency']);
    const available = text(job.payload['available']);
    const threshold = text(job.payload['threshold']);
    if (currency === undefined || available === undefined || threshold === undefined) {
      throw new UnrecoverableError(`The ${job.type} event ${job.eventId} lacks its figures.`);
    }
    return this.notifyMerchant(job, 'wallet.low_balance', accountId, (merchantName) => ({
      merchantName,
      currency,
      available: shortMoney(available),
      threshold: shortMoney(threshold),
    }));
  }

  /**
   * `invoice.paid`: feature 8 writes it with the invoice as the aggregate.
   *
   * Why: a wallet mail follows the kind of the wallet the invoice fills (`client_wallet`: the merchant text); a receipt, a statement and the
   * top-up of a shop balance are not merchant mails, whatever rank the account holds now.
   */
  private async invoicePaid(job: OutboxJobData): Promise<PlanResult> {
    const invoice = await invoiceFacts(this.db.db, whole(job.payload['invoiceId']) ?? job.aggregateId);
    if (!invoice) return { created: 0, skipped: 'source_gone' };
    if (invoice.walletKind !== 'client_wallet') return { created: 0, skipped: 'no_merchant' };
    return this.notifyMerchant(job, 'invoice.paid', invoice.accountId, (merchantName) => ({
      merchantName,
      invoiceNumber: invoice.number,
      amount: shortMoney(invoice.amount),
      currency: invoice.currency,
    }));
  }

  /**
   * The account of an event that must have one.
   *
   * Why: decision 064: a job carries `accountId`. A merchant's number is its account id, so the older key `clientId` is
   * read as the same number; a customer number (`customerId`) is never read as an account id.
   */
  private accountOf(job: OutboxJobData): number {
    const accountId = whole(job.payload['accountId']) ?? whole(job.payload['clientId']);
    if (accountId === undefined)
      throw new UnrecoverableError(`The ${job.type} event ${job.eventId} carries no accountId.`);
    return accountId;
  }

  /**
   * Makes one notification per channel the account uses for the event, in one transaction.
   *
   * Why: the text is the merchant's (`audience: 'merchant'`) because the event is about a merchant door or a merchant wallet; the account's
   * own switches (`notification_prefs`) choose the channels.
   */
  private async notifyMerchant(
    job: OutboxJobData,
    key: string,
    accountId: number,
    variables: (merchantName: string) => Record<string, string>,
  ): Promise<PlanResult> {
    return this.db.runInTransaction(async ({ tx }) => {
      const found = await recipientOf(tx, 'account', accountId);
      if (!found) return { created: 0, skipped: 'merchant_gone' };
      const merchant = withAudience(found, 'merchant');
      const definition = this.registry.get(key, 'merchant');
      if (!definition) return { created: 0, skipped: 'unknown_event' };
      // Feature 23, S9: the in-app item comes before the channel check, so a merchant who switched email off still gets it;
      // the same occurrence key makes the item of `NotificationService.enqueue` below a no-op.
      await this.inbox.addForEvent(tx, {
        recipient: { type: 'account', id: accountId },
        event: key,
        variables: variables(merchant.name),
        occurrence: `outbox-${job.eventId}`,
        audience: 'merchant',
      });
      const channels = channelsFor(definition, merchant.prefs);
      if (channels.length === 0) return { created: 0, skipped: 'opted_out' };
      let created = 0;
      let skipped: string | undefined;
      for (const channel of channels) {
        const result = await this.notifications.enqueue(
          { tx },
          {
            event: key,
            recipient: { type: 'account', id: accountId },
            audience: 'merchant',
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

  /** `service.price_changed`: joins the digest of the day of an account of a merchant rank, on each channel it uses. */
  private async priceChanged(job: OutboxJobData): Promise<PlanResult> {
    const accountId = this.accountOf(job);
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
    const merchant = await recipientOf(this.db.db, 'account', accountId);
    if (!merchant) return { created: 0, skipped: 'merchant_gone' };
    // Prices of a merchant rank: an account that holds another rank now has no digest (its shop prices are not individual).
    if (merchant.audience !== 'merchant') return { created: 0, skipped: 'no_merchant' };
    const definition = this.registry.get('service.price_changed', 'merchant');
    if (!definition) return { created: 0, skipped: 'unknown_event' };
    const channels = channelsFor(definition, merchant.prefs);
    if (channels.length === 0) return { created: 0, skipped: 'opted_out' };
    let created = 0;
    for (const channel of channels) if (await this.collect(accountId, merchant.name, channel, item)) created += 1;
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
    accountId: number,
    merchantName: string,
    channel: NotificationChannel,
    item: DigestItem,
  ): Promise<boolean> {
    return this.db.runInTransaction(async ({ tx }) => {
      const check = await this.notifications.check(tx, {
        event: 'service.price_changed',
        recipient: { type: 'account', id: accountId },
        audience: 'merchant',
        channel,
      });
      if ('skipped' in check) return false;
      const now = this.clock.now();
      let cycle = digestCycleOf(now);
      // One hop is enough: the next period's row cannot be closed before it exists.
      for (let hop = 0; hop < 2; hop += 1) {
        const key = digestKey('service.price_changed', channel, accountId, cycle);
        const payload: NotificationPayload = {
          variables: { merchantName },
          items: [item],
          cycle: cycle.day,
          audience: 'merchant',
        };
        const { row, created } = await insertNotificationOnce(tx, {
          recipientType: 'account',
          recipientId: accountId,
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
