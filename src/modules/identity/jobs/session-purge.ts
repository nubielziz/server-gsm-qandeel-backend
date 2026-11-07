// SessionPurge: deletes the sessions that ended more than 30 days ago (identity module, queue maintenance, job session_purge).
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import { DbService } from '../../../infra/db';
import { deleteEndedSessions } from '../infra/session-purge.repository';

/** How long an ended session is kept (the brief of feature 2a): long enough to look into an incident, short enough to stay small. */
export const SESSION_RETENTION_DAYS = 30;
/** Rows deleted per statement. */
export const PURGE_BATCH_SIZE = 1_000;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Removes old ended sessions.
 *
 * Why: `sessions` gets a row per sign-in step and per rotation, and ended rows are only kept for a while. Purging them is
 * safe to repeat or run in parallel: a deleted row cannot be deleted twice, and live sessions are never touched.
 *
 * Side effects: deletes `sessions` rows (in batches of {@link PURGE_BATCH_SIZE}).
 */
@Injectable()
export class SessionPurge {
  constructor(
    private readonly db: DbService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Deletes the sessions that ended before `now - 30 days`.
   *
   * @returns how many sessions were deleted
   */
  async purge(): Promise<number> {
    const cutoff = new Date(this.clock.nowMs() - SESSION_RETENTION_DAYS * DAY_MS);
    let total = 0;
    for (;;) {
      const deleted = await deleteEndedSessions(this.db.db, cutoff, PURGE_BATCH_SIZE);
      total += deleted;
      if (deleted < PURGE_BATCH_SIZE) return total;
    }
  }
}
