// Nest module of the follow pass (catalog module, plan 31 section 6.4). Import it in the worker process only (src/worker.module.ts).
import { Module, type OnModuleInit } from '@nestjs/common';
import { JobSchedulerRegistry } from '../../../infra/queues';
import { JobRunsModule } from '../../health';
import { AuditService, NotificationDeliveryModule } from '../../platform';
import { RetailFollowSteps } from '../application/retail-follow-steps';
import { RETAIL_FOLLOW_JOB } from '../application/retail-follow-scheduler';
import { RetailPriceFollow } from '../application/retail-price-follow';
import { CatalogModule } from '../catalog.module';
import { CatalogPricesModule } from '../catalog-prices.module';
import { RetailPriceFollowProcessor } from './retail-price-follow.processor';

/**
 * The id of the scheduler that runs the pass every hour.
 *
 * Why: renaming a scheduler creates a second one in Redis, so the id is a constant that docs and tests share.
 */
export const RETAIL_FOLLOW_SCHEDULER = 'retail_price_follow_hourly';

/**
 * Provides the follow pass, its processor, and registers the hourly schedule.
 *
 * Why: the API only asks for a pass (`RetailFollowScheduler`, a delayed job added when the price version moves); the worker runs it
 * (decision 020). The hourly run catches what no bump announces: a B2B rule window that opens or closes moves a floor with no write.
 */
@Module({
  imports: [CatalogModule, CatalogPricesModule, JobRunsModule, NotificationDeliveryModule],
  // The worker has no global audit module: the module provides the writer itself, as every worker module does.
  providers: [AuditService, RetailFollowSteps, RetailPriceFollow, RetailPriceFollowProcessor],
  exports: [RetailPriceFollow],
})
export class RetailPriceFollowModule implements OnModuleInit {
  constructor(private readonly schedulers: JobSchedulerRegistry) {}

  /** Registers the schedule; the worker creates it in Redis when it starts. */
  onModuleInit(): void {
    this.schedulers.register({
      id: RETAIL_FOLLOW_SCHEDULER,
      queue: 'maintenance',
      jobName: RETAIL_FOLLOW_JOB,
      pattern: '10 * * * *',
      description:
        'Moves the following retail prices to what their rules give now, and tells staff at most once an hour.',
    });
  }
}
