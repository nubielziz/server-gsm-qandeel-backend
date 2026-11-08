// RecoveryMail: what the worker does for one `checkout.recovery` event (feature 19): re-read the checkout, check once more that the email is
// still welcome, build the one-click link from the session token and send the mail through the notification delivery path.
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { CLOCK, type Clock } from '../../../common/clock';
import { APP_CONFIG, type AppConfig } from '../../../config';
import { EncryptionService } from '../../../infra/crypto';
import { DbService } from '../../../infra/db';
import { UnrecoverableError } from '../../../infra/queues';
import { TacDirectory } from '../../catalog';
import { type OutboxJobData, NotificationService } from '../../platform';
import { CHECKOUT_IMEI_AAD } from '../domain/checkout';
import { deviceName, greetingName, isPaid, recoveryLink } from '../domain/recovery';
import { readRecoveryRows, releaseRecovery } from '../infra/recovery.repository';
import { CHECKOUT_RECOVERY_EVENT } from './recovery-outbox';
import { ABANDONED_EVENT } from './recovery-queue';

/** What a recovery mail job answers (kept briefly with the BullMQ job). */
export interface RecoveryMailResult {
  readonly sent: boolean;
  /** Why nothing was sent. */
  readonly skipped?:
    | 'session_gone'
    | 'already_paid'
    | 'no_marketing_consent'
    | 'recipient_suspended'
    | 'recipient_gone'
    | 'no_template'
    | 'template_off'
    | 'already_sent'
    | 'already_failed';
  /** The reason of a mail that could not be delivered for good (it is also on the `notifications` row). */
  readonly failed?: string;
}

/** The parts of a BullMQ job the mail job reads; tests pass a plain object. */
export type RecoveryMailJob = Pick<Job<OutboxJobData>, 'data'> & {
  readonly attemptsMade?: number;
  readonly opts?: { readonly attempts?: number };
};

/**
 * Sends one recovery email.
 *
 * Why: RULES checkouts 1 and 3: consent is checked again at send time (the customer may have withdrawn it since the claim), and a paid
 * checkout needs no reminder. The link carries the checkout token, which is a bearer secret (decision 010): it is read from the
 * session here and handed to the delivery as a secret, so it is never in the event, the job data or the `notifications` row, which
 * the console shows. The row (dedupe key `outbox-<event id>:email`) logs the mail without the link; a retry of the job finds it
 * and resends. The mail is at least once, like every notification.
 *
 * The claim (`recovery_emailed_at`) is set when the mail is queued. A job that then ends skipped without sending (consent withdrawn,
 * template off, customer no longer active, checkout paid) takes the claim off again, unless a `notifications` row of this event was
 * sent, so the checkout shows as recoverable and a later send can try again instead of looking emailed with no mail behind it.
 *
 * Side effects: reads `checkout_sessions`, `customers`, `consent_records` and `tac_catalog`; the notification delivery writes a
 * `notifications` row and sends one email; a retry that ends skipped marks the row of an earlier attempt `failed` with the reason and
 * clears `checkout_sessions.recovery_emailed_at` (both in one transaction, with the session row locked and the check that no row was
 * sent).
 *
 * @see docs/queues.md (notifications)
 */
@Injectable()
export class RecoveryMail {
  private readonly logger = new Logger('CheckoutRecovery');

  constructor(
    private readonly db: DbService,
    private readonly encryption: EncryptionService,
    private readonly tacs: TacDirectory,
    private readonly notifications: NotificationService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Handles one event.
   *
   * @param job the outbox job (`aggregateId` is the checkout session)
   * @returns whether the mail was sent, and why not
   * @throws {UnrecoverableError} when the job names no session (a programming error: retrying cannot help)
   * @throws {DeliveryError} when the mail server did not take the mail and a retry may help (the queue retries, 5 attempts)
   */
  async handle(job: RecoveryMailJob): Promise<RecoveryMailResult> {
    const sessionId = job.data.aggregateId;
    if (!Number.isSafeInteger(sessionId) || sessionId <= 0) {
      throw new UnrecoverableError(`${CHECKOUT_RECOVERY_EVENT} job without a checkout session`);
    }
    const dedupeKey = `outbox-${job.data.eventId}:email`;
    const result = await this.decide(job, sessionId, dedupeKey);
    // A retry that ends skipped must not leave the row an earlier attempt made `queued` for ever. `already_sent` and `already_failed`
    // mean the row is finished already.
    if (result.skipped && result.skipped !== 'already_sent' && result.skipped !== 'already_failed') {
      await this.finish(sessionId, dedupeKey, result.skipped);
    }
    return result;
  }

  /**
   * Ends the row of a mail that was skipped and, when no mail of this event went out, takes the claim off the checkout.
   *
   * Why: the claim says "emailed"; with nothing sent it would hide the checkout from the reminder and from the console's "can recover"
   * for good. Both steps run in one transaction: with two, a failure between them would leave the row `failed` and the claim set, and
   * the retry (which then sees `already_failed`) would never clear it. The session row is locked first, as the manual send does, so
   * the status read and the release see one state and a mail that was sent keeps its claim.
   */
  private async finish(sessionId: number, dedupeKey: string, reason: string): Promise<void> {
    await this.db.runInTransaction(async ({ tx }) => {
      // A vanished session has no claim to release and no row to lock.
      const claimable = reason !== 'session_gone';
      if (claimable) await readRecoveryRows(tx, [sessionId], true);
      await this.notifications.abandon(dedupeKey, reason, tx);
      if (!claimable || (await this.notifications.statusOf(dedupeKey, tx)) === 'sent') return;
      await releaseRecovery(tx, sessionId, this.clock.now());
    });
  }

  /** Checks that the mail is still welcome and sends it (the body of {@link handle}). */
  private async decide(job: RecoveryMailJob, sessionId: number, dedupeKey: string): Promise<RecoveryMailResult> {
    const [row] = await readRecoveryRows(this.db.db, [sessionId]);
    if (!row) return { sent: false, skipped: 'session_gone' };
    const { session } = row;
    if (isPaid(session)) return { sent: false, skipped: 'already_paid' };
    if (session.customerId === null || !row.consent) return { sent: false, skipped: 'no_marketing_consent' };
    if (row.customerStatus !== 'active') return { sent: false, skipped: 'recipient_suspended' };

    // A repeat of a job whose mail already went out (or failed for good) is finished.
    const earlier = await this.notifications.statusOf(dedupeKey);
    if (earlier === 'sent') return { sent: false, skipped: 'already_sent' };
    if (earlier === 'failed') return { sent: false, skipped: 'already_failed' };

    const result = await this.notifications.sendNow(
      {
        event: ABANDONED_EVENT,
        recipient: { type: 'customer', id: session.customerId },
        channel: 'email',
        variables: {
          customerName: greetingName(row.customerName ?? ''),
          device: await this.deviceOf(session.imeiEnc),
        },
        dedupeKey,
      },
      { link: recoveryLink(this.config.http.storeBaseUrl, session.token) },
      { attempt: (job.attemptsMade ?? 0) + 1, maxAttempts: job.opts?.attempts ?? 1 },
    );
    switch (result.status) {
      case 'sent':
        return { sent: true };
      case 'failed':
        return { sent: false, failed: result.reason };
      case 'skipped':
        return { sent: false, skipped: result.reason };
    }
  }

  /** The device the mail names: the catalogue's name for the IMEI's TAC, else "your phone". */
  private async deviceOf(imeiEnc: string | null): Promise<string> {
    if (imeiEnc === null) return deviceName(undefined);
    let tac: string | undefined;
    try {
      tac = /^\d{8}/.exec(this.encryption.decrypt(imeiEnc, CHECKOUT_IMEI_AAD))?.[0];
    } catch (error) {
      // A value that cannot be read (a retired key) only costs the device name, never the mail.
      this.logger.warn(
        `A checkout IMEI could not be decrypted: ${error instanceof Error ? error.message : 'unknown'}.`,
      );
    }
    return deviceName(tac === undefined ? undefined : await this.tacs.find(this.db.db, tac));
  }
}
