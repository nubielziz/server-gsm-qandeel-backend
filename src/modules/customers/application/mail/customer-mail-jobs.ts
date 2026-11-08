// CustomerMailJobs: what the worker does for a customer mail event: re-read the customer and the link row, rotate the link's token, and
// send the mail through the notification delivery path with the clear link as a secret that is never stored.
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { CLOCK, type Clock } from '../../../../common/clock';
import { APP_CONFIG, type AppConfig } from '../../../../config';
import { DbService } from '../../../../infra/db';
import { UnrecoverableError } from '../../../../infra/queues';
import { CustomerAuthTokens, type CustomerTokenPurpose, isUsableLink } from '../../../identity';
import { type OutboxJobData, NotificationService } from '../../../platform';
import { findCustomerById } from '../../infra/customer.repository';
import { canSignIn } from '../../domain/customer-status';
import { CUSTOMER_MAIL_EVENTS, type CustomerMailKind } from './customer-mail-outbox';

/** The token purpose each mail is about; a job whose row says otherwise is not sent. */
export const PURPOSE_OF_KIND: Readonly<Record<CustomerMailKind, CustomerTokenPurpose>> = {
  magic_link: 'magic_link',
  password_reset: 'reset',
  invited: 'invite',
  email_verification: 'verify_email',
};

/** Where each mail's link points in the storefront (`<STORE_BASE_URL><path>?token=<token>`). */
const STORE_PATHS: Readonly<Record<CustomerMailKind, string>> = {
  magic_link: '/sign-in',
  password_reset: '/set-password',
  invited: '/set-password',
  email_verification: '/verify-email',
};

/**
 * Builds the link of a customer mail.
 *
 * @param storeBaseUrl the storefront's base URL, without a trailing slash
 * @param kind which mail
 * @param token the clear token
 * @returns `<storeBaseUrl>/sign-in?token=<token>` (or `/set-password`, `/verify-email`)
 */
export function customerMailLink(storeBaseUrl: string, kind: CustomerMailKind, token: string): string {
  return `${storeBaseUrl}${STORE_PATHS[kind]}?token=${encodeURIComponent(token)}`;
}

/** What a mail job answers (kept briefly with the BullMQ job). */
export interface CustomerMailJobResult {
  readonly sent: boolean;
  /** Why nothing was sent. */
  readonly skipped?:
    | 'customer_gone'
    | 'customer_not_active'
    | 'link_not_usable'
    | 'no_template'
    | 'template_off'
    | 'already_sent'
    | 'already_failed';
  /** The reason of a mail that could not be delivered for good (it is also on the `notifications` row). */
  readonly failed?: string;
}

/** The parts of a BullMQ job the mail job reads; tests pass a plain object. */
export type CustomerMailJob = Pick<Job<OutboxJobData>, 'data'> & {
  readonly attemptsMade?: number;
  readonly opts?: { readonly attempts?: number };
};

/**
 * Runs one customer mail job.
 *
 * Why: feature 14b and decision 033, built like the merchant mail job (feature 12a): the outbox row keeps only the `auth_tokens` id, and
 * a token is stored only as a hash, so the clear token for the link must be made inside this job. The job re-reads everything and checks
 * that the mail is still worth sending (a customer who is active; a link that is not used, voided or expired), then rotates the link: the
 * placeholder token the request made (never sent to anyone) is replaced by a new random one on the same row, keeping the row's expiry,
 * and the clear value goes into the mail as the `link` secret. Nothing stores or logs it. The `notifications` row (dedupe key
 * `outbox-<event id>:email`) logs the mail without the link; a retry of the job rotates again (the earlier clear value was never
 * delivered) and resends, and a repeat after a delivered mail is skipped before it can spoil the link that arrived. A mail is at least once.
 *
 * Side effects: reads `customers` and `auth_tokens`; updates the link's `token_hash`; the notification delivery writes a `notifications`
 * row and sends one email; a retry that ends skipped marks the row of an earlier attempt `failed` with the skip reason.
 *
 * @see docs/queues.md (notifications)
 */
@Injectable()
export class CustomerMailJobs {
  private readonly logger = new Logger('CustomerMail');

  constructor(
    private readonly db: DbService,
    private readonly tokens: CustomerAuthTokens,
    private readonly notifications: NotificationService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Handles one mail event.
   *
   * @param kind which mail the event type means
   * @param job the outbox job (`aggregateId` is the customer, `payload.tokenId` the link row)
   * @returns whether the mail was sent, and why not
   * @throws {UnrecoverableError} when the job has no token id (a programming error: retrying cannot help)
   * @throws {DeliveryError} when the mail server did not take the mail and a retry may help (the queue retries, 5 attempts)
   */
  async handle(kind: CustomerMailKind, job: CustomerMailJob): Promise<CustomerMailJobResult> {
    const tokenId = job.data.payload['tokenId'];
    if (typeof tokenId !== 'number')
      throw new UnrecoverableError(`${CUSTOMER_MAIL_EVENTS[kind]} job without a tokenId`);

    const result = await this.decide(kind, job, tokenId);
    // A retry that ends skipped must not leave the row an earlier attempt made `queued` for ever: that row is finished as failed, with
    // the skip reason as its error. `already_sent` and `already_failed` mean the row is finished already.
    if (result.skipped && result.skipped !== 'already_sent' && result.skipped !== 'already_failed') {
      await this.notifications.abandon(`outbox-${job.data.eventId}:email`, result.skipped);
    }
    return result;
  }

  /** Checks that the mail is still worth sending, rotates the link and sends it (the body of {@link handle}). */
  private async decide(kind: CustomerMailKind, job: CustomerMailJob, tokenId: number): Promise<CustomerMailJobResult> {
    const customer = await findCustomerById(this.db.db, job.data.aggregateId);
    if (!customer || customer.status === 'anonymized') return { sent: false, skipped: 'customer_gone' };
    // Suspended and blocked customers get nothing, not even a sign-in or reset link: the notification path treats customer mails as
    // always sendable, so the status is judged here.
    if (!canSignIn(customer.status)) return { sent: false, skipped: 'customer_not_active' };

    const link = await this.tokens.findById(tokenId);
    const usable =
      link !== undefined &&
      link.subjectId === customer.id &&
      link.purpose === PURPOSE_OF_KIND[kind] &&
      isUsableLink(link, this.clock.nowMs());
    if (!usable) return { sent: false, skipped: 'link_not_usable' };

    // A repeat of a job whose mail already went out (or failed for good) must not rotate the token of the link that arrived.
    const earlier = await this.notifications.statusOf(`outbox-${job.data.eventId}:email`);
    if (earlier === 'sent') return { sent: false, skipped: 'already_sent' };
    if (earlier === 'failed') return { sent: false, skipped: 'already_failed' };

    // A mail with no template to send (missing or switched off) must not rotate a token nobody will receive.
    const probe = await this.notifications.check(this.db.db, {
      event: CUSTOMER_MAIL_EVENTS[kind],
      recipient: { type: 'customer', id: customer.id },
      channel: 'email',
    });
    if ('skipped' in probe) {
      this.logger.warn(`No mail sent for ${CUSTOMER_MAIL_EVENTS[kind]} to customer ${customer.id}: ${probe.skipped}.`);
      return { sent: false, skipped: skipReason(probe.skipped) };
    }

    const token = await this.tokens.rotate(link.id);
    if (token === undefined) return { sent: false, skipped: 'link_not_usable' };

    const result = await this.notifications.sendNow(
      {
        event: CUSTOMER_MAIL_EVENTS[kind],
        recipient: { type: 'customer', id: customer.id },
        channel: 'email',
        variables: { customerName: customer.name, expiresAt: formatExpiry(link.expiresAt) },
        dedupeKey: `outbox-${job.data.eventId}:email`,
      },
      { link: customerMailLink(this.config.http.storeBaseUrl, kind, token) },
      { attempt: (job.attemptsMade ?? 0) + 1, maxAttempts: job.opts?.attempts ?? 1 },
    );
    switch (result.status) {
      case 'sent':
        return { sent: true };
      case 'failed':
        return { sent: false, failed: result.reason };
      case 'skipped':
        return { sent: false, skipped: skipReason(result.reason) };
    }
  }
}

/** Maps the notification path's skip reasons onto the job's: a recipient that is gone is a customer that is gone. */
function skipReason(
  reason: 'recipient_gone' | 'recipient_suspended' | 'no_template' | 'template_off' | 'already_sent' | 'already_failed',
): NonNullable<CustomerMailJobResult['skipped']> {
  // `recipient_suspended` is never answered for a customer (the platform reads customers as never suspended), but the type allows it.
  if (reason === 'recipient_gone') return 'customer_gone';
  if (reason === 'recipient_suspended') return 'customer_not_active';
  return reason;
}

/** `2026-11-01 11:00 UTC`: when the link stops working, for the mail text. */
function formatExpiry(expiresAt: Date): string {
  return `${expiresAt.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}
