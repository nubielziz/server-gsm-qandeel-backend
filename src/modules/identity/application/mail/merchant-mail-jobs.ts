// MerchantMailJobs: what the worker does for a merchant mail event: re-read the merchant and the link row, skip a mail that is
// no longer worth sending, and hand the rest to the MailSender.
import { Inject, Injectable } from '@nestjs/common';
import type { Job } from 'bullmq';
import { CLOCK, type Clock } from '../../../../common/clock';
import { DbService } from '../../../../infra/db';
import { UnrecoverableError } from '../../../../infra/queues';
import type { OutboxJobData } from '../../../platform';
import type { ClientTokenPurpose } from '../../infra/merchant-token.repository';
import { findClientById } from '../../infra/merchant-auth.repository';
import { findClientTokenById } from '../../infra/merchant-token.repository';
import { MAIL_SENDER, type MailSender, type MerchantMailKind } from './mail-sender';

/** The token purpose each mail is about; a job whose row says otherwise is not sent. */
const PURPOSE_OF_KIND: Readonly<Record<MerchantMailKind, ClientTokenPurpose>> = {
  email_verification: 'verify_email',
  password_reset: 'reset',
  invited: 'invite',
};

/** What a mail job answers (kept briefly with the BullMQ job). */
export interface MerchantMailJobResult {
  readonly sent: boolean;
  /** Why nothing was sent. */
  readonly skipped?: 'merchant_gone' | 'merchant_suspended' | 'link_not_usable';
}

/**
 * Runs one merchant mail job.
 *
 * Why: brief 2b: an email is outbox work (ids only). The job is safe to run twice: it re-reads everything, and a link that was
 * used, voided or has expired is not worth sending. A sender failure is thrown, so the `notifications` queue retries (5
 * attempts, backoff from 30 s); a malformed job is permanent.
 *
 * Side effects: reads `clients` and `auth_tokens`; the sender delivers (today: a redacted log line).
 *
 * @see docs/queues.md (notifications)
 */
@Injectable()
export class MerchantMailJobs {
  constructor(
    private readonly db: DbService,
    @Inject(MAIL_SENDER) private readonly sender: MailSender,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Handles one mail event.
   *
   * @param kind which mail the event type means
   * @param job the outbox job (`aggregateId` is the merchant, `payload.tokenId` the link row)
   * @returns whether the mail was handed to the sender, and why not
   * @throws {UnrecoverableError} when the job has no token id (a programming error: retrying cannot help)
   */
  async handle(kind: MerchantMailKind, job: Pick<Job<OutboxJobData>, 'data'>): Promise<MerchantMailJobResult> {
    const tokenId = job.data.payload['tokenId'];
    if (typeof tokenId !== 'number') throw new UnrecoverableError(`merchant.${kind} job without a tokenId`);

    const client = await findClientById(this.db.db, job.data.aggregateId);
    if (!client) return { sent: false, skipped: 'merchant_gone' };
    if (client.status === 'suspended') return { sent: false, skipped: 'merchant_suspended' };

    const link = await findClientTokenById(this.db.db, tokenId);
    const usable =
      link !== undefined &&
      link.subjectId === client.id &&
      link.purpose === PURPOSE_OF_KIND[kind] &&
      link.usedAt === null &&
      link.expiresAt.getTime() > this.clock.nowMs();
    if (!usable) return { sent: false, skipped: 'link_not_usable' };

    await this.sender.send({
      kind,
      clientId: client.id,
      email: client.email,
      name: client.name,
      tokenId: link.id,
      expiresAt: link.expiresAt,
    });
    return { sent: true };
  }
}
