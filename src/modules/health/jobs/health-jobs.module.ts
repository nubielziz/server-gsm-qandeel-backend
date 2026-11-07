// Nest module of the health jobs (worker process only, src/worker.module.ts): the processors and their schedules.
import { Module, type OnModuleInit } from '@nestjs/common';
import { HealthRegistryModule } from '../../../infra/health';
import { JobSchedulerRegistry } from '../../../infra/queues';
import { ComponentChecker } from '../application/component-checker';
import { JobRunsModule } from '../job-runs/job-runs.module';
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
 * Provides the checker, the processors of the health jobs, and registers their schedules.
 *
 * Why: the API never does slow work inline (decision 020): the worker checks every component once a minute, purges old rows at
 * 03:30 UTC, reaps stuck runs every 5 minutes and samples the database size at 03:45 UTC. Schedulers are created on every worker
 * boot (idempotent).
 */
@Module({
  imports: [JobRunsModule, HealthRegistryModule],
  providers: [
    ComponentChecker,
    ServiceChecksProcessor,
    ServiceChecksPurgeProcessor,
    JobRunsReaperProcessor,
    DbSizeSampleProcessor,
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
      id: 'db-size-sample',
      queue: 'maintenance',
      jobName: DB_SIZE_SAMPLE_JOB,
      pattern: '45 3 * * *',
      description: 'Samples the database size for the growth per day.',
    });
  }
}
