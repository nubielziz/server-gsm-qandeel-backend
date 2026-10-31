// The worker job that writes the IP rule hit counters to Postgres (identity module, queue maintenance, job ip_rule_hits_flush).
import { Injectable } from '@nestjs/common';
import { type JobProcessor, QueueProcessor } from '../../../../infra/queues';
import { type FlushResult, IpRuleHitsFlush } from './ip-rule-hits-flush';

/**
 * The job name of the per-minute flush.
 *
 * Why: the processor, the scheduler and `docs/queues.md` must agree on it.
 */
export const IP_RULE_HITS_FLUSH_JOB = 'ip_rule_hits_flush';

/**
 * Flushes the IP rule hit counters when the per-minute tick arrives.
 *
 * Why: the console shows `hitCount` and `lastHitAt` per IP rule; the hook counts in Redis and this job moves the counts to
 * `ip_rules` (decision 020: high-frequency housekeeping, so it does not write `job_runs`; its health is in the
 * `ip_rule_hits_flush_*` metrics). The job is safe to run twice or in parallel: the counters are taken and deleted in one
 * Redis step, so a second run finds nothing. A failed write puts the counts back and fails the job; the next tick retries.
 */
@Injectable()
@QueueProcessor('maintenance', IP_RULE_HITS_FLUSH_JOB)
export class IpRuleHitsFlushProcessor implements JobProcessor<object, FlushResult> {
  constructor(private readonly hits: IpRuleHitsFlush) {}

  /**
   * Handles one tick.
   *
   * @returns how many rules and hits were written
   */
  process(): Promise<FlushResult> {
    return this.hits.flush();
  }
}
