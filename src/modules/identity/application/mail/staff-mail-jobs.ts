// StaffMailJobs: what the worker does for a staff mail event: re-read the staff member and the link row, rotate the link's token, and send the
// mail through the notification delivery path with the clear link as a secret that is never stored (feature 20, slice C).
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { CLOCK, type Clock } from '../../../../common/clock';
import { APP_CONFIG, type AppConfig } from '../../../../config';
import { TokenService } from '../../../../infra/crypto';
import { DbService } from '../../../../infra/db';
import { UnrecoverableError } from '../../../../infra/queues';
import { type OutboxJobData, NotificationService } from '../../../platform';
import { findStaffTokenById, rotateStaffToken, type StaffTokenPurpose } from '../../infra/auth-token.repository';
import { findStaffById } from '../../infra/staff-auth.repository';
import { formatExpiry } from './merchant-mail-jobs';
import { STAFF_MAIL_EVENTS, type StaffMailKind } from './staff-mail-outbox';

/** The token purpose each mail is about; a job whose row says otherwise is not sent. */
const PURPOSE_OF_KIND: Readonly<Record<StaffMailKind, StaffTokenPurpose>> = {
  invited: 'invite',
  password_reset: 'reset',
};

/**
 * Builds the link of a staff mail.
 *
 * Why: the console page `/set-password` exists (`FA/src/features/auth/paths.ts`); it posts the token to `POST /admin/auth/password/set`.
 *
 * @param consoleBaseUrl the admin console's base URL, without a trailing slash (`config.http.consoleBaseUrl`)
 * @param token the clear token
 * @returns `<consoleBaseUrl>/set-password?token=<token>`
 */
export function staffMailLink(consoleBaseUrl: string, token: string): string {
  return `${consoleBaseUrl}/set-password?token=${encodeURIComponent(token)}`;
}

/** What a staff mail job answers (kept briefly with the BullMQ job). */
export interface StaffMailJobResult {
  readonly sent: boolean;
  /** Why nothing was sent. */
  readonly skipped?:
    | 'staff_gone'
    | 'staff_suspended'
    | 'link_not_usable'
    | 'no_template'
    | 'template_off'
    | 'already_sent'
    | 'already_failed';
  /** The reason of a mail that could not be delivered for good (it is also on the `notifications` row). */
  readonly failed?: string;
}

/** The parts of a BullMQ job the mail job reads; tests pass a plain object. */
export type StaffMailJob = Pick<Job<OutboxJobData>, 'data'> & {
  readonly attemptsMade?: number;
  readonly opts?: { readonly attempts?: number };
};

/**
 * Runs one staff mail job.
 *
 * Why: the same design as `MerchantMailJobs` (feature 12a): the outbox row keeps only the `auth_tokens` id and a token is stored only as a
 * hash, so the clear token of the link is made inside this job. The job re-reads everything, checks that the link is still worth sending (not
 * used, not expired, not replaced) and that no mail of this event was delivered, then rotates the placeholder token on the same row and
 * sends the clear link as the `link` secret. Nothing stores or logs it; the `notifications` row (dedupe key `outbox-<event id>:email`)
 * records the mail without it. A retry rotates again (the earlier clear value never arrived) and resends: at least once.
 *
 * Side effects: reads `staff_users` and `auth_tokens`; updates the link's `token_hash`; the delivery writes a `notifications` row and sends
 * one email; a retry that ends skipped marks the row of an earlier attempt `failed` with the skip reason.
 *
 * @see docs/queues.md (notifications)
 */
@Injectable()
export class StaffMailJobs {
  private readonly logger = new Logger('StaffMail');

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
   * @param job the outbox job (`aggregateId` is the staff member, `payload.tokenId` the link row)
   * @returns whether the mail was sent, and why not
   * @throws {UnrecoverableError} when the job has no token id (a programming error: retrying cannot help)
   * @throws {DeliveryError} when the mail server did not take the mail and a retry may help (the queue retries)
   */
  async handle(kind: StaffMailKind, job: StaffMailJob): Promise<StaffMailJobResult> {
    const tokenId = job.data.payload['tokenId'];
    if (typeof tokenId !== 'number') throw new UnrecoverableError(`${STAFF_MAIL_EVENTS[kind]} job without a tokenId`);

    const result = await this.decide(kind, job, tokenId);
    // A retry that ends skipped must not leave the row an earlier attempt made `queued` for ever.
    if (result.skipped && result.skipped !== 'already_sent' && result.skipped !== 'already_failed') {
      await this.notifications.abandon(`outbox-${job.data.eventId}:email`, result.skipped);
    }
    return result;
  }

  /** Checks that the mail is still worth sending, rotates the link and sends it (the body of {@link handle}). */
  private async decide(kind: StaffMailKind, job: StaffMailJob, tokenId: number): Promise<StaffMailJobResult> {
    const staff = await findStaffById(this.db.db, job.data.aggregateId);
    if (!staff) return { sent: false, skipped: 'staff_gone' };
    // A suspended member's link is dead anyway (the set-password route refuses them).
    if (staff.status === 'suspended') return { sent: false, skipped: 'staff_suspended' };

    const link = await findStaffTokenById(this.db.db, tokenId);
    const now = this.clock.now();
    const usable =
      link !== undefined &&
      link.subjectId === staff.id &&
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
      event: STAFF_MAIL_EVENTS[kind],
      recipient: { type: 'staff', id: staff.id },
      channel: 'email',
    });
    if ('skipped' in probe) {
      this.logger.warn(`No mail sent for ${STAFF_MAIL_EVENTS[kind]} to staff ${staff.id}: ${probe.skipped}.`);
      return { sent: false, skipped: staffSkip(probe.skipped) };
    }

    const token = this.tokens.random(32);
    const rotated = await rotateStaffToken(this.db.db, link.id, this.tokens.hash(token), now);
    if (!rotated) return { sent: false, skipped: 'link_not_usable' };

    const result = await this.notifications.sendNow(
      {
        event: STAFF_MAIL_EVENTS[kind],
        recipient: { type: 'staff', id: staff.id },
        channel: 'email',
        variables: { staffName: staff.name, expiresAt: formatExpiry(link.expiresAt) },
        dedupeKey: `outbox-${job.data.eventId}:email`,
      },
      { link: staffMailLink(this.config.http.consoleBaseUrl, token) },
      { attempt: (job.attemptsMade ?? 0) + 1, maxAttempts: job.opts?.attempts ?? 1 },
    );
    switch (result.status) {
      case 'sent':
        return { sent: true };
      case 'failed':
        return { sent: false, failed: result.reason };
      case 'skipped':
        return { sent: false, skipped: staffSkip(result.reason) };
    }
  }
}

/** Maps the delivery path's skip reasons to the staff job's (`recipient_gone` and `recipient_suspended` name the staff member). */
function staffSkip(reason: string): NonNullable<StaffMailJobResult['skipped']> {
  if (reason === 'recipient_gone') return 'staff_gone';
  if (reason === 'recipient_suspended') return 'staff_suspended';
  return reason as NonNullable<StaffMailJobResult['skipped']>;
}
