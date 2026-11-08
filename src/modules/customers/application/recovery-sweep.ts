// RecoverySweep: the automatic reminder (feature 19, RULES checkouts 3): every few minutes, email the checkouts that have waited
// `abandonedMinutes`, under the same rule and the same claim as the manual send.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import { DbService } from '../../../infra/db';
import { AuditService, NotificationService, SettingsReader } from '../../platform';
import {
  ABANDONED_MINUTES_BOUNDS,
  ABANDONED_MINUTES_KEY,
  DEFAULT_ABANDONED_MINUTES,
  REMINDER_BATCH_SIZE,
} from '../domain/recovery';
import { dueRecoveryIds } from '../infra/recovery.repository';
import { ABANDONED_EVENT, RecoveryQueue } from './recovery-queue';

/** What one tick did. */
export interface SweepSummary {
  /** The checkouts the selection found due. */
  readonly due: number;
  /** The emails queued. */
  readonly queued: number;
  /** The ones the rule turned away at the last look (a racing manual send, a consent withdrawn, no template). */
  readonly skipped: number;
}

/**
 * Sends the automatic recovery emails.
 *
 * Why: the `abandonedMinutes` setting is "the automatic reminder delay": a checkout left unpaid for that long, whose customer agreed to
 * marketing email, gets one reminder without staff pressing "Remind". The selection (`canRecoverSql`) and the decision
 * ({@link RecoveryQueue}) are the manual send's, so a manual send after the reminder is `already_emailed` and the two never mail
 * one checkout twice. At most {@link REMINDER_BATCH_SIZE} per tick; the next tick takes the rest.
 *
 * Side effects: see {@link RecoveryQueue}; writes one `audit_logs` row per tick that queued something (the system acts).
 */
@Injectable()
export class RecoverySweep {
  constructor(
    private readonly db: DbService,
    private readonly queue: RecoveryQueue,
    private readonly audit: AuditService,
    private readonly settings: SettingsReader,
    private readonly notifications: NotificationService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Lists the checkouts that are due now and can be mailed now.
   *
   * Why: a checkout whose customer's language has no usable `checkout.abandoned` template (and English is missing or off too) cannot be
   * mailed; if the selection kept taking it, the same oldest {@link REMINDER_BATCH_SIZE} could fill every tick and starve the rest. It
   * is left out until a template is switched on; the manual send still answers `no_template` / `template_off` for it.
   *
   * @returns their ids, oldest first (at most {@link REMINDER_BATCH_SIZE})
   */
  async due(): Promise<number[]> {
    const languages = await this.notifications.writableLanguages(this.db.db, {
      event: ABANDONED_EVENT,
      channel: 'email',
      audience: 'customer',
    });
    return dueRecoveryIds(
      this.db.db,
      await this.clockOf(),
      REMINDER_BATCH_SIZE,
      languages.anyLanguage ? undefined : languages.locales,
    );
  }

  /**
   * Queues the emails of some due checkouts.
   *
   * @param ids the checkouts from {@link RecoverySweep.due}
   * @returns what the tick did
   */
  async run(ids: readonly number[]): Promise<SweepSummary> {
    const clock = await this.clockOf();
    return this.db.runInTransaction(async ({ tx }) => {
      const outcome = await this.queue.queue(tx, ids, clock);
      if (outcome.sent.length > 0) {
        await this.audit.record(tx, {
          action: 'sent automatic recovery emails',
          entityType: 'checkout',
          entityLabel: `${outcome.sent.length} abandoned checkouts`,
          before: { emails: 0 },
          after: { emails: outcome.sent.length, checkoutIds: outcome.sent, skipped: outcome.skipped.length },
        });
      }
      return { due: ids.length, queued: outcome.sent.length, skipped: outcome.skipped.length };
    });
  }

  private async clockOf() {
    const delayMinutes = await this.settings.integer(
      ABANDONED_MINUTES_KEY,
      DEFAULT_ABANDONED_MINUTES,
      ABANDONED_MINUTES_BOUNDS,
    );
    return { now: this.clock.now(), delayMinutes };
  }
}
