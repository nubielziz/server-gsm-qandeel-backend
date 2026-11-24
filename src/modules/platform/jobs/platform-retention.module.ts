// Nest module of the platform's daily clean-up job (decision 053): the upload janitor. Worker process only.
import { Module, type OnModuleInit } from '@nestjs/common';
import { JobSchedulerRegistry } from '../../../infra/queues';
import { StoredFiles } from '../files/stored-files';
import { UploadJanitor } from '../files/upload-janitor';
import { UPLOAD_JANITOR_JOB, UploadJanitorProcessor } from '../files/upload-janitor.processor';

/** The id of the scheduler of the upload janitor (04:30 UTC). */
export const UPLOAD_JANITOR_SCHEDULER = 'upload-janitor';

/**
 * Provides the processor of `upload_janitor` and registers its daily schedule on `maintenance`.
 *
 * Why: decision 053. Files nothing uses are deleted after 7 days, so the table does not grow without bound. The API never runs it; only
 * the worker's runner creates the schedule in Redis. Import it in the worker process only (`src/worker.module.ts`). The schedule of the
 * retired delivery log's retention is listed as retired, so the worker removes it from Redis at boot.
 */
@Module({
  providers: [StoredFiles, UploadJanitor, UploadJanitorProcessor],
})
export class PlatformRetentionModule implements OnModuleInit {
  constructor(private readonly schedulers: JobSchedulerRegistry) {}

  /** Registers the schedules; the worker creates them in Redis when it starts. */
  onModuleInit(): void {
    this.schedulers.register({
      id: UPLOAD_JANITOR_SCHEDULER,
      queue: 'maintenance',
      jobName: UPLOAD_JANITOR_JOB,
      pattern: '30 4 * * *',
      description: 'Deletes uploaded and stored files that nothing has used for 7 days.',
    });
    // The daily retention of the retired merchant webhook deliveries (04:40 UTC): the worker removes its scheduler from Redis at boot.
    this.schedulers.retire('maintenance', 'webhook-delivery-retention');
  }
}
