// CheckoutRecoveryService: the use case of `POST /admin/checkouts/recover` (feature 19, RULES checkouts 4): decide each id, queue the
// emails of the eligible ones and write one audit entry for the call.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import { DbService } from '../../../infra/db';
import { AuditService, SettingsReader } from '../../platform';
import {
  ABANDONED_MINUTES_BOUNDS,
  ABANDONED_MINUTES_KEY,
  DEFAULT_ABANDONED_MINUTES,
  type SkipReason,
} from '../domain/recovery';
import { RecoveryQueue } from './recovery-queue';

/** What the recover route answers. */
export interface RecoverResult {
  readonly sent: number;
  readonly skipped: Array<{ id: number; reason: SkipReason }>;
}

/**
 * Sends recovery emails on a staff member's request.
 *
 * Why: the console's "Remind" button (M1, M132, M133). The server, not the console, decides: the answer says how many emails were
 * queued and why each of the others was left out, and a call that sent nothing is still `200`.
 *
 * Side effects: see {@link RecoveryQueue}; writes one `audit_logs` row (`sent recovery emails`, entity `checkout`) holding the count and the ids.
 */
@Injectable()
export class CheckoutRecoveryService {
  constructor(
    private readonly db: DbService,
    private readonly queue: RecoveryQueue,
    private readonly audit: AuditService,
    private readonly settings: SettingsReader,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Decides and queues the emails of some checkouts.
   *
   * @param ids the ticked checkouts (1 to 100; a repeated id counts once)
   * @returns how many emails were queued and which checkouts were left out
   */
  async recover(ids: readonly number[]): Promise<RecoverResult> {
    const delayMinutes = await this.settings.integer(
      ABANDONED_MINUTES_KEY,
      DEFAULT_ABANDONED_MINUTES,
      ABANDONED_MINUTES_BOUNDS,
    );
    return this.db.runInTransaction(async ({ tx }) => {
      const outcome = await this.queue.queue(tx, ids, { now: this.clock.now(), delayMinutes });
      // The demo logs `sent recovery emails` on `n abandoned checkouts` with the diff `emails 0 -> n` (12-state-b2c.js).
      await this.audit.record(tx, {
        action: 'sent recovery emails',
        entityType: 'checkout',
        entityLabel: `${outcome.sent.length} abandoned checkouts`,
        before: { emails: 0 },
        after: { emails: outcome.sent.length, checkoutIds: outcome.sent, skipped: outcome.skipped.length },
      });
      return { sent: outcome.sent.length, skipped: outcome.skipped };
    });
  }
}
