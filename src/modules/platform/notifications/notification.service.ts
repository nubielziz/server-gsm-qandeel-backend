// NotificationService: how other code makes a notification (platform module, feature 12a): `enqueue` writes the row and its send event in
// the caller's transaction; `sendNow` is for a job that holds a secret (the link of a merchant mail) and sends in the same job.
import { Inject, Injectable, Logger } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import { DbService, type DbExecutor, type TransactionContext } from '../../../infra/db';
import type {
  NotificationAudience,
  NotificationChannel,
  NotificationRecipientType,
  NotificationStatus,
  NotificationTemplate,
} from '../db/schema';
import { OutboxService } from '../outbox/outbox.service';
import { type AttemptContext, NotificationDelivery } from './notification-delivery';
import { NotificationInbox } from './inbox/notification-inbox';
import { type NotificationEventDefinition, NotificationEventRegistry } from './notification-events';
import { type Recipient, recipientOf, withAudience } from './notification-foreign-reads';
import { ADDRESS_RECIPIENT_ID, OPERATIONS_RECIPIENT_ID } from './notification-payload';
import { type TemplateKey, findTemplateFor } from './notification-template.repository';
import { linkTemplateProblems } from './template-rules';
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
  /** A registered event key for the message's audience (see `audience`). */
  readonly event: string;
  /** `staff`, or `account` for a person of either rank (decision 064: a merchant's and a shopper's id are both account ids). */
  readonly recipient: { readonly type: NotificationRecipientType; readonly id: number };
  readonly channel: NotificationChannel;
  /**
   * The audience whose text this message uses, when it is not the audience of the recipient's rank today (decision 064): an order,
   * payment or refund mail follows the door of the order (`store` is the customer text with the tracking link, every other door the
   * merchant text), a wallet mail the kind of the wallet (`client_wallet` is the merchant text, `customer_wallet` the customer text) and
   * a support reply the rank of the asker. Omitted: `merchant` for an account of a merchant rank, `customer` for any other rank and for
   * a guest. The audience is kept in the row, so a rank change between the row and its sending never swaps the text.
   */
  readonly audience?: NotificationAudience;
  /** The values of the event's placeholders. They are stored on the row and shown in the log: no secret goes here. */
  readonly variables?: Readonly<Record<string, string>>;
  /** Names the occurrence, so a repeat makes no second row (`outbox-<id>:email`). */
  readonly dedupeKey?: string;
  /**
   * The address to write to instead of the recipient's current one. Only an event registered with `namedAddress` takes it (decision 047:
   * the notice of an email change goes to the address before the change); it is kept in the row's payload as `to` and masked in the log.
   */
  readonly to?: string;
}

/** What a caller asks for when the message goes to an address or chat that configuration names, not to a person's row (an alert, feature 12b). */
export interface AddressedNotificationInput {
  /** A registered event key for the staff audience. */
  readonly event: string;
  readonly channel: NotificationChannel;
  /** For an email the addresses joined by commas, for Telegram the chat id; `undefined` when the configuration names none. */
  readonly to: string | undefined;
  /** The reason written on the failed row when `to` is missing (no address, no secret). */
  readonly noRecipientReason: string;
  /** The values of the event's placeholders. They are stored on the row and shown in the log: no secret goes here. */
  readonly variables?: Readonly<Record<string, string>>;
  /** Names the occurrence, so a repeat makes no second row (required: the caller runs again and again). */
  readonly dedupeKey: string;
}

/** What a caller asks for when the message goes to an email address that no account row holds (decision 079: the note to an unknown address). */
export interface EmailNotificationInput {
  /** A registered event key of the audience, registered with `namedAddress` (it may name the address it goes to). */
  readonly event: string;
  /** The text the message uses: `customer` or `merchant`. */
  readonly audience: Exclude<NotificationAudience, 'staff'>;
  /** The address, normalised; kept in the row's payload as `to` and masked in the log. */
  readonly to: string;
  /** The values of the event's placeholders. They are stored on the row and shown in the log: no secret goes here. */
  readonly variables?: Readonly<Record<string, string>>;
}

/** What `enqueueToAddress` did: like {@link EnqueueResult}, plus the failed row of a message that had nowhere to go. */
export type AddressedResult =
  | EnqueueResult
  | { readonly status: 'failed'; readonly id: number; readonly created: boolean; readonly reason: string };

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
 * The part of a payload that keeps the audience of an account's message.
 *
 * Why: the row is sent later (a retry, a digest a day on) and the account's rank may have changed by then; the text stays the one the message was made for
 * (the door of the order, the kind of the wallet). A staff message has one audience and keeps nothing.
 *
 * @param recipient the recipient with the audience of the message
 * @returns `{ audience }` for an account, nothing for staff
 */
function audienceOfPayload(recipient: Recipient): { audience?: NotificationAudience } {
  return recipient.type === 'account' ? { audience: recipient.audience } : {};
}

/**
 * Makes and sends notifications.
 *
 * Why: brief 12a: one delivery path. A use case (or the planning job of an outbox event) calls `enqueue` inside its transaction: the
 * `notifications` row (`queued`) and the outbox event `notification.send` commit together, so the message exists if and only if the
 * change did, and the relay turns the event into a job (decision 020). A missing or switched-off template is logged and sends
 * nothing (RULES settings 10), except for the emails that protect accounts, which the shipped text sends (decision 047); a recipient
 * that is gone or (for a message that is not transactional) suspended gets nothing.
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
    private readonly inbox: NotificationInbox,
  ) {}

  /**
   * Writes a notification and the event that sends it, in the caller's transaction.
   *
   * @param work the caller's transaction (`runInTransaction`; a use case that holds the transaction as a `DbExecutor` passes it as `{ tx }`)
   * @param input the event, recipient, channel and variables
   * @returns the row id (and whether this call made it), or why nothing was made
   * @throws {RangeError} when the event is not registered for the message's audience, the event has no such channel, or `to` is given for an
   *   event without the `namedAddress` flag (programming errors)
   *
   * Side effects: also inserts the in-app item of the event (`notification_inbox`) when one has a registered text and the call has a dedupe key.
   */
  async enqueue(work: { readonly tx: DbExecutor }, input: NotificationInput): Promise<EnqueueResult> {
    // Feature 23, S9: an event with an in-app text also makes the person's inbox item, in this transaction and before the template
    // check, so the item exists even when the email template is switched off. Only an occurrence with a key can repeat safely.
    if (input.dedupeKey !== undefined) {
      await this.inbox.addForEvent(work.tx, {
        recipient: input.recipient,
        event: input.event,
        variables: input.variables ?? {},
        occurrence: input.dedupeKey.replace(/:(email|telegram)$/, ''),
        ...(input.audience === undefined ? {} : { audience: input.audience }),
      });
    }
    const checked = await this.check(work.tx, input);
    if ('skipped' in checked) return { status: 'skipped', reason: checked.skipped };
    if (input.to !== undefined && checked.definition.namedAddress !== true) {
      throw new RangeError(`The event "${input.event}" cannot name the address it goes to.`);
    }
    const now = this.clock.now();
    const payload: NotificationPayload = {
      variables: { ...(input.variables ?? {}) },
      ...(input.to === undefined ? {} : { to: input.to }),
      ...audienceOfPayload(checked.recipient),
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
   * Writes a notification whose text travels with it (an event with `templated: false`), and the event that sends it.
   *
   * Why: feature 23: a campaign's test mail carries the campaign's own title and body, which no template holds; the row's payload
   * keeps them (`variables`), and the delivery renders them without a template lookup.
   *
   * Side effects: inserts a `notifications` row (once per dedupe key) and its `outbox_events` row.
   *
   * @param work the caller's transaction
   * @param input the event, recipient, channel and the text as variables
   * @returns the row, or why nothing was made (`recipient_gone`, `recipient_suspended`)
   * @throws {RangeError} when the event is not registered for the message's audience, has a template, or lacks the channel
   */
  async enqueueInline(work: { readonly tx: DbExecutor }, input: Omit<NotificationInput, 'to'>): Promise<EnqueueResult> {
    const found = await recipientOf(work.tx, input.recipient.type, input.recipient.id);
    if (!found) return { status: 'skipped', reason: 'recipient_gone' };
    const recipient = withAudience(found, input.audience);
    const definition = this.registry.get(input.event, recipient.audience);
    if (!definition || definition.templated !== false || !definition.channels.includes(input.channel)) {
      throw new RangeError(
        `The event "${input.event}" cannot be sent inline by ${input.channel} to ${recipient.audience}.`,
      );
    }
    if (recipient.suspended && !definition.transactional) return { status: 'skipped', reason: 'recipient_suspended' };
    const now = this.clock.now();
    const { row, created } = await insertNotificationOnce(work.tx, {
      recipientType: input.recipient.type,
      recipientId: input.recipient.id,
      channel: input.channel,
      event: input.event,
      payload: { variables: { ...(input.variables ?? {}) }, ...audienceOfPayload(recipient) },
      status: 'queued',
      dedupeKey: input.dedupeKey ?? null,
      createdAt: now,
      updatedAt: now,
    });
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
   * Writes a notification to an address or chat named by configuration, and the event that sends it, in the caller's transaction.
   *
   * Why: feature 12b: the messages of alerts go to the ops mailbox and chat, which are not rows of `staff_users`. The pseudo-recipient is
   * (`staff`, {@link OPERATIONS_RECIPIENT_ID}); the address travels in the payload (`to`, or `chatId` for Telegram, which the log masks). A
   * channel with no configured recipient is recorded as a `failed` row with the caller's reason and sends nothing, so the log says why the
   * page never arrived. A missing or switched-off template is skipped like any other message (RULES settings 10).
   *
   * Side effects: inserts a `notifications` row (once per dedupe key) and, for a queued one, an `outbox_events` row.
   *
   * @param work the caller's transaction (`runInTransaction`)
   * @param input the event, channel, address or chat, variables and dedupe key
   * @returns the row (queued, or failed for a missing recipient), or why nothing was made
   * @throws {RangeError} when the event is not registered for the staff audience, or the event has no such channel (a programming error)
   */
  async enqueueToAddress(
    work: Pick<TransactionContext, 'tx'>,
    input: AddressedNotificationInput,
  ): Promise<AddressedResult> {
    const definition = this.registry.get(input.event, 'staff');
    if (!definition) throw new RangeError(`The event "${input.event}" is not registered for the audience "staff".`);
    if (!definition.channels.includes(input.channel)) {
      throw new RangeError(`The event "${input.event}" cannot be sent by ${input.channel}.`);
    }
    const template = await findTemplateFor(work.tx, { event: input.event, channel: input.channel, audience: 'staff' });
    if (!template) {
      this.logger.warn(`No ${input.channel} template for "${input.event}" (staff): nothing is sent.`);
      return { status: 'skipped', reason: 'no_template' };
    }
    if (!template.isActive) return { status: 'skipped', reason: 'template_off' };
    const now = this.clock.now();
    const variables = { ...(input.variables ?? {}) };
    const to = input.to?.trim() ?? '';
    const base = {
      recipientType: 'staff',
      recipientId: OPERATIONS_RECIPIENT_ID,
      channel: input.channel,
      event: input.event,
      dedupeKey: input.dedupeKey,
      createdAt: now,
      updatedAt: now,
    } as const;
    if (to === '') {
      const { row, created } = await insertNotificationOnce(work.tx, {
        ...base,
        payload: { variables },
        status: 'failed',
        error: input.noRecipientReason,
      });
      if (created)
        this.logger.warn(
          `Notification ${row.id} (${input.event}, ${input.channel}) failed: ${input.noRecipientReason}`,
        );
      return { status: 'failed', id: row.id, created, reason: input.noRecipientReason };
    }
    const payload: NotificationPayload = { variables, ...(input.channel === 'email' ? { to } : { chatId: to }) };
    const { row, created } = await insertNotificationOnce(work.tx, { ...base, payload, status: 'queued' });
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
   * Writes an email to an address that no account row holds, and the event that sends it, in the caller's transaction.
   *
   * Why: decision 079 (its review): the note that answers a sign-in link asked for an address without an account goes to the address that
   * was typed, so the request leaves no row behind (a guest row made only to address it let anybody plant rows). The pseudo-recipient is
   * (`account`, {@link ADDRESS_RECIPIENT_ID}); the address travels in the payload (`to`, masked in the log). Only an event registered with
   * `namedAddress` takes it. The template rules are the ones of {@link enqueue}: a security email is never stopped by a missing or
   * switched-off template (decision 047). The message carries no secret: a link with a token never goes this way.
   *
   * Side effects: inserts a `notifications` row and its `outbox_events` row (`notification.send`, the row id only).
   *
   * @param work the caller's transaction
   * @param input the event, the audience, the address and the variables
   * @returns the row, or why nothing was made (`no_template`, `template_off`)
   * @throws {RangeError} when the event is not registered for the audience, has no email channel or lacks the `namedAddress` flag (programming
   *   errors)
   */
  async enqueueToEmail(work: Pick<TransactionContext, 'tx'>, input: EmailNotificationInput): Promise<EnqueueResult> {
    const definition = this.registry.get(input.event, input.audience);
    if (!definition) {
      throw new RangeError(`The event "${input.event}" is not registered for the audience "${input.audience}".`);
    }
    if (!definition.channels.includes('email'))
      throw new RangeError(`The event "${input.event}" cannot be sent by email.`);
    if (definition.namedAddress !== true) {
      throw new RangeError(`The event "${input.event}" cannot name the address it goes to.`);
    }
    const key: TemplateKey = { event: input.event, channel: 'email', audience: input.audience };
    const verdict = this.verdictOf(await findTemplateFor(work.tx, key), key, definition);
    if (verdict !== 'ok') {
      this.logger.warn(`No usable email template for "${input.event}" (${input.audience}): nothing is sent.`);
      return { status: 'skipped', reason: verdict };
    }
    const now = this.clock.now();
    const { row, created } = await insertNotificationOnce(work.tx, {
      recipientType: 'account',
      recipientId: ADDRESS_RECIPIENT_ID,
      channel: 'email',
      event: input.event,
      payload: { variables: { ...(input.variables ?? {}) }, to: input.to, audience: input.audience },
      status: 'queued',
      dedupeKey: null,
      createdAt: now,
      updatedAt: now,
    });
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
   * @throws {RangeError} when the event is not registered for the recipient's audience, the event has no such channel, or `to` is given (a mail
   *   with a secret goes to the recipient's own address; only `enqueue` takes a named one, decision 047)
   */
  async sendNow(
    input: NotificationInput & { readonly dedupeKey: string },
    secrets: Readonly<Record<string, string>>,
    context: AttemptContext,
  ): Promise<SendNowResult> {
    if (input.to !== undefined) {
      throw new RangeError(`The event "${input.event}" cannot name the address it goes to.`);
    }
    const checked = await this.check(this.db.db, input);
    if ('skipped' in checked) return { status: 'skipped', reason: checked.skipped };
    const now = this.clock.now();
    const { row } = await insertNotificationOnce(this.db.db, {
      recipientType: input.recipient.type,
      recipientId: input.recipient.id,
      channel: input.channel,
      event: input.event,
      payload: { variables: { ...(input.variables ?? {}) }, ...audienceOfPayload(checked.recipient) },
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
   * @param db the database or a transaction to read with (default: the pool); a caller deciding inside its transaction passes `tx`
   * @returns the row's status, or `undefined` when no row has the key
   */
  async statusOf(dedupeKey: string, db: DbExecutor = this.db.db): Promise<NotificationStatus | undefined> {
    return (await findNotificationByKey(db, dedupeKey))?.status;
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
   * @param db the database or a transaction to write with (default: the pool); a caller that must finish other work together with the
   *   row passes its `tx`
   * @returns true when a queued row was marked failed
   */
  async abandon(dedupeKey: string, reason: string, db: DbExecutor = this.db.db): Promise<boolean> {
    const row = await findNotificationByKey(db, dedupeKey);
    if (!row || row.status !== 'queued') return false;
    const marked = await markFailed(db, row.id, row.attempts, reason, this.clock.now());
    if (marked) this.logger.warn(`Notification ${row.id} (${row.event}, ${row.channel}) was not sent: ${reason}.`);
    return marked;
  }

  /**
   * Looks up what a notification needs before a row is made: the recipient, the event and an active template.
   *
   * Why: decision 047: a security email does not need one (the shipped text is sent when the template is missing or switched off), and
   * a link email without a shipped text needs a template that keeps the link rules.
   *
   * @param db the database or a transaction
   * @param input the event, recipient and channel to check
   * @returns the recipient (its `audience` is the audience of this message: the input's, else the rank's) and the event, or the reason to skip
   * @throws {RangeError} when the event is not registered for the message's audience, or the event has no such channel
   */
  async check(
    db: DbExecutor,
    input: NotificationInput,
  ): Promise<{ recipient: Recipient; definition: NotificationEventDefinition } | { skipped: SkipReason }> {
    const found = await recipientOf(db, input.recipient.type, input.recipient.id);
    if (!found) return { skipped: 'recipient_gone' };
    const recipient = withAudience(found, input.audience);
    const definition = this.registry.get(input.event, recipient.audience);
    if (!definition) {
      throw new RangeError(`The event "${input.event}" is not registered for the audience "${recipient.audience}".`);
    }
    if (!definition.channels.includes(input.channel)) {
      throw new RangeError(`The event "${input.event}" cannot be sent by ${input.channel}.`);
    }
    if (recipient.suspended && !definition.transactional) return { skipped: 'recipient_suspended' };
    const key: TemplateKey = { event: input.event, channel: input.channel, audience: recipient.audience };
    const template = await findTemplateFor(db, key);
    const verdict = this.verdictOf(template, key, definition);
    if (verdict === 'ok') return { recipient, definition };
    if (definition.security === true) {
      this.logger.error(
        `The security email "${input.event}" (${recipient.audience}) has no usable template and no shipped text: nothing is sent.`,
      );
    } else if (verdict === 'no_template') {
      this.logger.warn(`No ${input.channel} template for "${input.event}" (${recipient.audience}): nothing is sent.`);
    } else if (template?.isActive) {
      this.logger.warn(
        `The ${input.channel} template of "${input.event}" (${recipient.audience}) breaks the rules of a link email and has no shipped text: nothing is sent.`,
      );
    }
    return { skipped: verdict };
  }

  /**
   * Judges the stored template of an event: usable, missing or switched off.
   *
   * Why: decision 047: a security email is never stopped by its template (a missing or switched-off one is stood in for by the shipped
   * text), and a link email whose active template breaks the link rules and has no shipped text counts as switched off,
   * so nothing queues a row the delivery could only fail.
   *
   * @param template the stored template of the event, channel and audience, if any
   * @param key the event, channel and audience
   * @param definition the registered event
   * @returns `ok` when a message can be written, else the reason it cannot
   */
  private verdictOf(
    template: NotificationTemplate | undefined,
    key: TemplateKey,
    definition: NotificationEventDefinition | undefined,
  ): 'ok' | 'no_template' | 'template_off' {
    const shipped = this.registry.builtInTemplate(key);
    if (template?.isActive) {
      const unusable =
        definition?.secretLink === true &&
        definition.security !== true &&
        shipped === undefined &&
        linkTemplateProblems(template).length > 0;
      return unusable ? 'template_off' : 'ok';
    }
    if (definition?.security === true && shipped !== undefined) return 'ok';
    return template ? 'template_off' : 'no_template';
  }
}
