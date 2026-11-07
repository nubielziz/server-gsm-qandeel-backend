// The worker jobs of the supplier-sync queue (suppliers module): one supplier's sync (asked by staff through the API), the 15-minute price
// sync of every supplier and the 30-minute balance check.
import { Injectable, Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { DbService } from '../../../infra/db';
import { type JobProcessor, QueueProcessor } from '../../../infra/queues';
import { JobRunsService } from '../../health';
import { SupplierSync, type SyncOutcome } from '../application/supplier-sync';
import { SUPPLIER_SYNC_JOB, type SupplierSyncJobData } from '../application/supplier-sync-requests';
import { suppliersToSync } from '../infra/supplier.repository';

/** The scheduled job that syncs every supplier's services and prices (the console's `price_sync`). */
export const PRICE_SYNC_JOB = 'price_sync';
/** The scheduled job that refreshes every supplier's balance (the console's `balance_check`). */
export const BALANCE_CHECK_JOB = 'balance_check';

/** The data of a scheduled job: empty; a manual run carries the `job_runs` row it inserted. */
export interface ScheduledSyncData {
  readonly runId?: number;
}

/** What a scheduled run did. */
export interface ScheduledSyncResult {
  readonly suppliers: number;
  readonly succeeded: number;
  readonly failed: number;
}

/**
 * Runs the sync jobs.
 *
 * Why: the queue has this one processor for three job names. `supplier_sync` runs one sync and RETURNS its outcome (a supplier failure
 * is a value, so the API can answer `409 SUPPLIER_UNAVAILABLE`); `price_sync` and `balance_check` go through every supplier that is not
 * disabled, one failure never stops the others, and each run is recorded in `job_runs`.
 */
@Injectable()
@QueueProcessor('supplier-sync')
export class SupplierSyncProcessor implements JobProcessor<object, SyncOutcome | ScheduledSyncResult> {
  private readonly logger = new Logger(SupplierSyncProcessor.name);

  constructor(
    private readonly sync: SupplierSync,
    private readonly runs: JobRunsService,
    private readonly db: DbService,
  ) {}

  /**
   * Handles one job.
   *
   * @param job a `supplier_sync`, `price_sync` or `balance_check` job
   * @returns the sync's outcome, or how many suppliers a scheduled run went through
   */
  async process(
    job: Job<object, SyncOutcome | ScheduledSyncResult, string>,
  ): Promise<SyncOutcome | ScheduledSyncResult> {
    if (job.name === SUPPLIER_SYNC_JOB) {
      const data = job.data as SupplierSyncJobData;
      return this.sync.run(data.supplierId, { audit: data.trigger === 'schedule' });
    }
    const runId = (job.data as ScheduledSyncData).runId;
    const name = job.name === BALANCE_CHECK_JOB ? BALANCE_CHECK_JOB : PRICE_SYNC_JOB;
    const options =
      runId === undefined
        ? ({ job: name, trigger: 'schedule' } as const)
        : ({ job: name, trigger: 'manual', runId } as const);
    let result: ScheduledSyncResult = { suppliers: 0, succeeded: 0, failed: 0 };
    await this.runs.run(options, async () => {
      const rows = await suppliersToSync(this.db.db);
      let succeeded = 0;
      let failed = 0;
      for (const supplier of rows) {
        try {
          const done =
            name === BALANCE_CHECK_JOB
              ? await this.sync.checkBalance(supplier.id)
              : (await this.sync.run(supplier.id, { audit: true })).ok;
          if (done) succeeded += 1;
          else failed += 1;
        } catch (error) {
          failed += 1;
          this.logger.warn(
            `${name} of supplier ${supplier.id} failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      result = { suppliers: succeeded + failed, succeeded, failed };
      return { processed: succeeded, result: { ...result } };
    });
    return result;
  }
}
