// Nest module of the storefront popularity job (storefront module). Import it in the worker process only (src/worker.module.ts).
import { Module, type OnModuleInit } from '@nestjs/common';
import { JobSchedulerRegistry } from '../../../infra/queues';
import { JobRunsModule } from '../../health';
import { PopularityRefresh } from './popularity';
import { PopularityProcessor, STOREFRONT_POPULARITY_JOB } from './popularity.processor';

/**
 * The id of the scheduler that ticks the popularity refresh every 30 minutes.
 *
 * Why: renaming a scheduler creates a second one in Redis, so the id is a constant that docs and tests share.
 */
export const STOREFRONT_POPULARITY_SCHEDULER = 'storefront-popularity';

/**
 * Provides the refresh and its processor, and registers the schedule.
 *
 * Why: feature 22. The API never does slow work inline (decision 020); the worker refreshes the counts. The schedule is a BullMQ job
 * scheduler, created on every worker boot (idempotent). Only the worker loads this module.
 */
@Module({
  imports: [JobRunsModule],
  providers: [PopularityRefresh, PopularityProcessor],
  exports: [PopularityRefresh],
})
export class StorefrontPopularityModule implements OnModuleInit {
  constructor(private readonly schedulers: JobSchedulerRegistry) {}

  /** Registers the schedule; the worker creates it in Redis when it starts. */
  onModuleInit(): void {
    this.schedulers.register({
      id: STOREFRONT_POPULARITY_SCHEDULER,
      queue: 'maintenance',
      jobName: STOREFRONT_POPULARITY_JOB,
      pattern: '*/30 * * * *',
      description:
        'Refreshes service_listings.sales_30d (non-rejected orders of the last 30 days per service) for the storefront best-seller sort.',
    });
  }
}
