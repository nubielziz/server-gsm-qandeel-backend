// The worker job that sweeps the supplier sends (suppliers module, queue maintenance, job dispatch_sweep, decision 044).
import { Injectable } from '@nestjs/common';
import type { Job } from 'bullmq';
import { type JobProcessor, QueueProcessor } from '../../../infra/queues';
import { JobRunsService } from '../../health';
import { DispatchSweep, type DispatchSweepResult, EMPTY_SWEEP } from '../application/dispatch-sweep';

/**
 * The job name of the dispatch sweep.
 *
 * Why: the processor, the scheduler and `docs/queues.md` must agree on it; it is also the name in the console's jobs list.
 */
export const DISPATCH_SWEEP_JOB = 'dispatch_sweep';

/** The job data: empty for the schedule; a manual run (the health feature) carries the `job_runs` row it inserted. */
export interface DispatchSweepData {
  readonly runId?: number;
}

/**
 * Runs the dispatch sweep when the minute tick arrives.
 *
 * Why: decision 044. A tick with nothing to move writes no `job_runs` row (a job every minute would bury the jobs list in empty runs: the
 * `payment_auto_credit` pattern); a tick that moves orders, and every manual run, is recorded with its counts (decision 020).
 */
@Injectable()
@QueueProcessor('maintenance', DISPATCH_SWEEP_JOB)
export class DispatchSweepProcessor implements JobProcessor<DispatchSweepData, DispatchSweepResult> {
  constructor(
    private readonly sweep: DispatchSweep,
    private readonly runs: JobRunsService,
  ) {}

  /**
   * Handles one tick (or one manual run).
   *
   * @param job the BullMQ job; `data.runId` names the `job_runs` row of a manual run
   * @returns what the sweep moved
   */
  async process(job: Pick<Job<DispatchSweepData, DispatchSweepResult, string>, 'data'>): Promise<DispatchSweepResult> {
    const runId = job.data.runId;
    const plan = await this.sweep.plan();
    if (plan.items.length === 0 && runId === undefined) return { ...EMPTY_SWEEP, unknown: plan.unknown };
    let result: DispatchSweepResult = EMPTY_SWEEP;
    const options =
      runId === undefined
        ? ({ job: DISPATCH_SWEEP_JOB, trigger: 'schedule' } as const)
        : ({ job: DISPATCH_SWEEP_JOB, trigger: 'manual', runId } as const);
    await this.runs.run(options, async () => {
      result = await this.sweep.apply(plan);
      return {
        processed: result.unanswered + result.requeued + result.stopped,
        result: { ...result },
      };
    });
    return result;
  }
}
