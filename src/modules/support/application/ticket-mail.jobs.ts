// TicketMailJobs: the job that sends a ticket's message (feature 17): the receipt of a new ticket, a staff reply, the satisfaction survey.
// It re-reads the ticket, builds the link with the ticket token as a secret and sends through the platform's NotificationService.
import { Inject, Injectable, Logger } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../../config';
import { DbService } from '../../../infra/db';
import { type Job, UnrecoverableError } from '../../../infra/queues';
import { type NotificationInput, NotificationService, type OutboxJobData } from '../../platform';
import type { ReplyChannel } from '../domain/reply-channels';
import { findRequester } from '../infra/support-foreign-reads';
import { findMessage, findTicket } from '../infra/ticket.repository';
import { SUPPORT_CSAT_SURVEY_EVENT, SUPPORT_REPLY_EVENT, SUPPORT_TICKET_RECEIVED_EVENT } from './support-events';
import { TICKET_MAIL_EVENT, TICKET_MAIL_KINDS, type TicketMailKind } from './ticket-mail-outbox';

/** What a ticket mail job answers (kept briefly with the BullMQ job). */
export interface TicketMailJobResult {
  readonly sent: boolean;
  /** Why nothing was sent. */
  readonly skipped?:
    | 'ticket_gone'
    | 'message_gone'
    | 'recipient_gone'
    | 'recipient_suspended'
    | 'no_template'
    | 'template_off'
    | 'already_sent'
    | 'already_failed';
  /** The reason of a message that could not be delivered for good (it is also on the `notifications` row). */
  readonly failed?: string;
}

/** The parts of a BullMQ job the mail job reads; tests pass a plain object. */
export type TicketMailJob = Pick<Job<OutboxJobData>, 'data'> & {
  readonly attemptsMade?: number;
  readonly opts?: { readonly attempts?: number };
};

/**
 * Runs one ticket mail job.
 *
 * Why: decision 020 and feature 12a: the outbox row keeps only ids. The ticket link carries the ticket token, a credential that the
 * notification log must never show, so it is built here and handed to `NotificationService.sendNow` as a secret: the `notifications` row
 * (dedupe key `outbox-<event id>:<channel>`) holds the other variables and the log shows them without the link. The job re-reads the ticket,
 * the requester and the message, so a customer anonymized since the event gets nothing; a retry resends (a message is at least once), and a
 * repeat of a job whose message already went out is skipped by its notification row.
 *
 * Side effects: reads `support_tickets`, `ticket_messages`, `customers` and `clients`; the notification delivery writes a `notifications`
 * row and sends one email or Telegram message; a retry that ends skipped marks the row of an earlier attempt `failed`.
 *
 * @see docs/queues.md (notifications)
 */
@Injectable()
export class TicketMailJobs {
  private readonly logger = new Logger('TicketMail');

  constructor(
    private readonly db: DbService,
    private readonly notifications: NotificationService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * Handles one ticket message event.
   *
   * @param job the outbox job (`aggregateId` is the ticket, `payload.kind` which message, `payload.messageId` and `payload.channel` for a reply)
   * @returns whether the message was sent, and why not
   * @throws {UnrecoverableError} when the payload is malformed (a programming error: retrying cannot help)
   * @throws {DeliveryError} when the mail server or Telegram did not take the message and a retry may help (the queue retries)
   */
  async handle(job: TicketMailJob): Promise<TicketMailJobResult> {
    const { kind, messageId, channel } = this.readPayload(job.data);
    const key = `outbox-${job.data.eventId}:${channel}`;
    const result = await this.send(job, kind, channel, messageId, key);
    // A retry that ends skipped must not leave the row an earlier attempt made `queued` for ever.
    if (result.skipped && result.skipped !== 'already_sent' && result.skipped !== 'already_failed') {
      await this.notifications.abandon(key, result.skipped);
    }
    return result;
  }

  private readPayload(data: OutboxJobData): {
    kind: TicketMailKind;
    messageId: number | undefined;
    channel: ReplyChannel;
  } {
    const { kind, messageId, channel } = data.payload;
    if (typeof kind !== 'string' || !(TICKET_MAIL_KINDS as readonly string[]).includes(kind)) {
      throw new UnrecoverableError(`${TICKET_MAIL_EVENT} job with an unknown kind`);
    }
    if (kind === 'reply' && (typeof messageId !== 'number' || (channel !== 'email' && channel !== 'telegram'))) {
      throw new UnrecoverableError(`${TICKET_MAIL_EVENT} reply job without a message or a channel`);
    }
    return {
      kind: kind as TicketMailKind,
      messageId: typeof messageId === 'number' ? messageId : undefined,
      channel: channel === 'telegram' ? 'telegram' : 'email',
    };
  }

  /** Checks that the message is still worth sending, builds the link and sends it (the body of {@link handle}). */
  private async send(
    job: TicketMailJob,
    kind: TicketMailKind,
    channel: ReplyChannel,
    messageId: number | undefined,
    dedupeKey: string,
  ): Promise<TicketMailJobResult> {
    const ticket = await findTicket(this.db.db, job.data.aggregateId);
    if (!ticket) return { sent: false, skipped: 'ticket_gone' };
    const requester = await findRequester(this.db.db, ticket.requesterType, ticket.requesterId);
    // An anonymized customer has no address any more; a customer or merchant that is gone cannot be written to.
    if (!requester?.reachable) return { sent: false, skipped: 'recipient_gone' };

    const customer = ticket.requesterType === 'customer';
    const link =
      ticket.token === null
        ? ''
        : `${this.config.http.storeBaseUrl}/support/tickets/${encodeURIComponent(ticket.token)}`;
    const common = { ticketNumber: ticket.number, subject: ticket.subject };
    const customerName = { customerName: requester.name.trim() || 'there' };
    let input: Omit<NotificationInput, 'dedupeKey'>;
    if (kind === 'reply') {
      const message = messageId === undefined ? undefined : await findMessage(this.db.db, messageId);
      if (!message || message.ticketId !== ticket.id || message.isInternal || message.authorType !== 'staff') {
        return { sent: false, skipped: 'message_gone' };
      }
      input = {
        event: SUPPORT_REPLY_EVENT,
        recipient: { type: customer ? 'customer' : 'client', id: ticket.requesterId },
        channel,
        variables: {
          ...common,
          ...(customer ? customerName : { merchantName: requester.name }),
          message: message.body,
        },
      };
    } else {
      // The receipt and the survey are for a customer: a merchant's ticket has no ticket page.
      if (!customer) return { sent: false, skipped: 'recipient_gone' };
      input = {
        event: kind === 'received' ? SUPPORT_TICKET_RECEIVED_EVENT : SUPPORT_CSAT_SURVEY_EVENT,
        recipient: { type: 'customer', id: ticket.requesterId },
        channel: 'email',
        variables: { ...common, ...customerName },
      };
    }

    const result = await this.notifications.sendNow(
      { ...input, dedupeKey },
      { link },
      { attempt: (job.attemptsMade ?? 0) + 1, maxAttempts: job.opts?.attempts ?? 1 },
    );
    switch (result.status) {
      case 'sent':
        return { sent: true };
      case 'failed':
        return { sent: false, failed: result.reason };
      case 'skipped':
        if (result.reason === 'no_template' || result.reason === 'template_off') {
          this.logger.warn(`No ${kind} message sent for ticket ${ticket.id}: ${result.reason}.`);
        }
        return { sent: false, skipped: result.reason };
    }
  }
}
