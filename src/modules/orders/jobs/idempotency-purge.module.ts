// Nest module of the daily Idempotency-Key purge job (orders module). Import it in the worker process only (src/worker.module.ts).
import { Module, type OnModuleInit } from '@nestjs/common';
import { JobSchedulerRegistry } from '../../../infra/queues';
import { JobRunsModule } from '../../health';
import { IDEMPOTENCY_WINDOW_DAYS } from '../domain/idempotency-window';
import { IdempotencyPurge } from './idempotency-purge';
import { IDEMPOTENCY_PURGE_JOB, IdempotencyPurgeProcessor } from './idempotency-purge.processor';

/**
 * The id of the scheduler that ticks the purge once a day.
 *
 * Why: renaming a scheduler creates a second one in Redis, so the id is a constant that docs and tests share.
 */
export const IDEMPOTENCY_PURGE_SCHEDULER = 'idempotency-purge';

/**
 * Provides the purge, its processor, and registers its daily schedule (04:10 UTC, after the nightly 02:30 to 03:45 jobs).
 *
 * Why: the API never deletes in bulk (decision 020); the worker does. The schedule is a BullMQ job scheduler, created on every worker boot
 * (idempotent). The module needs the database and the queue Redis, so only the worker loads it (it is not in the API's `AppModule`).
 */
@Module({
  imports: [JobRunsModule],
  providers: [IdempotencyPurge, IdempotencyPurgeProcessor],
  exports: [IdempotencyPurge],
})
export class IdempotencyPurgeModule implements OnModuleInit {
  constructor(private readonly schedulers: JobSchedulerRegistry) {}

  /** Registers the schedule; the worker creates it in Redis when it starts. */
  onModuleInit(): void {
    this.schedulers.register({
      id: IDEMPOTENCY_PURGE_SCHEDULER,
      queue: 'maintenance',
      jobName: IDEMPOTENCY_PURGE_JOB,
      pattern: '10 4 * * *',
      description: `Forgets REST v1 Idempotency-Keys older than ${IDEMPOTENCY_WINDOW_DAYS} days: deletes the stored answers and clears orders.idempotency_key.`,
    });
  }
}
