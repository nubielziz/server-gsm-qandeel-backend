// NotificationService: how other code makes a notification (platform module, feature 12a): `enqueue` writes the row and its send event in
// the caller's transaction; `sendNow` is for a job that holds a secret (the link of a merchant mail) and sends in the same job.
import { Inject, Injectable, Logger } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import { DbService, type DbExecutor, type TransactionContext } from '../../../infra/db';
import type { NotificationChannel, NotificationRecipientType, NotificationStatus } from '../db/schema';
import { OutboxService } from '../outbox/outbox.service';
import { type AttemptContext, NotificationDelivery } from './notification-delivery';
import { type NotificationEventDefinition, NotificationEventRegistry } from './notification-events';
import { type Recipient, recipientOf } from './notification-foreign-reads';
import { findTemplateFor } from './notification-template.repository';
import {
  type NotificationPayload,
  findNotificationByKey,
  insertNotificationOnce,
  markFailed,
} from './notification.repository';

/** The outbox event type and job name that sends one notification row; its aggregate is the row. */
export const NOTIFICATION_SEND_EVENT = 'notification.send';

/** What a caller asks for: one message to one recipient on one channel. */
export interface NotificationInput {
  /** A registered event key for the recipient's audience. */
  readonly event: string;
  readonly recipient: { readonly type: NotificationRecipientType; readonly id: number };
  readonly channel: NotificationChannel;
  /** The values of the event's placeholders. They are stored on the row and shown in the log: no secret goes here. */
  readonly variables?: Readonly<Record<string, string>>;
  /** A Telegram chat to use instead of the recipient's linked chat. */
  readonly chatId?: string;
  /** Names the occurrence, so a repeat makes no second row (`outbox-<id>:email`, `telegram-update-<id>`). */
  readonly dedupeKey?: string;
}

/** Why a notification was not made. */
export type SkipReason = 'recipient_gone' | 'recipient_suspended' | 'no_template' | 'template_off';

/** What `enqueue` did. */
export type EnqueueResult =
  | { readonly status: 'queued'; readonly id: number; readonly created: boolean }
  | { readonly status: 'skipped'; readonly reason: SkipReason };

/** What `sendNow` did. */
export type SendNowResult =
  | { readonly status: 'sent'; readonly id: number }
  | { readonly status: 'failed'; readonly id: number; readonly reason: string }
  | { readonly status: 'skipped'; readonly reason: SkipReason | 'already_sent' | 'already_failed' };

/**
 * Makes and sends notifications.
 *
 * Why: brief 12a: one delivery path. A use case (or the planning job of an outbox event) calls `enqueue` inside its transaction: the
 * `notifications` row (`queued`) and the outbox event `notification.send` commit together, so the message exists if and only if the
 * change did, and the relay turns the event into a job (decision 020). A missing or switched-off template is logged and sends
 * nothing (RULES settings 10), and a recipient that is gone or (for a message that is not transactional) suspended gets nothing.
 *
 * Side effects: `enqueue` inserts a `notifications` row (once per dedupe key) and an `outbox_events` row; `sendNow` also sends.
 *
 * @see docs/queues.md (notifications)
 */
@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);

  constructor(
    private readonly db: DbService,
    private readonly outbox: OutboxService,
    private readonly registry: NotificationEventRegistry,
    private readonly delivery: NotificationDelivery,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Writes a notification and the event that sends it, in the caller's transaction.
   *
   * @param work the caller's transaction (`runInTransaction`)
   * @param input the event, recipient, channel and variables
   * @returns the row id (and whether this call made it), or why nothing was made
   * @throws {RangeError} when the event is not registered for the recipient's audience, or the event has no such channel (a programming error)
   */
  async enqueue(work: Pick<TransactionContext, 'tx'>, input: NotificationInput): Promise<EnqueueResult> {
    const checked = await this.check(work.tx, input);
    if ('skipped' in checked) return { status: 'skipped', reason: checked.skipped };
    const now = this.clock.now();
    const payload: NotificationPayload = {
      variables: { ...(input.variables ?? {}) },
      ...(input.chatId === undefined ? {} : { chatId: input.chatId }),
    };
    const { row, created } = await insertNotificationOnce(work.tx, {
      recipientType: input.recipient.type,
      recipientId: input.recipient.id,
      channel: input.channel,
      event: input.event,
      payload,
      status: 'queued',
      dedupeKey: input.dedupeKey ?? null,
      createdAt: now,
      updatedAt: now,
    });
    // The event is written with the row, so a row made by an earlier run of this call already has its event.
    if (created) {
      await this.outbox.add(work.tx, {
        type: NOTIFICATION_SEND_EVENT,
        aggregateType: 'notifications',
        aggregateId: row.id,
      });
    }
    return { status: 'queued', id: row.id, created };
  }

  /**
   * Makes a notification and sends it in the calling job.
   *
   * Why: the verification, reset and invitation mails carry a link whose token exists in clear text only inside the job that rotated it
   * (RESOLUTIONS identity-platform-2, decision 019): it cannot travel through the outbox or sit in the payload. The row (dedupe key
   * `outbox-<event id>:email`, so a retry of the job finds it) holds the other variables; `secrets` fill the template and are never stored or logged.
   *
   * @param input the event, recipient, channel and non-secret variables (`dedupeKey` is required: the job retries)
   * @param secrets placeholders that must not be stored
   * @param context the job's attempt number and the queue's maximum
   * @returns what happened; a transient failure is thrown
   * @throws {DeliveryError} for a transient failure (the queue retries the job)
   * @throws {RangeError} when the event is not registered for the recipient's audience, or the event has no such channel
   */
  async sendNow(
    input: NotificationInput & { readonly dedupeKey: string },
    secrets: Readonly<Record<string, string>>,
    context: AttemptContext,
  ): Promise<SendNowResult> {
    const checked = await this.check(this.db.db, input);
    if ('skipped' in checked) return { status: 'skipped', reason: checked.skipped };
    const now = this.clock.now();
    const { row } = await insertNotificationOnce(this.db.db, {
      recipientType: input.recipient.type,
      recipientId: input.recipient.id,
      channel: input.channel,
      event: input.event,
      payload: { variables: { ...(input.variables ?? {}) } },
      status: 'queued',
      dedupeKey: input.dedupeKey,
      createdAt: now,
      updatedAt: now,
    });
    const result = await this.delivery.deliver(row.id, context, secrets);
    switch (result.outcome) {
      case 'sent':
        return { status: 'sent', id: row.id };
      case 'failed':
        return { status: 'failed', id: row.id, reason: result.reason };
      case 'skipped':
        return { status: 'skipped', reason: result.reason === 'gone' ? 'recipient_gone' : result.reason };
    }
  }

  /**
   * Tells where a notification with a dedupe key stands.
   *
   * Why: a job that holds a secret must not spend it on a message that was already delivered: the merchant mail job asks before it
   * rotates the link's token, because a rotation would invalidate the link of a mail that already arrived.
   *
   * @param dedupeKey the key the row was made with
   * @returns the row's status, or `undefined` when no row has the key
   */
  async statusOf(dedupeKey: string): Promise<NotificationStatus | undefined> {
    return (await findNotificationByKey(this.db.db, dedupeKey))?.status;
  }

  /**
   * Marks a still-queued notification failed with a reason, when its job gave up without sending.
   *
   * Why: an earlier attempt of a retried job made the row and failed in a way that may be retried; when a later attempt finds the mail no
   * longer worth sending (the link was used, the template was switched off, the merchant was suspended), nothing would ever finish the
   * row, and the log would show a `queued` message for ever. The guard `status = 'queued'` leaves a sent or failed row as it is.
   *
   * Side effects: updates the row if it is still `queued`.
   *
   * @param dedupeKey the key the row was made with
   * @param reason why nothing was sent (a short code; no address or secret)
   * @returns true when a queued row was marked failed
   */
  async abandon(dedupeKey: string, reason: string): Promise<boolean> {
    const row = await findNotificationByKey(this.db.db, dedupeKey);
    if (!row || row.status !== 'queued') return false;
    const marked = await markFailed(this.db.db, row.id, row.attempts, reason, this.clock.now());
    if (marked) this.logger.warn(`Notification ${row.id} (${row.event}, ${row.channel}) was not sent: ${reason}.`);
    return marked;
  }

  /**
   * Looks up what a notification needs before a row is made: the recipient, the event and an active template.
   *
   * @param db the database or a transaction
   * @param input the event, recipient and channel to check
   * @returns the recipient and the event, or the reason to skip
   * @throws {RangeError} when the event is not registered for the recipient's audience, or the event has no such channel
   */
  async check(
    db: DbExecutor,
    input: NotificationInput,
  ): Promise<{ recipient: Recipient; definition: NotificationEventDefinition } | { skipped: SkipReason }> {
    const recipient = await recipientOf(db, input.recipient.type, input.recipient.id);
    if (!recipient) return { skipped: 'recipient_gone' };
    const definition = this.registry.get(input.event, recipient.audience);
    if (!definition) {
      throw new RangeError(`The event "${input.event}" is not registered for the audience "${recipient.audience}".`);
    }
    if (!definition.channels.includes(input.channel)) {
      throw new RangeError(`The event "${input.event}" cannot be sent by ${input.channel}.`);
    }
    if (recipient.suspended && !definition.transactional) return { skipped: 'recipient_suspended' };
    const template = await findTemplateFor(db, {
      event: input.event,
      channel: input.channel,
      audience: recipient.audience,
      locale: recipient.locale,
    });
    if (!template) {
      this.logger.warn(`No ${input.channel} template for "${input.event}" (${recipient.audience}): nothing is sent.`);
      return { skipped: 'no_template' };
    }
    if (!template.isActive) return { skipped: 'template_off' };
    return { recipient, definition };
  }
}
