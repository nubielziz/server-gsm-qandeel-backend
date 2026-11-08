// Nest module of the health jobs (worker process only, src/worker.module.ts): the processors and their schedules.
import { Module, type OnModuleInit } from '@nestjs/common';
import { HealthRegistryModule } from '../../../infra/health';
import { JobSchedulerRegistry } from '../../../infra/queues';
import { AlertNotifierModule } from '../alert-notifier.module';
import { AlertEvaluator } from '../application/alert-evaluator';
import { AlertMetricReader } from '../application/alert-metrics';
import { ComponentChecker } from '../application/component-checker';
import { LedgerIntegrityCheck } from '../application/ledger-integrity-check';
import { PrometheusClient } from '../application/prometheus.client';
import { INTEGRITY_JOB } from '../domain/integrity';
import { ALERT_EVALUATION_JOB } from '../infra/alerts-read.repository';
import { JobRunsModule } from '../job-runs/job-runs.module';
import { AlertEvaluationProcessor, LedgerIntegrityProcessor } from './alerts-processors';
import {
  DB_SIZE_SAMPLE_JOB,
  DbSizeSampleProcessor,
  JOB_RUNS_REAPER_JOB,
  JobRunsReaperProcessor,
  SERVICE_CHECKS_JOB,
  SERVICE_CHECKS_PURGE_JOB,
  ServiceChecksProcessor,
  ServiceChecksPurgeProcessor,
} from './health-processors';

/**
 * Provides the checker, the alert evaluator, the integrity check, the processors of the health jobs, and registers their schedules.
 *
 * Why: the API never does slow work inline (decision 020): the worker checks every component once a minute, evaluates the alert rules every
 * minute, checks the ledger integrity at 02:30 UTC, purges old rows at 03:30 UTC, reaps stuck runs every 5 minutes and samples the database
 * size at 03:45 UTC. Schedulers are created on every worker boot (idempotent).
 *
 * The integrity check compares the accounts with money's `compareLedgerBalances`, a plain function it loads late (money imports this module's job runs,
 * so a static import of its index would meet it half-initialised, decision 032); no money provider is built here. The alert messages go through the
 * notification feature: the notifier of {@link AlertNotifierModule} writes them in the alert's transaction.
 */
@Module({
  imports: [JobRunsModule, HealthRegistryModule, AlertNotifierModule],
  providers: [
    ComponentChecker,
    ServiceChecksProcessor,
    ServiceChecksPurgeProcessor,
    JobRunsReaperProcessor,
    DbSizeSampleProcessor,
    PrometheusClient,
    AlertMetricReader,
    AlertEvaluator,
    LedgerIntegrityCheck,
    AlertEvaluationProcessor,
    LedgerIntegrityProcessor,
  ],
})
export class HealthJobsModule implements OnModuleInit {
  constructor(private readonly schedulers: JobSchedulerRegistry) {}

  /** Registers the schedules; the worker creates them in Redis when it starts. */
  onModuleInit(): void {
    this.schedulers.register({
      id: 'service-checks',
      queue: 'maintenance',
      jobName: SERVICE_CHECKS_JOB,
      every: 60_000,
      description: 'Checks the core components and every active supplier and records the results (service_checks).',
      jobOptions: { removeOnComplete: { age: 3_600 } },
    });
    this.schedulers.register({
      id: 'service-checks-purge',
      queue: 'maintenance',
      jobName: SERVICE_CHECKS_PURGE_JOB,
      pattern: '30 3 * * *',
      description: 'Deletes health checks and finished job runs older than 90 days.',
    });
    this.schedulers.register({
      id: 'job-runs-reaper',
      queue: 'maintenance',
      jobName: JOB_RUNS_REAPER_JOB,
      every: 5 * 60_000,
      description: 'Closes job runs that were left running by a worker that died.',
      jobOptions: { removeOnComplete: { age: 3_600 } },
    });
    this.schedulers.register({
      id: 'alert-evaluation',
      queue: 'alerts',
      jobName: ALERT_EVALUATION_JOB,
      every: 60_000,
      description: 'Compares every active alert rule with its metric and opens or closes alerts (alert_events).',
      jobOptions: { removeOnComplete: { age: 3_600 } },
    });
    this.schedulers.register({
      id: 'ledger-integrity',
      queue: 'maintenance',
      jobName: INTEGRITY_JOB,
      pattern: '30 2 * * *',
      description:
        'Checks that every entry sums to zero, every account matches its lines, no hold is stuck and every payment has an entry.',
    });
    this.schedulers.register({
      id: 'db-size-sample',
      queue: 'maintenance',
      jobName: DB_SIZE_SAMPLE_JOB,
      pattern: '45 3 * * *',
      description: 'Samples the database size for the growth per day.',
    });
  }
}
