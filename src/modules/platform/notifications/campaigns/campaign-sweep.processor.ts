// The worker processor of `notification_campaign_sweep` on the `maintenance` queue (feature 23, plan section 8.3): the minute tick, or a
// manual run from the console's jobs page.
import { Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { Job } from 'bullmq';
import { type JobProcessor, QueueProcessor } from '../../../../infra/queues';
import { JOB_RUN_RECORDER, type JobRunRecorder } from '../../jobs/job-run-recorder';
import { type SweepResult, CampaignSweep } from './campaign-sweep';

/** The job name of the sweep (also its name in the console's jobs list). */
export const CAMPAIGN_SWEEP_JOB = 'notification_campaign_sweep';

/** The job data: empty for the schedule; a manual run carries the `job_runs` row it inserted. */
export interface CampaignSweepData {
  readonly runId?: number;
}

const NOTHING: SweepResult = { queued: 0, rekicked: 0, failed: 0 };

/**
 * Runs the campaign sweep.
 *
 * Why: a tick with nothing to do writes no `job_runs` row (a run every minute would bury the jobs list, the rule of the checkout
 * recovery sweep); a tick that does something, and every manual run, is recorded through the {@link JOB_RUN_RECORDER} port (S8).
 */
@Injectable()
@QueueProcessor('maintenance', CAMPAIGN_SWEEP_JOB)
export class CampaignSweepProcessor implements JobProcessor<CampaignSweepData, SweepResult> {
  constructor(
    private readonly sweep: CampaignSweep,
    private readonly moduleRef: ModuleRef,
  ) {}

  /**
   * Handles one tick (or one manual run).
   *
   * @param job the BullMQ job; `data.runId` names the `job_runs` row of a manual run
   * @returns what the tick did
   */
  async process(job: Job<CampaignSweepData, SweepResult, string>): Promise<SweepResult> {
    const runId = job.data.runId;
    if (runId === undefined && !(await this.sweep.hasWork())) return NOTHING;
    const recorder = this.recorder();
    if (!recorder) return this.sweep.run();
    let result = NOTHING;
    await recorder.run(
      runId === undefined
        ? { job: CAMPAIGN_SWEEP_JOB, trigger: 'schedule' }
        : { job: CAMPAIGN_SWEEP_JOB, trigger: 'manual', runId },
      async () => {
        result = await this.sweep.run();
        return { processed: result.queued, result: { ...result } };
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
