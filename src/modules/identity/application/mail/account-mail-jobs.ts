// AccountMailJobs: what the worker does for an account mail event: re-read the account and the link row, rotate the link's token, and send
// the mail through the notification delivery path with the clear link as a secret that is never stored (decision 064).
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { CLOCK, type Clock } from '../../../../common/clock';
import { APP_CONFIG, type AppConfig } from '../../../../config';
import { DbService } from '../../../../infra/db';
import { UnrecoverableError } from '../../../../infra/queues';
import { type OutboxJobData, NotificationService } from '../../../platform';
import { AccountDirectory } from '../../accounts/account-directory';
import {
  type AccountMailEventInfo,
  accountIdOfMailJob,
  accountMailAccountSkip,
  accountMailEventInfo,
  accountMailLinkUsable,
  formatExpiry,
} from '../../domain/account-mail';
import { accountMailLink } from '../../domain/public-links';
import { AccountAuthTokenService } from '../account-auth-tokens';

/** What a mail job answers (kept briefly with the BullMQ job). */
export interface AccountMailJobResult {
  readonly sent: boolean;
  /** Why nothing was sent. */
  readonly skipped?:
    | 'account_gone'
    | 'account_not_active'
    | 'rank_changed'
    | 'link_not_usable'
    | 'no_template'
    | 'template_off'
    | 'already_sent'
    | 'already_failed';
  /** The reason of a mail that could not be delivered for good (it is also on the `notifications` row). */
  readonly failed?: string;
}

/** The parts of a BullMQ job the mail job reads; tests pass a plain object. */
export type AccountMailJob = Pick<Job<OutboxJobData>, 'data'> & {
  readonly attemptsMade?: number;
  readonly opts?: { readonly attempts?: number };
};

/** Maps the notification path's skip reasons onto the job's: a recipient that is gone is an account that is gone. */
function skipReason(
  reason: 'recipient_gone' | 'recipient_suspended' | 'no_template' | 'template_off' | 'already_sent' | 'already_failed',
): NonNullable<AccountMailJobResult['skipped']> {
  if (reason === 'recipient_gone') return 'account_gone';
  if (reason === 'recipient_suspended') return 'account_not_active';
  return reason;
}

/**
 * Runs one account mail job (the seven link mails of both rank kinds).
 *
 * Why: feature 12a and 14b and decision 033, one job for every rank (decision 064): the outbox row keeps only the `auth_tokens` id, and a
 * token is stored only as a hash, so the clear token for the link must be made inside this job. The job re-reads everything and checks that
 * the mail is still worth sending (an account that can act, still of the rank the mail was written for; a link of an account's, not used,
 * voided or expired and of this mail's purpose), then rotates the link: the placeholder token the request made (never sent to anyone) is
 * replaced by a new random one on the same row, keeping the row's expiry, and the clear value goes into the mail as the `link` secret.
 * Nothing stores or logs it. The `notifications` row (dedupe key `outbox-<event id>:email`) logs the mail without the link; a retry of the
 * job rotates again (the earlier clear value was never delivered) and resends, and a repeat after a delivered mail is skipped before it
 * can spoil the link that arrived. A mail is at least once.
 *
 * Side effects: reads `clients` and `auth_tokens`; updates the link's `token_hash`; the notification delivery writes a `notifications` row
 * and sends one email; a retry that ends skipped marks the row of an earlier attempt `failed` with the skip reason.
 *
 * @see docs/queues.md (notifications)
 */
@Injectable()
export class AccountMailJobs {
  private readonly logger = new Logger('AccountMail');

  constructor(
    private readonly db: DbService,
    private readonly accounts: AccountDirectory,
    private readonly tokens: AccountAuthTokenService,
    private readonly notifications: NotificationService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Handles one mail event.
   *
   * @param type the outbox event type the processor is registered for (one of the seven account mails)
   * @param job the outbox job (`payload.accountId` the account, `payload.tokenId` the link row)
   * @returns whether the mail was sent, and why not
   * @throws {UnrecoverableError} when the type is not an account mail, the job has no account id (a job of the retired customer table
   *   carries only a customer number) or no token id (a programming error: retrying cannot help)
   * @throws {DeliveryError} when the mail server did not take the mail and a retry may help (the queue retries, 5 attempts)
   */
  async handle(type: string, job: AccountMailJob): Promise<AccountMailJobResult> {
    const info = accountMailEventInfo(type);
    if (info === undefined) throw new UnrecoverableError(`${type} is not an account mail`);
    const accountId = accountIdOfMailJob(info, job.data);
    if (accountId === undefined) {
      throw new UnrecoverableError(
        `${type} job without an accountId: a customer number is never read as an account id`,
      );
    }
    const tokenId = job.data.payload['tokenId'];
    if (typeof tokenId !== 'number') throw new UnrecoverableError(`${type} job without a tokenId`);

    const result = await this.decide(type, info, accountId, tokenId, job);
    // A retry that ends skipped must not leave the row an earlier attempt made `queued` for ever: that row is finished as failed, with
    // the skip reason as its error. `already_sent` and `already_failed` mean the row is finished already.
    if (result.skipped && result.skipped !== 'already_sent' && result.skipped !== 'already_failed') {
      await this.notifications.abandon(`outbox-${job.data.eventId}:email`, result.skipped);
    }
    return result;
  }

  /** Checks that the mail is still worth sending, rotates the link and sends it (the body of {@link handle}). */
  private async decide(
    type: string,
    info: AccountMailEventInfo,
    accountId: number,
    tokenId: number,
    job: AccountMailJob,
  ): Promise<AccountMailJobResult> {
    const account = await this.accounts.findById(this.db.db, accountId);
    // The notification path treats these mails as always sendable, so the status and the rank are judged here (domain rule).
    const accountSkip = accountMailAccountSkip(info, account);
    if (accountSkip !== undefined || account === undefined)
      return { sent: false, skipped: accountSkip ?? 'account_gone' };

    const link = await this.tokens.findById(tokenId);
    const now = this.clock.now();
    if (link === undefined || !accountMailLinkUsable(info, account.id, link, now))
      return { sent: false, skipped: 'link_not_usable' };

    // A repeat of a job whose mail already went out (or failed for good) must not rotate the token of the link that arrived.
    const earlier = await this.notifications.statusOf(`outbox-${job.data.eventId}:email`);
    if (earlier === 'sent') return { sent: false, skipped: 'already_sent' };
    if (earlier === 'failed') return { sent: false, skipped: 'already_failed' };

    // A mail that cannot be written must not rotate a token nobody will receive (a security email always has its shipped text, decision 047).
    const recipient = { type: 'account', id: account.id } as const;
    const probe = await this.notifications.check(this.db.db, { event: type, recipient, channel: 'email' });
    if ('skipped' in probe) {
      this.logger.warn(`No mail sent for ${type} to account ${account.id}: ${probe.skipped}.`);
      return { sent: false, skipped: skipReason(probe.skipped) };
    }

    const token = await this.tokens.rotate(link.id);
    if (token === undefined) return { sent: false, skipped: 'link_not_usable' };

    // The merchant texts greet `merchantName`, the retail texts `customerName` (the stored templates keep their variables).
    const variables: Record<string, string> = { expiresAt: formatExpiry(link.expiresAt) };
    variables[info.rankKind === 'merchant' ? 'merchantName' : 'customerName'] = account.name;
    const result = await this.notifications.sendNow(
      {
        event: type,
        recipient,
        channel: 'email',
        variables,
        dedupeKey: `outbox-${job.data.eventId}:email`,
      },
      { link: accountMailLink(this.config.http.storeBaseUrl, info.kind, token) },
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
