// Nest module of the nightly IMEI retention job (risk module). Import it in the worker process only (src/worker.module.ts).
import { Module, type OnModuleInit } from '@nestjs/common';
import { JobSchedulerRegistry } from '../../../infra/queues';
import { JobRunsModule } from '../../health';
import { SettingsModule } from '../../platform';
import { DataRetentionProcessor, DATA_RETENTION_JOB } from './imei-retention.processor';
import { ImeiRetention } from './imei-retention';

/**
 * The id of the scheduler that ticks the retention run every night.
 *
 * Why: renaming a scheduler creates a second one in Redis, so the id is a constant that docs and tests share.
 */
export const DATA_RETENTION_SCHEDULER = 'data-retention';

/**
 * Provides the retention run, its processor, and registers its nightly schedule (03:00 UTC).
 *
 * Why: the API never deletes in bulk (decision 020); the worker does. The schedule is a BullMQ job scheduler, created on every worker
 * boot (idempotent).
 */
@Module({
  imports: [JobRunsModule, SettingsModule],
  providers: [ImeiRetention, DataRetentionProcessor],
  exports: [ImeiRetention],
})
export class DataRetentionModule implements OnModuleInit {
  constructor(private readonly schedulers: JobSchedulerRegistry) {}

  /** Registers the schedule; the worker creates it in Redis when it starts. */
  onModuleInit(): void {
    this.schedulers.register({
      id: DATA_RETENTION_SCHEDULER,
      queue: 'maintenance',
      jobName: DATA_RETENTION_JOB,
      pattern: '0 3 * * *',
      description: 'Erases the IMEI of IMEI checks older than the retention period (imeiRetentionDays).',
    });
  }
}
