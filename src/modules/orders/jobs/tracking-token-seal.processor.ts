// The worker job that seals the tracking tokens stored as issued (orders module, queue maintenance, job tracking_tokens_seal; decision 054).
import { Injectable } from '@nestjs/common';
import { type JobProcessor, QueueProcessor } from '../../../infra/queues';
import { type JobRun, JobRunsService } from '../../health';
import type { OutboxJobData } from '../../platform';
import { TRACKING_TOKENS_SEAL_JOB, TrackingTokenSeal } from '../application/tracking-token-seal';

/**
 * Runs the pass migration `capability_tokens_seal` asks for.
 *
 * Why: decision 054: the keyed hash and the encrypted copy need the application's keys, which a SQL migration does not have, so the
 * migration only writes the outbox event and the worker does the work. The pass is idempotent: a second delivery or a retry seals only
 * what is left. The job id is the outbox row's (`outbox-<id>`). Recorded in `job_runs` (trigger `event`); 3 attempts with the queue's
 * backoff.
 *
 * Side effects: one `job_runs` row; the writes of {@link TrackingTokenSeal}.
 *
 * @see docs/queues.md (maintenance)
 */
@Injectable()
@QueueProcessor('maintenance', TRACKING_TOKENS_SEAL_JOB)
export class TrackingTokenSealProcessor implements JobProcessor<OutboxJobData, JobRun> {
  constructor(
    private readonly seal: TrackingTokenSeal,
    private readonly runs: JobRunsService,
  ) {}

  /**
   * Handles the job.
   *
   * @returns the recorded run
   */
  process(): Promise<JobRun> {
    return this.runs.run({ job: TRACKING_TOKENS_SEAL_JOB, trigger: 'event' }, async () => {
      const outcome = await this.seal.run();
      return { processed: outcome.sealed, result: { sealed: outcome.sealed, unchanged: outcome.unchanged } };
    });
  }
}
