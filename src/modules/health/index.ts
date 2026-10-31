// Public API of the health module. The indicator registry itself lives in src/infra/health (decision 016 boundaries).
// Job runs (job_runs) are exported for the processors of other modules; the worker's root module imports JobRunsModule.
export { HealthModule } from './health.module';
export type { HealthReport } from './application/health.service';
export { JobRunsModule } from './job-runs/job-runs.module';
export { JobRunsService } from './job-runs/job-runs.service';
export type { JobRunReport, RunJobOptions, RunOverlap, StartJobRunInput } from './job-runs/job-runs.service';
export type { JobRunOutcome } from './job-runs/job-runs.repository';
export type { JobRun, JobStatus, JobTrigger } from './db/schema';
