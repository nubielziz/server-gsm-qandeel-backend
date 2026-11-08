// The worker job that refreshes the exchange rates every hour (money module, queue maintenance, job fx_refresh, decision 029).
import { Injectable } from '@nestjs/common';
import type { Job } from 'bullmq';
import { type JobProcessor, QueueProcessor } from '../../../infra/queues';
import { JobRunsService } from '../../health';
import { FxRefreshService } from '../application/fx-refresh.service';

/**
 * The job name of the hourly refresh.
 *
 * Why: the processor, the scheduler and `docs/queues.md` must agree on it; it is also the name in the console's jobs list.
 */
export const FX_REFRESH_JOB = 'fx_refresh';

/** The job data: empty for the schedule; a manual run (the health feature) carries the `job_runs` row it inserted. */
export interface FxRefreshJobData {
  readonly runId?: number;
}

/** What the job reports. */
export interface FxRefreshJobResult {
  /** True when no provider is configured (`manual`, or `openexchangerates` without a key): nothing was asked or changed (the run is still `succeeded`). */
  readonly skipped: boolean;
  /** How many currencies got a new rate. */
  readonly refreshed: number;
  /** How many currencies the provider did not offer or sent an unusable rate for. */
  readonly failed: number;
}

/**
 * Refreshes the exchange rates when the hourly tick arrives.
 *
 * Why: decision 029. It runs the same refresh as `POST /admin/currencies/refresh-fx` (`FxRefreshService`), so the rules and the
 * audit row are the same; with no request behind it the audit actor is the system. With no provider configured it ends quietly
 * (nothing asked, nothing changed, no retry): that is a choice of the shop, not a failure, so the run is recorded as `succeeded` with the
 * reason in `result` (a `skipped` run shows a warning in the console, and this one would show it every hour). With a provider but no
 * active non-base currency it also ends without a call and without an audit row (nothing was refreshed, so nothing is logged every
 * hour). A provider that is configured but cannot answer fails the run (recorded as failed, retried by the queue's policy; the next
 * hour's tick is the real retry), and the old rates stay in place.
 */
@Injectable()
@QueueProcessor('maintenance', FX_REFRESH_JOB)
export class FxRefreshProcessor implements JobProcessor<FxRefreshJobData, FxRefreshJobResult> {
  constructor(
    private readonly fx: FxRefreshService,
    private readonly runs: JobRunsService,
  ) {}

  /**
   * Handles one tick (or one manual run).
   *
   * @param job the BullMQ job; `data.runId` names the `job_runs` row of a manual run
   * @returns what the refresh did
   * @throws {AppError} `FX_PROVIDER_DOWN` when a configured provider gave no usable rate (the run is recorded as failed)
   */
  async process(job: Job<FxRefreshJobData, FxRefreshJobResult, string>): Promise<FxRefreshJobResult> {
    let outcome: FxRefreshJobResult = { skipped: true, refreshed: 0, failed: 0 };
    const runId = job.data.runId;
    const options =
      runId === undefined
        ? ({ job: FX_REFRESH_JOB, trigger: 'schedule' } as const)
        : ({ job: FX_REFRESH_JOB, trigger: 'manual', runId } as const);
    await this.runs.run(options, async () => {
      if (!this.fx.configured) return { processed: 0, result: { reason: 'no provider configured' } };
      const done = await this.fx.refresh({ auditEmpty: false });
      outcome = { skipped: false, refreshed: done.refreshed.length, failed: done.failed.length };
      return {
        processed: outcome.refreshed,
        result: { source: done.source, refreshed: outcome.refreshed, failed: outcome.failed },
      };
    });
    return outcome;
  }
}
