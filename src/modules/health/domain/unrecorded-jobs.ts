// Which scheduled jobs write no `job_runs` row, so the System health jobs list and the manual run leave them out. Pure.

/**
 * The scheduled jobs that never write `job_runs` (decision 020: high-frequency housekeeping, healthy or not they show in the metrics
 * and the queue counters instead).
 *
 * Why: the Jobs tab lists a job from its BullMQ scheduler and judges it from its `job_runs`. For these jobs there are no runs, so
 * they would sit at `unknown` for ever, and a manual run would insert a `running` row that no processor ever closes (the processors
 * ignore `data.runId`): the job would answer `409 JOB_ALREADY_RUNNING` for two hours, until the reaper marks the row failed and the
 * tab shows it critical. Keeping them out of the list and answering 404 to a run of one prevents both.
 *
 * Names are the BullMQ job names of the schedulers: the outbox relay `tick` (every second), `ip_rule_hits_flush` (every minute) and
 * `supplier_poll_tick` (every minute). A new scheduler whose processor does not use `JobRunsService.run` is added here.
 */
export const UNRECORDED_JOBS: ReadonlySet<string> = new Set(['tick', 'ip_rule_hits_flush', 'supplier_poll_tick']);

/**
 * Tells whether a scheduled job records its runs in `job_runs`.
 *
 * @param name the scheduler's job name
 * @returns false for the housekeeping jobs of {@link UNRECORDED_JOBS}, true for every other job
 */
export function isRecordedJob(name: string): boolean {
  return !UNRECORDED_JOBS.has(name);
}
