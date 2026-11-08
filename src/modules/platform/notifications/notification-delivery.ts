// NotificationDelivery: one attempt to send one `notifications` row (platform module, feature 12a): re-read the row, the recipient and the
// template, render, hand the message to the channel, and record the result with the attempt on the row (decision 020).
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Counter } from 'prom-client';
import { CLOCK, type Clock } from '../../../common/clock';
import { DbService } from '../../../infra/db';
import { MetricsService } from '../../../infra/metrics';
import type { Notification } from '../db/schema';
import { DeliveryError } from './delivery-error';
import { describeChanges } from './digest-rules';
import { MailTransport } from './mail-transport';
import { choiceFor } from './merchant-preferences';
import { NotificationEventRegistry } from './notification-events';
import { asString, itemsOf, variablesOf } from './notification-payload';
import {
  type NotificationPayload,
  closeDigest,
  findNotification,
  markFailed,
  markSent,
  recordAttempt,
} from './notification.repository';
import { findTemplateFor } from './notification-template.repository';
import { recipientOf } from './notification-foreign-reads';
import { TelegramClient } from './telegram-client';
import { renderMessage } from './template-rules';

/** Where a job stands in its retries: BullMQ's `attemptsMade + 1` and the queue's `attempts`. */
export interface AttemptContext {
  /** The number of this attempt, from 1. */
  readonly attempt: number;
  /** How many attempts the queue allows. */
  readonly maxAttempts: number;
}

/** What one attempt did. */
export type DeliveryOutcome =
  | { readonly outcome: 'sent' }
  /** The row is `failed` for good; the reason is on the row. */
  | { readonly outcome: 'failed'; readonly reason: string }
  /** Nothing to do: the row is gone or already finished. */
  | { readonly outcome: 'skipped'; readonly reason: 'gone' | 'already_sent' | 'already_failed' };

/**
 * Sends the notifications.
 *
 * Why: one delivery path (brief 12a). The `notification.send` job and the merchant mail jobs both end here, so every message is
 * rendered, sent, retried and logged the same way. A send is at least once (decision 033): the row is marked sent only after the
 * channel accepted the message, with a guarded update, so a job that runs twice cannot record two sends; a crash between the
 * channel's answer and that update sends once more, and the `Message-ID` (derived from the row id) lets a provider that dedupes drop it.
 *
 * Failures: a permanent refusal (no template, no address, a recipient who is suspended or turned the message off since the row was
 * made, a mailbox that does not exist, a chat that blocked the bot) marks the row `failed` at once; a transient one records the attempt and throws, so the queue retries with its backoff (5 attempts, 30 s,
 * decision 020), and the last attempt marks the row `failed` before it throws. Reasons are cleaned of addresses.
 *
 * Side effects: reads and updates `notifications`; reads the recipient's table and `notification_templates`; sends one email or
 * Telegram message; counts `notification_deliveries_total{channel,outcome}`.
 *
 * @see docs/queues.md (notifications) and docs/decisions/033-mail-delivery.md
 */
@Injectable()
export class NotificationDelivery {
  private readonly logger = new Logger(NotificationDelivery.name);
  private readonly counter: Counter<'channel' | 'outcome'>;

  constructor(
    private readonly db: DbService,
    private readonly registry: NotificationEventRegistry,
    private readonly mail: MailTransport,
    private readonly telegram: TelegramClient,
    @Inject(CLOCK) private readonly clock: Clock,
    metrics: MetricsService,
  ) {
    this.counter = new Counter({
      name: 'notification_deliveries_total',
      help: 'Notification send attempts, by channel and outcome (sent, retry, failed).',
      labelNames: ['channel', 'outcome'],
      registers: [metrics.registry],
    });
  }

  /**
   * Makes one attempt to send a notification.
   *
   * @param id the `notifications` row
   * @param context the attempt number and how many the queue allows
   * @param secrets values that fill placeholders but are never stored (the link of a merchant mail)
   * @returns what happened; a transient failure is thrown instead
   * @throws {DeliveryError} for a transient failure (the row keeps `queued` until the last attempt, then becomes `failed`), so the queue retries
   * @throws {Error} when Postgres fails (the row is untouched and the job is retried)
   */
  async deliver(
    id: number,
    context: AttemptContext,
    secrets: Readonly<Record<string, string>> = {},
  ): Promise<DeliveryOutcome> {
    let row = await findNotification(this.db.db, id);
    if (!row) return { outcome: 'skipped', reason: 'gone' };
    if (row.status === 'sent') return { outcome: 'skipped', reason: 'already_sent' };
    if (row.status === 'failed') return { outcome: 'skipped', reason: 'already_failed' };

    try {
      // A digest row collects changes until now: close it first, so nothing joins it between this read and the send.
      if (Array.isArray((row.payload as NotificationPayload).items)) {
        const closed = await closeDigest(this.db.db, row.id, this.clock.now());
        if (!closed) return { outcome: 'skipped', reason: 'already_sent' };
        row = closed;
      }
      await this.send(row, secrets);
    } catch (error) {
      if (!(error instanceof DeliveryError)) throw error;
      const last = context.attempt >= context.maxAttempts;
      if (error.permanent || last) {
        const marked = await markFailed(this.db.db, row.id, context.attempt, error.message, this.clock.now());
        this.logger.warn(`Notification ${row.id} (${row.event}, ${row.channel}) failed for good: ${error.message}`);
        this.counter.inc({ channel: row.channel, outcome: 'failed' });
        if (error.permanent || !marked) return { outcome: 'failed', reason: error.message };
        throw error;
      }
      await recordAttempt(this.db.db, row.id, context.attempt, this.clock.now());
      this.counter.inc({ channel: row.channel, outcome: 'retry' });
      throw error;
    }

    await markSent(this.db.db, row.id, context.attempt, this.clock.now());
    this.counter.inc({ channel: row.channel, outcome: 'sent' });
    return { outcome: 'sent' };
  }

  /** Renders the row's message and hands it to its channel. */
  private async send(row: Notification, secrets: Readonly<Record<string, string>>): Promise<void> {
    const recipient = await recipientOf(this.db.db, row.recipientType, row.recipientId);
    if (!recipient) throw new DeliveryError('The recipient no longer exists.', { permanent: true });
    const definition = this.registry.get(row.event, recipient.audience);
    if (!definition)
      throw new DeliveryError(`The event "${row.event}" is not registered for ${recipient.audience}.`, {
        permanent: true,
      });
    // The row may be older than the recipient's current state (a digest waits up to a day, a retry waits minutes): the merchant's
    // choice and a suspension are read again here, so "opted out" and "suspended" hold at the moment of sending (B165).
    if (!definition.transactional) {
      if (recipient.suspended) throw new DeliveryError('The recipient is suspended.', { permanent: true });
      if (recipient.audience === 'merchant' && !choiceFor(definition, recipient.prefs)[row.channel])
        throw new DeliveryError('The merchant turned this message off.', { permanent: true });
    }
    const template = await findTemplateFor(this.db.db, {
      event: row.event,
      channel: row.channel,
      audience: recipient.audience,
      locale: recipient.locale,
    });
    if (!template) throw new DeliveryError('There is no template for this message.', { permanent: true });
    if (!template.isActive) throw new DeliveryError('The template is switched off.', { permanent: true });

    const payload = row.payload as NotificationPayload;
    const variables: Record<string, string> = { ...variablesOf(payload), ...secrets };
    const items = itemsOf(payload);
    if (Array.isArray(payload.items)) {
      variables['count'] = String(items.length);
      variables['changes'] = describeChanges(items);
    }
    const message = renderMessage(template, variables);

    if (row.channel === 'email') {
      if (!/^[^\s@]+@[^\s@]+$/.test(recipient.email))
        throw new DeliveryError('The recipient has no email address.', { permanent: true });
      await this.mail.send({
        to: recipient.email,
        subject: message.subject,
        text: message.text,
        ...(message.html === undefined ? {} : { html: message.html }),
        messageId: this.messageId(row.id),
      });
      return;
    }
    const chatId = asString(payload.chatId) ? payload.chatId : recipient.telegramChatId;
    if (!chatId) throw new DeliveryError('Telegram is not linked.', { permanent: true });
    await this.telegram.sendMessage(chatId, message.text);
  }

  /** The `Message-ID` of a row: stable across retries, so a provider that dedupes sees one message. */
  private messageId(id: number): string {
    const domain = /@([^>\s]+)>?\s*$/.exec(this.mail.from)?.[1] ?? 'gsm.invalid';
    return `<notification-${id}@${domain}>`;
  }
}
