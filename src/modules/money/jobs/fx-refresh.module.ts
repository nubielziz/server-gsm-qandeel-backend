// Nest module of the hourly exchange-rate refresh job (money module). Import it in the worker process only (src/worker.module.ts).
import { Module, type OnModuleInit } from '@nestjs/common';
import { JobSchedulerRegistry } from '../../../infra/queues';
import { JobRunsModule } from '../../health';
import { AuditService } from '../../platform';
import { FxRefreshService } from '../application/fx-refresh.service';
import { FX_PROVIDER_FACTORY } from '../infra/fx-provider.factory';
import { FX_REFRESH_JOB, FxRefreshProcessor } from './fx-refresh.processor';

/**
 * The id of the scheduler that ticks the refresh every hour.
 *
 * Why: renaming a scheduler creates a second one in Redis, so the id is a constant that docs and tests share.
 */
export const FX_REFRESH_SCHEDULER = 'fx-refresh';

/**
 * Provides the refresh, its processor, and registers its hourly schedule.
 *
 * Why: decision 029. The API never does slow work inline (decision 020); the worker does. The refresh is the same
 * `FxRefreshService` the admin route uses, so the worker builds it here with the configured driver instead of loading the API's money
 * module (its controllers and the rest of its services).
 */
@Module({
  imports: [JobRunsModule],
  providers: [AuditService, FX_PROVIDER_FACTORY, FxRefreshService, FxRefreshProcessor],
})
export class FxRefreshJobModule implements OnModuleInit {
  constructor(private readonly schedulers: JobSchedulerRegistry) {}

  /** Registers the schedule; the worker creates it in Redis when it starts. */
  onModuleInit(): void {
    this.schedulers.register({
      id: FX_REFRESH_SCHEDULER,
      queue: 'maintenance',
      jobName: FX_REFRESH_JOB,
      pattern: '0 * * * *',
      description: 'Fetches the latest exchange rates from the configured provider for every active currency.',
    });
  }
}
