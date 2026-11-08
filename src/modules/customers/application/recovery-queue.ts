// RecoveryQueue: decides which checkouts get their recovery email and queues it (feature 19, RULES checkouts 3 and 4). The one place
// the manual send (`POST /admin/checkouts/recover`) and the automatic reminder share, so both follow the same rule.
import { Injectable } from '@nestjs/common';
import type { DbExecutor } from '../../../infra/db';
import { NotificationService, type SkipReason as NotificationSkip } from '../../platform';
import { type RecoverySession, type SkipReason, recoveryVerdict } from '../domain/recovery';
import { type RecoveryClock, type RecoveryRow, claimRecovery, readRecoveryRows } from '../infra/recovery.repository';
import { RecoveryOutbox } from './recovery-outbox';

/** The notification event of the recovery mail (registered by the platform's event registry). */
export const ABANDONED_EVENT = 'checkout.abandoned';

/** What a send decided. */
export interface RecoveryOutcome {
  /** The checkouts whose email was queued, in the order asked. */
  readonly sent: number[];
  /** The checkouts left out, in the order asked, with the first reason that applied. */
  readonly skipped: Array<{ id: number; reason: SkipReason }>;
}

/**
 * Turns a recovery read into the parts the pure rule reads.
 *
 * @param row the session with its customer facts
 * @returns the session as {@link recoveryVerdict} takes it
 */
export function sessionOf(row: RecoveryRow): RecoverySession {
  return {
    createdAt: row.session.createdAt,
    recoveryEmailedAt: row.session.recoveryEmailedAt,
    orderId: row.session.orderId,
    status: row.session.status,
    customerActive: row.customerStatus === 'active',
  };
}

/** What the notification service's refusals mean for a recovery send. */
const SKIP_OF_NOTIFICATION: Readonly<Record<NotificationSkip, SkipReason>> = {
  no_template: 'no_template',
  template_off: 'template_off',
  recipient_suspended: 'recipient_suspended',
  // A customer row that is gone cannot have a consent, which is the closest honest answer.
  recipient_gone: 'no_marketing_consent',
};

/**
 * Queues the recovery emails of some checkouts.
 *
 * Why: RULES checkouts 3 and 4: for each id the server decides again (exists, not emailed, not paid, consent, active customer, due,
 * not too old), then sends only to the eligible ones. Eligible means the rule says yes AND the `checkout.abandoned` email has an
 * active template, so staff are told `no_template` instead of "sent" when nothing could go out. An eligible checkout is claimed
 * (`recovery_emailed_at`, once only) and one `checkout.recovery` event is written, all in the caller's transaction: the email exists
 * if and only if the claim does. The sessions are read under `FOR UPDATE` in id order, so two sends over the same ids never mail
 * one checkout twice and never deadlock.
 *
 * Side effects: updates `checkout_sessions.recovery_emailed_at`, inserts `outbox_events` rows.
 */
@Injectable()
export class RecoveryQueue {
  constructor(
    private readonly outbox: RecoveryOutbox,
    private readonly notifications: NotificationService,
  ) {}

  /**
   * Decides and queues.
   *
   * @param tx the caller's transaction
   * @param ids the checkout ids; a repeated id counts once
   * @param clock the clock's time and the `abandonedMinutes` setting
   * @returns the ids queued and the ids left out with their reasons
   */
  async queue(tx: DbExecutor, ids: readonly number[], clock: RecoveryClock): Promise<RecoveryOutcome> {
    const unique = [...new Set(ids)];
    const rows = new Map((await readRecoveryRows(tx, unique, true)).map((row) => [row.session.id, row]));
    const sent: number[] = [];
    const skipped: RecoveryOutcome['skipped'] = [];
    // A missing or switched-off template is the same answer for every customer of a language: ask once per language, so a shop with
    // no template logs one line per run, not one per checkout.
    const refusedTemplate = new Map<string, SkipReason>();
    for (const id of unique) {
      const row = rows.get(id);
      const verdict = recoveryVerdict(
        row === undefined ? undefined : sessionOf(row),
        row?.consent ?? false,
        clock.now,
        clock.delayMinutes,
      );
      if (verdict !== null || row === undefined || row.session.customerId === null) {
        skipped.push({ id, reason: verdict ?? 'no_marketing_consent' });
        continue;
      }
      const language = row.customerLocale ?? '';
      const refused = refusedTemplate.get(language);
      if (refused !== undefined) {
        skipped.push({ id, reason: refused });
        continue;
      }
      const probe = await this.notifications.check(tx, {
        event: ABANDONED_EVENT,
        recipient: { type: 'customer', id: row.session.customerId },
        channel: 'email',
      });
      if ('skipped' in probe) {
        const reason = SKIP_OF_NOTIFICATION[probe.skipped];
        if (reason === 'no_template' || reason === 'template_off') refusedTemplate.set(language, reason);
        skipped.push({ id, reason });
        continue;
      }
      if (!(await claimRecovery(tx, id, clock.now))) {
        skipped.push({ id, reason: 'already_emailed' });
        continue;
      }
      await this.outbox.enqueue(tx, id);
      sent.push(id);
    }
    return { sent, skipped };
  }
}
