// The port through which platform jobs record their runs in `job_runs` (feature 23, plan section 8.5, S8). Health owns the table and
// imports platform, so platform cannot import health: health provides this token (`job-runs.module.ts`), platform resolves it lazily.

/**
 * The Nest token of the {@link JobRunRecorder}; `JobRunsModule` (health) provides it with `JobRunsService`.
 *
 * Why: decision 032: platform imports no module; the precedent is `REFERENCE_DOCS_GUARD`, which identity provides for platform.
 */
export const JOB_RUN_RECORDER = Symbol.for('gsm.JOB_RUN_RECORDER');

/**
 * Records one run of a scheduled or manual job: the shape of `JobRunsService.run`.
 *
 * Why: every scheduled run writes `job_runs` (CLAUDE.md, workers), so the console's jobs list shows the platform's jobs too; a manual
 * run (`POST /admin/system/jobs/:name/run`) passes the `runId` the route inserted, so no `running` row is left behind.
 */
export interface JobRunRecorder {
  /**
   * Runs the work and records it.
   *
   * @param options the job name, the trigger and, for a manual run, the existing run id
   * @param work the job's work; its report becomes the run's `processed` and `result`
   * @returns the recorded run
   * @throws whatever `work` threw, after the run was recorded as failed
   */
  run(
    options: { readonly job: string; readonly trigger: 'schedule' | 'manual'; readonly runId?: number },
    work: () => Promise<{
      readonly processed?: number;
      readonly result?: Record<string, unknown>;
      readonly skipped?: boolean;
    } | void>,
  ): Promise<unknown>;
}
