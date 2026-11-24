// Nest module of the lost-work reconcile (platform module, decision 055). Import it in the worker process only (src/worker.module.ts);
// the passes are registered by the worker modules that own the rows.
import { Module, type OnModuleInit } from '@nestjs/common';
import { JobSchedulerRegistry } from '../../../infra/queues';
import { LostWorkReconcile } from './lost-work-reconcile';
import { LOST_WORK_RECONCILE_JOB, LostWorkReconcileProcessor } from './lost-work-reconcile.processor';
import { OutboxRequests } from './outbox-requests';

/** The id of the scheduler of the lost-work reconcile. */
export const LOST_WORK_RECONCILE_SCHEDULER = 'lost-work-reconcile';

/**
 * Provides the reconcile, its processor and the reader of outbox requests, and registers the 5-minute schedule.
 *
 * Why: decision 055: the worker asks again for work whose queue job was lost. It needs the global database, queue, clock and outbox
 * modules (the registry of passes is the outbox module's).
 */
@Module({
  providers: [OutboxRequests, LostWorkReconcile, LostWorkReconcileProcessor],
  exports: [LostWorkReconcile],
})
export class LostWorkModule implements OnModuleInit {
  constructor(private readonly schedulers: JobSchedulerRegistry) {}

  /** Registers the schedule; the worker creates it in Redis when it starts. */
  onModuleInit(): void {
    this.schedulers.register({
      id: LOST_WORK_RECONCILE_SCHEDULER,
      queue: 'maintenance',
      jobName: LOST_WORK_RECONCILE_JOB,
      every: 300_000,
      jobOptions: { removeOnComplete: { age: 3600, count: 50 }, removeOnFail: { age: 86_400, count: 200 } },
      description:
        'Asks again for work whose queue job was lost: storefront refunds, bulk publish and Quick add runs (decision 055).',
    });
  }
}
