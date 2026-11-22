// The worker processor of `lost_work_reconcile` on the `maintenance` queue (platform module, decision 055): every 5 minutes, or a
// manual run from the console's jobs page.
import { Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { Job } from 'bullmq';
import { type JobProcessor, QueueProcessor } from '../../../infra/queues';
import { JOB_RUN_RECORDER, type JobRunRecorder } from '../jobs/job-run-recorder';
import { type LostWorkPlans, type LostWorkResult, LostWorkReconcile, hasWork } from './lost-work-reconcile';

/**
 * The job name of the lost-work reconcile (also its name in the console's jobs list).
 *
 * Why: the processor, the scheduler and `docs/queues.md` must agree on it.
 */
export const LOST_WORK_RECONCILE_JOB = 'lost_work_reconcile';

/** The job data: empty for the schedule; a manual run carries the `job_runs` row it inserted. */
export interface LostWorkReconcileData {
  readonly runId?: number;
}

/** The result of a run that wrote nothing: zeros, and the rows whose jobs could not be read. */
function nothingDone(plans: LostWorkPlans): LostWorkResult {
  let unknown = 0;
  const passes: Record<
    string,
    { checked: number; unknown: number; exhausted: number; requested: number; gaveUp: number }
  > = {};
  for (const [kind, plan] of plans.plans) {
    passes[kind] = { checked: plan.checked, unknown: plan.unknown, exhausted: plan.exhausted, requested: 0, gaveUp: 0 };
    unknown += plan.unknown;
  }
  return { passes, requested: 0, gaveUp: 0, unknown };
}

/**
 * Runs the lost-work reconcile.
 *
 * Why: decision 055. A scheduled run that has nothing to ask for writes no `job_runs` row (a run every 5 minutes would bury the jobs
 * list, the rule of the dispatch sweep); a run that asked again, gave up or failed, and every manual run, is recorded through the
 * {@link JOB_RUN_RECORDER} port (platform cannot import health): `processed` = requests + give-ups, `result` = the five counts per kind
 * and `unknown`.
 */
@Injectable()
@QueueProcessor('maintenance', LOST_WORK_RECONCILE_JOB)
export class LostWorkReconcileProcessor implements JobProcessor<LostWorkReconcileData, LostWorkResult> {
  constructor(
    private readonly reconcile: LostWorkReconcile,
    private readonly moduleRef: ModuleRef,
  ) {}

  /**
   * Handles one run.
   *
   * @param job the BullMQ job; `data.runId` names the `job_runs` row of a manual run
   * @returns what the run did
   * @throws {Error} when a pass failed (the run is recorded as failed first)
   */
  async process(job: Pick<Job<LostWorkReconcileData, LostWorkResult, string>, 'data'>): Promise<LostWorkResult> {
    const runId = job.data.runId;
    const plans = await this.reconcile.plan();
    if (runId === undefined && !hasWork(plans)) return nothingDone(plans);
    const recorder = this.recorder();
    if (!recorder) return this.reconcile.apply(plans);
    let result = nothingDone(plans);
    await recorder.run(
      runId === undefined
        ? { job: LOST_WORK_RECONCILE_JOB, trigger: 'schedule' }
        : { job: LOST_WORK_RECONCILE_JOB, trigger: 'manual', runId },
      async () => {
        result = await this.reconcile.apply(plans);
        return { processed: result.requested + result.gaveUp, result: { ...result.passes, unknown: result.unknown } };
      },
    );
    return result;
  }

  /** The health module's recorder, when this process loaded it (the worker always does). */
  private recorder(): JobRunRecorder | undefined {
    try {
      return this.moduleRef.get<JobRunRecorder>(JOB_RUN_RECORDER, { strict: false });
    } catch {
      return undefined;
    }
  }
}
