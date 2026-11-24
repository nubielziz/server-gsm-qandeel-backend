// IdempotencyPurge: forgets the merchant portal's Idempotency-Keys older than 7 days (orders module, queue maintenance, job
// idempotency_purge; MISMATCHES B166).
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import { DbService } from '../../../infra/db';
import { idempotencyCutoff } from '../domain/idempotency-window';
import { deleteIdempotencyRecordsBefore } from '../infra/idempotency.repository';

/** Rows deleted per statement. */
export const IDEMPOTENCY_PURGE_BATCH_SIZE = 1_000;

/**
 * What one purge removed.
 *
 * Why: B166. The tests and the job's `job_runs` row need the count of the stored answers that were deleted.
 */
export interface IdempotencyPurgeCount {
  /** `idempotency_keys` rows deleted */
  readonly answers: number;
}

/**
 * Ends the memory of old Idempotency-Keys.
 *
 * Why: B166. A key is remembered for the 7-day window (`IDEMPOTENCY_WINDOW_DAYS`); after it the key is free again for that merchant and the
 * stored answer, delivered stock codes included, is gone. The window is exact on its own: a placement that meets an expired key forgets it
 * before it replays (`IdempotencyStore.run`). This job cleans what nobody sends again, so old answers do not stay in the table. Safe to
 * repeat or run in parallel: a deleted row is not matched again.
 *
 * Side effects: deletes `idempotency_keys` rows, in batches of {@link IDEMPOTENCY_PURGE_BATCH_SIZE}.
 */
@Injectable()
export class IdempotencyPurge {
  constructor(
    private readonly db: DbService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Forgets the answers stored before `now - 7 days`.
   *
   * @returns how many answers were deleted
   */
  async purge(): Promise<IdempotencyPurgeCount> {
    const cutoff = idempotencyCutoff(this.clock.nowMs());
    const answers = await this.drain((limit) => deleteIdempotencyRecordsBefore(this.db.db, cutoff, limit));
    return { answers };
  }

  /** Repeats one batch statement until a batch comes back short. */
  private async drain(batch: (limit: number) => Promise<number>): Promise<number> {
    let total = 0;
    for (;;) {
      const changed = await batch(IDEMPOTENCY_PURGE_BATCH_SIZE);
      total += changed;
      if (changed < IDEMPOTENCY_PURGE_BATCH_SIZE) return total;
    }
  }
}
