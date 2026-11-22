// SupplierLogRetention: the daily deletion of supplier call logs older than 90 days (decision 053).
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import { DbService } from '../../../infra/db';
import { deleteOldLogs } from '../infra/supplier-log.repository';

/** Supplier call logs are deleted this many days after the call (decision 053). */
export const SUPPLIER_LOG_RETENTION_DAYS = 90;
/** Rows deleted per statement. */
export const SUPPLIER_LOG_RETENTION_BATCH = 1000;
/** Statements per run: at most 100 000 rows; a larger backlog is finished by the next nights. */
export const SUPPLIER_LOG_RETENTION_MAX_BATCHES = 100;
const DAY_MS = 24 * 60 * 60_000;

/**
 * Deletes supplier call logs older than 90 days.
 *
 * Why: decision 053. `supplier_api_logs` grew by a row per supplier call for ever (the poll alone writes one per open order every few
 * minutes). Nothing references a log row, and the supplier poll reads only the newest `getimeiorder` log of each open order, which is
 * minutes old, so no live read is affected. Batches by id; a deleted row cannot be deleted twice, so a repeat or a parallel run only
 * finds fewer rows.
 *
 * Side effects: deletes `supplier_api_logs` rows.
 */
@Injectable()
export class SupplierLogRetention {
  constructor(
    private readonly db: DbService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Runs the clean-up once.
   *
   * @returns how many log rows were deleted
   */
  async run(): Promise<{ deleted: number }> {
    const before = new Date(this.clock.nowMs() - SUPPLIER_LOG_RETENTION_DAYS * DAY_MS);
    let deleted = 0;
    for (let round = 0; round < SUPPLIER_LOG_RETENTION_MAX_BATCHES; round += 1) {
      const batch = await deleteOldLogs(this.db.db, before, SUPPLIER_LOG_RETENTION_BATCH);
      deleted += batch;
      if (batch < SUPPLIER_LOG_RETENTION_BATCH) break;
    }
    return { deleted };
  }
}
