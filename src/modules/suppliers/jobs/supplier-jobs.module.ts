// Nest module of the supplier jobs (suppliers module): the dispatch, poll and sync processors and the schedules. Import it in the worker
// process only (src/worker.module.ts).
import { Module, type OnModuleInit } from '@nestjs/common';
import { JobSchedulerRegistry } from '../../../infra/queues';
import { JobRunsModule } from '../../health';
import { SupplierEngineModule } from '../supplier-engine.module';
import { SupplierDispatchProcessor } from './supplier-dispatch.processor';
import { SUPPLIER_POLL_TICK_JOB } from '../application/supplier-poll';
import { SupplierPollProcessor } from './supplier-poll.processor';
import { BALANCE_CHECK_JOB, PRICE_SYNC_JOB, SupplierSyncProcessor } from './supplier-sync.processor';

/** The ids of the schedulers: renaming one creates a second scheduler in Redis, so docs and tests share these constants. */
export const SUPPLIER_SCHEDULERS = {
  poll: 'supplier-poll-tick',
  priceSync: 'supplier-price-sync',
  balanceCheck: 'supplier-balance-check',
} as const;

/**
 * Provides the processors of `supplier-dispatch`, `supplier-poll` and `supplier-sync`, and registers the schedules: the poll tick every
 * minute, the price sync every 15 minutes and the balance check every 30 minutes (the console's job list).
 *
 * Why: the API only enqueues (the outbox row of a placed order, a staff sync request); the worker runs the supplier calls (decision 020).
 */
@Module({
  imports: [SupplierEngineModule, JobRunsModule],
  providers: [SupplierDispatchProcessor, SupplierPollProcessor, SupplierSyncProcessor],
})
export class SupplierJobsModule implements OnModuleInit {
  constructor(private readonly schedulers: JobSchedulerRegistry) {}

  /** Registers the schedules; the worker creates them in Redis when it starts. */
  onModuleInit(): void {
    this.schedulers.register({
      id: SUPPLIER_SCHEDULERS.poll,
      queue: 'supplier-poll',
      jobName: SUPPLIER_POLL_TICK_JOB,
      every: 60_000,
      jobOptions: { removeOnComplete: { age: 600, count: 20 }, removeOnFail: { age: 3600 } },
      description: 'Queues a status poll for every sent order that is due one.',
    });
    this.schedulers.register({
      id: SUPPLIER_SCHEDULERS.priceSync,
      queue: 'supplier-sync',
      jobName: PRICE_SYNC_JOB,
      pattern: '*/15 * * * *',
      description: 'Syncs the services and prices of every supplier that is not disabled.',
    });
    this.schedulers.register({
      id: SUPPLIER_SCHEDULERS.balanceCheck,
      queue: 'supplier-sync',
      jobName: BALANCE_CHECK_JOB,
      pattern: '*/30 * * * *',
      description: 'Refreshes our balance at every supplier that is not disabled.',
    });
  }
}
