// Public API of the health module. The indicator registry itself lives in src/infra/health (decision 016 boundaries).
// Job runs (job_runs) are exported for the processors of other modules; the worker's root module imports JobRunsModule.
// Order matters (decision 032): the job-run exports come first, ahead of the modules that import orders and suppliers, because
// identity, suppliers and money import `JobRunsService` through this file and need it initialised.
export { JobRunsModule } from './job-runs/job-runs.module';
export { JobRunsService } from './job-runs/job-runs.service';
export type { JobRunReport, RunJobOptions, RunOverlap, StartJobRunInput } from './job-runs/job-runs.service';
export type { JobRunOutcome } from './job-runs/job-runs.repository';
export type { JobRun, JobStatus, JobTrigger } from './db/schema';
export { HealthModule } from './health.module';
export type { HealthReport } from './application/health.service';
export { HealthJobsModule } from './jobs/health-jobs.module';
export {
  DB_SIZE_SAMPLE_JOB,
  DbSizeSampleProcessor,
  JOB_RUNS_REAPER_JOB,
  JobRunsReaperProcessor,
  RETENTION_DAYS,
  SERVICE_CHECKS_JOB,
  SERVICE_CHECKS_PURGE_JOB,
  STUCK_RUN_MS,
  ServiceChecksProcessor,
  ServiceChecksPurgeProcessor,
} from './jobs/health-processors';
export { ComponentChecker } from './application/component-checker';
export type { CheckerReport } from './application/component-checker';
export { HealthAdminModule } from './health-admin.module';
export { WebhookIntakeCounter } from './application/webhook-intake.counter';
export type { IntakeOutcome } from './application/webhook-intake.counter';
export { MAIL_PROBE } from './application/component-checker';
export type { HealthProbe, ProbeResult } from './application/component-checker';
export { ALERT_EVALUATION_JOB } from './infra/alerts-read.repository';
export { CORE_COMPONENTS, TIME_RANGES } from './domain/checks';
export type { CoreComponent, TimeRange } from './domain/checks';
export { SPEC as METRIC_SPECS, measure, stateOf, worst } from './domain/measure';
export type { Measure, MeasureSpec, MeasureUnit, MetricState } from './domain/measure';
export { OLDEST_WAITING_GAUGE } from './application/queue-admin.service';
export { PrometheusClient } from './application/prometheus.client';
export type { PromMatrix, PromVector } from './application/prometheus.client';
export { AlertEvaluator } from './application/alert-evaluator';
export type { EvaluationReport } from './application/alert-evaluator';
export { AlertNotifier, NotificationAlertNotifier } from './application/alert-notifier';
export type { AlertNotice } from './application/alert-notifier';
export { LedgerIntegrityCheck } from './application/ledger-integrity-check';
export { INTEGRITY_JOB } from './domain/integrity';
export { METRICS, METRIC_KEYS } from './domain/metric-registry';
export type { MetricKey } from './domain/metric-registry';
export { AlertEvaluationProcessor, LedgerIntegrityProcessor } from './jobs/alerts-processors';
