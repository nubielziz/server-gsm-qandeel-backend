// NotificationDelivery: one attempt to send one `notifications` row (platform module, feature 12a): re-read the row, the recipient and the
// template, render, hand the message to the channel, and record the result with the attempt on the row (decision 020).
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Counter } from 'prom-client';
import { CLOCK, type Clock } from '../../../common/clock';
import { APP_CONFIG, type AppConfig } from '../../../config';
import { TokenService } from '../../../infra/crypto';
import { DbService } from '../../../infra/db';
import { MetricsService } from '../../../infra/metrics';
import type { Notification, NotificationAudience } from '../db/schema';
import { kindOfAudience } from './campaigns/audience-spec';
import { renderCampaign } from './campaigns/campaign-render';
import { marketingUnsubscribeToken } from './campaigns/unsubscribe-token';
import { findCampaign } from './campaigns/campaign.repository';
import { notificationSettingsUrl } from './campaigns/campaign-rules';
import { contentOf, linkOf } from './campaigns/campaign-views';
import { NotificationAudiences } from './campaigns/notification-audiences';
import { DeliveryError } from './delivery-error';
import { describeChanges } from './digest-rules';
import { MailTransport } from './mail-transport';
import { choiceFor } from './merchant-preferences';
import { type NotificationEventDefinition, NotificationEventRegistry } from './notification-events';
import { OPERATIONS_RECIPIENT_ID, asString, itemsOf, operationsRecipientOf, variablesOf } from './notification-payload';
import {
  type NotificationPayload,
  closeDigest,
  findNotification,
  markFailed,
  markSent,
  recordAttempt,
} from './notification.repository';
import { findTemplateFor } from './notification-template.repository';
import { type Recipient, recipientOf, withAudience } from './notification-foreign-reads';
import { TelegramClient } from './telegram-client';
import { type TemplateFields, emailHtml, protectedTemplateProblems, renderMessage } from './template-rules';

/**
 * The audience a row's message was made for, as its payload keeps it.
 *
 * Why: the door of an order or the kind of a wallet can differ from the rank the account holds when the row is sent (decision 064);
 * a row without one (made before the accounts were merged, or a staff message) uses the audience of its recipient.
 *
 * @param payload the stored payload
 * @returns the audience, or `undefined` when the row keeps none or a word that is not an audience
 */
function audienceOfRow(payload: NotificationPayload): NotificationAudience | undefined {
  const audience: unknown = payload.audience;
  return audience === 'merchant' || audience === 'customer' || audience === 'staff' ? audience : undefined;
}

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
 * Templates (decision 047): a stored template is used only when it is switched on and, for an event whose link is a credential, keeps the
 * link rules (and, for a security email, still holds what the email protects); otherwise the shipped text of the event is used with a
 * warning, and an event without a shipped text fails permanently. A security email is never stopped by a missing or switched-off template:
 * the shipped text goes out. A row of an event that names its address (the notice of an email change) goes to that address.
 *
 * Failures: a permanent refusal (no template, no address, a recipient who is suspended or turned the message off since the row was
 * made, a mailbox that does not exist, a chat that blocked the bot, a Telegram row of anyone but the operations chat: an older row that
 * nothing sends any more) marks the row `failed` at once; a transient one records the attempt and throws, so the queue retries with its backoff (5 attempts, 30 s,
 * decision 020), and the last attempt marks the row `failed` before it throws. Reasons are cleaned of addresses.
 *
 * Side effects: reads and updates `notifications`; reads the recipient's table and `notification_templates`; sends one email or
 * Telegram message (an operations message only); counts `notification_deliveries_total{channel,outcome}`.
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
    private readonly audiences: NotificationAudiences,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly tokens: TokenService,
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

  /**
   * Tells whether a row may still lead to a send: it is `queued` and its campaign (if any) is not cancelled.
   *
   * Why: feature 23: the bulk sender takes a message from the per-channel budget only for a row that can still go out, so a
   * cancelled campaign's queued rows fail at once instead of waiting for budget they will not use.
   *
   * @param id the `notifications` row
   * @returns true when a send attempt may happen
   */
  async mayStillSend(id: number): Promise<boolean> {
    const row = await findNotification(this.db.db, id);
    if (!row || row.status !== 'queued') return false;
    if (row.campaignId === null) return true;
    const campaign = await findCampaign(this.db.db, row.campaignId);
    return campaign !== undefined && campaign.status !== 'cancelled';
  }

  /** Renders the row's message and hands it to its channel. */
  private async send(row: Notification, secrets: Readonly<Record<string, string>>): Promise<void> {
    if (row.campaignId !== null) return this.sendCampaign(row, row.campaignId);
    const payload = row.payload as NotificationPayload;
    const operations = row.recipientType === 'staff' && row.recipientId === OPERATIONS_RECIPIENT_ID;
    // Telegram reaches the operations chat only (alerts). A row of any other recipient was queued before merchants lost the channel: it is
    // recorded as not sent, never retried.
    if (row.channel === 'telegram' && !operations)
      throw new DeliveryError('Telegram is no longer used for this message.', { permanent: true });
    // An alert's message has no person's row: it goes to the address or chat the configuration named when the row was made.
    // The text is the audience the message was made for (the door of an order, the kind of a wallet), else the one of the rank.
    const found = operations
      ? operationsRecipientOf(payload)
      : await recipientOf(this.db.db, row.recipientType, row.recipientId);
    if (!found) throw new DeliveryError('The recipient no longer exists.', { permanent: true });
    const recipient = withAudience(found, audienceOfRow(payload));
    const definition = this.registry.get(row.event, recipient.audience);
    if (!definition)
      throw new DeliveryError(`The event "${row.event}" is not registered for ${recipient.audience}.`, {
        permanent: true,
      });
    // The row may be older than the recipient's current state (a digest waits up to a day, a retry waits minutes): the merchant's
    // choice and a suspension are read again here, so "opted out" and "suspended" hold at the moment of sending (B165).
    if (!definition.transactional) {
      if (recipient.suspended) throw new DeliveryError('The recipient is suspended.', { permanent: true });
      if (recipient.audience === 'merchant' && !choiceFor(definition, recipient.prefs).email)
        throw new DeliveryError('The merchant turned this message off.', { permanent: true });
    }
    // Feature 23: an event without a template (a campaign's test) carries its text in the payload.
    if (definition.templated === false) return this.sendInline(row, recipient, payload);
    const template = await this.templateFor(row, recipient.audience, definition);

    const variables: Record<string, string> = { ...variablesOf(payload), ...secrets };
    const items = itemsOf(payload);
    if (Array.isArray(payload.items)) {
      variables['count'] = String(items.length);
      variables['changes'] = describeChanges(items);
    }
    const message = renderMessage(template, variables);

    if (row.channel === 'email') {
      // Decision 047: the notice of an email change goes to the address before the change, which the row names.
      const named = !operations && definition.namedAddress === true && asString(payload.to) ? payload.to : undefined;
      const address = named ?? recipient.email;
      // Only an operations message (alerts) may name several addresses, joined by commas; a person has one address.
      const addresses = operations ? address.split(',') : [address];
      if (!addresses.every((one) => /^[^\s@,]+@[^\s@,]+$/.test(one)))
        throw new DeliveryError('The recipient has no email address.', { permanent: true });
      await this.mail.send({
        to: address,
        subject: message.subject,
        text: message.text,
        // An event mail is the template as rendered: plain text with no HTML part, or the markup of an HTML template.
        ...(message.html === undefined ? {} : { html: message.html }),
        messageId: this.messageId(row.id),
      });
      return;
    }
    // Only an operations message gets here (checked above): its chat is the one the configuration named when the row was made.
    if (!asString(payload.chatId)) throw new DeliveryError('The message names no chat.', { permanent: true });
    await this.telegram.sendMessage(payload.chatId, message.text);
  }

  /**
   * Picks the text of a row: its stored template, or the shipped text of the event.
   *
   * Why: decision 047: a link email never uses a stored template that breaks the link rules, a security email (a notice included) never uses
   * one that breaks its rules or hides what it protects, and never loses its text to a missing, switched-off or emptied template; the choice
   * is made again at the moment of sending (the template may have changed since the row was made). The log never holds the template text or a
   * rendered value.
   *
   * @param row the notification
   * @param audience the recipient's audience
   * @param definition the registered event
   * @returns the stored template, or the shipped text standing in for it
   * @throws {DeliveryError} permanent: no usable stored template and no shipped text
   */
  private async templateFor(
    row: Notification,
    audience: NotificationAudience,
    definition: NotificationEventDefinition,
  ): Promise<TemplateFields> {
    const key = { event: row.event, channel: row.channel, audience };
    const stored = await findTemplateFor(this.db.db, key);
    let reason: string;
    let broken = false;
    if (stored?.isActive) {
      const problems = protectedTemplateProblems(definition, stored);
      if (problems.length === 0) return stored;
      broken = true;
      const rules = problems.filter((problem) => problem.code !== 'security_placeholder');
      reason =
        rules.length > 0
          ? `template ${stored.id} breaks the ${definition.secretLink === true ? 'link' : 'notice'} rules (${rules.map((problem) => problem.code).join(', ')})`
          : `template ${stored.id} lacks ${definition.secretLink === true ? '{{link}}' : '{{change}}'}`;
    } else {
      reason = stored ? 'the stored template is switched off' : 'no stored template';
    }
    const fallback = definition.security === true || broken ? this.registry.builtInTemplate(key) : undefined;
    if (fallback) {
      this.logger.warn(
        `Notification ${row.id} (${row.event}, ${row.channel}, ${audience}): ${reason}; the shipped text is used (decision 047).`,
      );
      return fallback;
    }
    if (broken) throw new DeliveryError('The template breaks the rules of a link mail.', { permanent: true });
    if (!stored) throw new DeliveryError('There is no template for this message.', { permanent: true });
    throw new DeliveryError('The template is switched off.', { permanent: true });
  }

  /**
   * Sends one email row of a campaign (feature 23, plan 9.1).
   *
   * Why: the row was made by the fan-out minutes or hours ago; the campaign may have been cancelled and the person may have been
   * suspended, withdrawn marketing consent or switched announcements off since. Each is read again here, so consent and opt-out hold
   * at the moment of sending (the send-time twin of the fan-out's check) and a cancelled campaign's queued rows fail with the reason.
   */
  private async sendCampaign(row: Notification, campaignId: number): Promise<void> {
    const campaign = await findCampaign(this.db.db, campaignId);
    if (!campaign) throw new DeliveryError('The campaign no longer exists.', { permanent: true });
    if (campaign.status === 'cancelled') throw new DeliveryError('The campaign was cancelled.', { permanent: true });
    // A campaign sends email (its in-app items are not rows of this log): a row of another channel was queued before that channel was retired.
    if (row.channel !== 'email')
      throw new DeliveryError('Campaigns no longer send on this channel.', { permanent: true });
    const found = await recipientOf(this.db.db, row.recipientType, row.recipientId);
    if (!found) throw new DeliveryError('The recipient no longer exists.', { permanent: true });
    // The row keeps the group the person was selected in (the fan-out asked that group's provider): the same one is asked again, so an
    // account whose rank changed since is no longer a member of it (a retail account moved to a merchant rank is not reached by the retail text).
    const recipient = withAudience(found, audienceOfRow(row.payload));
    const member = await this.audiences
      .get(kindOfAudience(recipient.audience))
      .member(this.db.db, campaign.purpose, recipient.id);
    if (!member) throw new DeliveryError('The recipient is no longer eligible.', { permanent: true });
    if (!member.email) throw new DeliveryError('The recipient turned this message off.', { permanent: true });

    const { storeBaseUrl } = this.config.http;
    const unsubscribeToken =
      campaign.purpose === 'marketing' && recipient.audience === 'customer'
        ? marketingUnsubscribeToken(this.tokens, recipient.id)
        : undefined;
    const message = renderCampaign(
      { content: contentOf(campaign), link: linkOf(campaign), purpose: campaign.purpose },
      {
        name: recipient.name,
        audience: recipient.audience,
        channel: row.channel,
        // Campaign links are site paths (`/account/orders`, `/account/wallet`), so customers and merchants both get the site's
        // root (STORE_BASE_URL): PORTAL_BASE_URL already ends at `/account` and would double it. The console has no base address
        // yet (feature 20's CONSOLE_BASE_URL): a staff message carries no link.
        baseUrl: recipient.audience === 'staff' ? undefined : storeBaseUrl,
        ...(recipient.audience === 'merchant' ? { preferencesUrl: notificationSettingsUrl(storeBaseUrl) } : {}),
        // A marketing email to a customer carries the unsubscribe page and the one-click POST address (S10, RFC 8058).
        ...(unsubscribeToken === undefined
          ? {}
          : {
              unsubscribe: {
                pageUrl: `${storeBaseUrl}/unsubscribe?token=${unsubscribeToken}`,
                oneClickUrl: `${storeBaseUrl}/store/v1/marketing/unsubscribe/${unsubscribeToken}`,
              },
            }),
      },
    );
    if (!/^[^\s@,]+@[^\s@,]+$/.test(recipient.email))
      throw new DeliveryError('The recipient has no email address.', { permanent: true });
    await this.mail.send({
      to: recipient.email,
      subject: message.subject,
      text: message.text,
      ...(message.html === undefined ? {} : { html: message.html }),
      ...(message.headers === undefined ? {} : { headers: message.headers }),
      messageId: this.messageId(row.id),
    });
  }

  /** Sends a row whose text is in its payload (an event with `templated: false`, the test of a campaign). */
  private async sendInline(row: Notification, recipient: Recipient, payload: NotificationPayload): Promise<void> {
    const variables = variablesOf(payload);
    const title = variables['title'] ?? '';
    const body = variables['body'] ?? '';
    // The text of an inline event goes by email only (a campaign's test).
    if (row.channel !== 'email') throw new DeliveryError('This message goes by email only.', { permanent: true });
    if (!/^[^\s@,]+@[^\s@,]+$/.test(recipient.email))
      throw new DeliveryError('The recipient has no email address.', { permanent: true });
    await this.mail.send({
      to: recipient.email,
      subject: `[Test] ${title}`,
      text: body,
      html: emailHtml(body),
      messageId: this.messageId(row.id),
    });
  }

  /** The `Message-ID` of a row: stable across retries, so a provider that dedupes sees one message. */
  private messageId(id: number): string {
    const domain = /@([^>\s]+)>?\s*$/.exec(this.mail.from)?.[1] ?? 'gsm.invalid';
    return `<notification-${id}@${domain}>`;
  }
}
