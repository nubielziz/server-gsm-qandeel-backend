// Nest module of the platform's daily clean-up jobs (decision 053): the upload janitor and the webhook delivery retention. Worker process only.
import { Module, type OnModuleInit } from '@nestjs/common';
import { JobSchedulerRegistry } from '../../../infra/queues';
import { StoredFiles } from '../files/stored-files';
import { UploadJanitor } from '../files/upload-janitor';
import { UPLOAD_JANITOR_JOB, UploadJanitorProcessor } from '../files/upload-janitor.processor';
import { WebhookDeliveryRetention } from '../webhooks/webhook-delivery-retention';
import {
  WEBHOOK_DELIVERY_RETENTION_JOB,
  WebhookDeliveryRetentionProcessor,
} from '../webhooks/webhook-delivery-retention.processor';

/** The id of the scheduler of the upload janitor (04:30 UTC). */
export const UPLOAD_JANITOR_SCHEDULER = 'upload-janitor';
/** The id of the scheduler of the webhook delivery retention (04:40 UTC). */
export const WEBHOOK_DELIVERY_RETENTION_SCHEDULER = 'webhook-delivery-retention';

/**
 * Provides the processors of `upload_janitor` and `webhook_delivery_retention` and registers their daily schedules on `maintenance`.
 *
 * Why: decision 053. Files nothing uses are deleted after 7 days and webhook deliveries after 90, so neither table grows without bound.
 * The API never runs them; only the worker's runner creates the schedules in Redis. Import it in the worker process only
 * (`src/worker.module.ts`).
 */
@Module({
  providers: [
    StoredFiles,
    UploadJanitor,
    UploadJanitorProcessor,
    WebhookDeliveryRetention,
    WebhookDeliveryRetentionProcessor,
  ],
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
    this.schedulers.register({
      id: WEBHOOK_DELIVERY_RETENTION_SCHEDULER,
      queue: 'maintenance',
      jobName: WEBHOOK_DELIVERY_RETENTION_JOB,
      pattern: '40 4 * * *',
      description: 'Deletes merchant webhook deliveries older than 90 days.',
    });
  }
}
