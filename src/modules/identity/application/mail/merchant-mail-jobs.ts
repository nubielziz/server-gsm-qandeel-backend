// MerchantMailJobs: what the worker does for a merchant mail event: re-read the merchant and the link row, rotate the link's token, and
// send the mail through the notification delivery path with the clear link as a secret that is never stored.
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { CLOCK, type Clock } from '../../../../common/clock';
import { APP_CONFIG, type AppConfig } from '../../../../config';
import { TokenService } from '../../../../infra/crypto';
import { DbService } from '../../../../infra/db';
import { UnrecoverableError } from '../../../../infra/queues';
import { type OutboxJobData, NotificationService } from '../../../platform';
import { findClientById } from '../../infra/merchant-auth.repository';
import { type ClientTokenPurpose, findClientTokenById, rotateClientToken } from '../../infra/merchant-token.repository';
import { MERCHANT_MAIL_EVENTS, type MerchantMailKind } from './merchant-mail-outbox';

/** The token purpose each mail is about; a job whose row says otherwise is not sent. */
const PURPOSE_OF_KIND: Readonly<Record<MerchantMailKind, ClientTokenPurpose>> = {
  email_verification: 'verify_email',
  password_reset: 'reset',
  invited: 'invite',
};

/** Where each mail's link points in the merchant portal (`<PORTAL_BASE_URL><path>?token=<token>`). */
const PORTAL_PATHS: Readonly<Record<MerchantMailKind, string>> = {
  email_verification: '/verify-email',
  password_reset: '/set-password',
  invited: '/set-password',
};

/**
 * Builds the link of a merchant mail.
 *
 * @param portalBaseUrl the merchant portal's base URL, without a trailing slash
 * @param kind which mail
 * @param token the clear token
 * @returns `<portalBaseUrl>/set-password?token=<token>` (or `/verify-email`)
 */
export function merchantMailLink(portalBaseUrl: string, kind: MerchantMailKind, token: string): string {
  return `${portalBaseUrl}${PORTAL_PATHS[kind]}?token=${encodeURIComponent(token)}`;
}

/** What a mail job answers (kept briefly with the BullMQ job). */
export interface MerchantMailJobResult {
  readonly sent: boolean;
  /** Why nothing was sent. */
  readonly skipped?:
    | 'merchant_gone'
    | 'merchant_suspended'
    | 'link_not_usable'
    | 'no_template'
    | 'template_off'
    | 'already_sent'
    | 'already_failed';
  /** The reason of a mail that could not be delivered for good (it is also on the `notifications` row). */
  readonly failed?: string;
}

/** The parts of a BullMQ job the mail job reads; tests pass a plain object. */
export type MerchantMailJob = Pick<Job<OutboxJobData>, 'data'> & {
  readonly attemptsMade?: number;
  readonly opts?: { readonly attempts?: number };
};

/**
 * Runs one merchant mail job.
 *
 * Why: brief 12a, RESOLUTIONS identity-platform-2 and decision 019: the outbox row keeps only the `auth_tokens` id, and a token is stored
 * only as a hash, so the clear token for the link must be made inside this job. The job re-reads everything, checks that the link is still
 * worth sending (not used, not expired, not replaced), then rotates it: the placeholder token the request made (never sent to anyone) is
 * replaced by a new random one on the same row, keeping the row's expiry, and the clear value goes into the mail as the `link` secret.
 * Nothing stores or logs it. The `notifications` row (dedupe key `outbox-<event id>:email`) logs the mail without the link; a retry of the
 * job rotates again (the earlier clear value was never delivered) and resends. A mail is at least once.
 *
 * Side effects: reads `clients` and `auth_tokens`; updates the link's `token_hash`; the notification delivery writes a `notifications`
 * row and sends one email; a retry that ends skipped marks the row of an earlier attempt `failed` with the skip reason.
 *
 * @see docs/queues.md (notifications)
 */
@Injectable()
export class MerchantMailJobs {
  private readonly logger = new Logger('MerchantMail');

  constructor(
    private readonly db: DbService,
    private readonly tokens: TokenService,
    private readonly notifications: NotificationService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Handles one mail event.
   *
   * @param kind which mail the event type means
   * @param job the outbox job (`aggregateId` is the merchant, `payload.tokenId` the link row)
   * @returns whether the mail was sent, and why not
   * @throws {UnrecoverableError} when the job has no token id (a programming error: retrying cannot help)
   * @throws {DeliveryError} when the mail server did not take the mail and a retry may help (the queue retries, 5 attempts)
   */
  async handle(kind: MerchantMailKind, job: MerchantMailJob): Promise<MerchantMailJobResult> {
    const tokenId = job.data.payload['tokenId'];
    if (typeof tokenId !== 'number')
      throw new UnrecoverableError(`${MERCHANT_MAIL_EVENTS[kind]} job without a tokenId`);

    const result = await this.decide(kind, job, tokenId);
    // A retry that ends skipped must not leave the row an earlier attempt made `queued` for ever: that row is finished as failed, with
    // the skip reason as its error. `already_sent` and `already_failed` mean the row is finished already.
    if (result.skipped && result.skipped !== 'already_sent' && result.skipped !== 'already_failed') {
      await this.notifications.abandon(`outbox-${job.data.eventId}:email`, result.skipped);
    }
    return result;
  }

  /** Checks that the mail is still worth sending, rotates the link and sends it (the body of {@link handle}). */
  private async decide(kind: MerchantMailKind, job: MerchantMailJob, tokenId: number): Promise<MerchantMailJobResult> {
    const client = await findClientById(this.db.db, job.data.aggregateId);
    if (!client) return { sent: false, skipped: 'merchant_gone' };
    if (client.status === 'suspended') return { sent: false, skipped: 'merchant_suspended' };

    const link = await findClientTokenById(this.db.db, tokenId);
    const now = this.clock.now();
    const usable =
      link !== undefined &&
      link.subjectId === client.id &&
      link.purpose === PURPOSE_OF_KIND[kind] &&
      link.usedAt === null &&
      link.expiresAt.getTime() > now.getTime();
    if (!usable) return { sent: false, skipped: 'link_not_usable' };

    // A repeat of a job whose mail already went out (or failed for good) must not rotate the token of the link that arrived.
    const earlier = await this.notifications.statusOf(`outbox-${job.data.eventId}:email`);
    if (earlier === 'sent') return { sent: false, skipped: 'already_sent' };
    if (earlier === 'failed') return { sent: false, skipped: 'already_failed' };

    // A mail with no template to send (missing or switched off) must not rotate a token nobody will receive.
    const probe = await this.notifications.check(this.db.db, {
      event: MERCHANT_MAIL_EVENTS[kind],
      recipient: { type: 'client', id: client.id },
      channel: 'email',
    });
    if ('skipped' in probe) {
      this.logger.warn(`No mail sent for ${MERCHANT_MAIL_EVENTS[kind]} to merchant ${client.id}: ${probe.skipped}.`);
      return {
        sent: false,
        skipped:
          probe.skipped === 'recipient_gone'
            ? 'merchant_gone'
            : probe.skipped === 'recipient_suspended'
              ? 'merchant_suspended'
              : probe.skipped,
      };
    }

    const token = this.tokens.random(32);
    const rotated = await rotateClientToken(this.db.db, link.id, this.tokens.hash(token), now);
    if (!rotated) return { sent: false, skipped: 'link_not_usable' };

    const result = await this.notifications.sendNow(
      {
        event: MERCHANT_MAIL_EVENTS[kind],
        recipient: { type: 'client', id: client.id },
        channel: 'email',
        variables: { merchantName: client.name, expiresAt: formatExpiry(link.expiresAt) },
        dedupeKey: `outbox-${job.data.eventId}:email`,
      },
      { link: merchantMailLink(this.config.http.portalBaseUrl, kind, token) },
      { attempt: (job.attemptsMade ?? 0) + 1, maxAttempts: job.opts?.attempts ?? 1 },
    );
    switch (result.status) {
      case 'sent':
        return { sent: true };
      case 'failed':
        return { sent: false, failed: result.reason };
      case 'skipped':
        return {
          sent: false,
          skipped:
            result.reason === 'recipient_gone'
              ? 'merchant_gone'
              : result.reason === 'recipient_suspended'
                ? 'merchant_suspended'
                : result.reason,
        };
    }
  }
}

/** `2026-11-01 11:00 UTC`: when the link stops working, for the mail text. */
function formatExpiry(expiresAt: Date): string {
  return `${expiresAt.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}
