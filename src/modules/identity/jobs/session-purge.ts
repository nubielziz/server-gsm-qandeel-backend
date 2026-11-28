// SessionPurge: deletes the sessions that ended more than 30 days ago, and the waiting sign-up details whose link can no longer be used
// (identity module, queue maintenance, job session_purge; decision 079).
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import { DbService } from '../../../infra/db';
import { deleteLapsedSignUps } from '../infra/account-signup.repository';
import { deleteEndedSessions } from '../infra/session-purge.repository';

/** How long an ended session is kept (the brief of feature 2a): long enough to look into an incident, short enough to stay small. */
export const SESSION_RETENTION_DAYS = 30;
/** Rows deleted per statement. */
export const PURGE_BATCH_SIZE = 1_000;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Removes old ended sessions and the sign-up details whose link lapsed.
 *
 * Why: `sessions` gets a row per sign-in step and per rotation, and ended rows are only kept for a while. Decision 079: the details of a
 * shop sign-up (with the argon2id hash of its password) wait beside their link only while the link can be exchanged; the exchange deletes
 * every form of its address, the job `sign_up_purge` runs {@link SessionPurge.purgeLapsedSignUps} every 15 minutes, and this daily pass
 * deletes the rest once their link expired or was used (voided). Purging is safe to repeat or run in
 * parallel: a deleted row cannot be deleted twice, and live sessions and the details of a usable link are never touched.
 *
 * Side effects: deletes `sessions` and `account_signups` rows (in batches of {@link PURGE_BATCH_SIZE}).
 */
@Injectable()
export class SessionPurge {
  constructor(
    private readonly db: DbService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Deletes the sessions that ended before `now - 30 days`, then the waiting sign-up details whose link expired or was used.
   *
   * @returns how many sessions were deleted
   */
  async purge(): Promise<number> {
    const cutoff = new Date(this.clock.nowMs() - SESSION_RETENTION_DAYS * DAY_MS);
    let total = 0;
    for (;;) {
      const deleted = await deleteEndedSessions(this.db.db, cutoff, PURGE_BATCH_SIZE);
      total += deleted;
      if (deleted < PURGE_BATCH_SIZE) break;
    }
    await this.purgeLapsedSignUps();
    return total;
  }

  /**
   * Deletes the waiting sign-up details whose link can no longer be exchanged (expired, used or voided).
   *
   * @returns how many rows were deleted
   */
  async purgeLapsedSignUps(): Promise<number> {
    const now = this.clock.now();
    let total = 0;
    for (;;) {
      const deleted = await deleteLapsedSignUps(this.db.db, now, PURGE_BATCH_SIZE);
      total += deleted;
      if (deleted < PURGE_BATCH_SIZE) return total;
    }
  }
}
