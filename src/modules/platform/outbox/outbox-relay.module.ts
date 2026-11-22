// Nest module of the outbox relay and the outbox purge (platform module, decisions 020 and 055). Import it in the worker process only
// (src/worker.module.ts); the API process writes outbox rows and never relays them.
import { Module, type OnModuleInit } from '@nestjs/common';
import { JobSchedulerRegistry } from '../../../infra/queues';
import { OutboxListener } from './outbox-listener';
import { OutboxPurge } from './outbox-purge';
import { OUTBOX_PURGE_JOB, OutboxPurgeProcessor } from './outbox-purge.processor';
import { OutboxRelay } from './outbox-relay';
import { OutboxRelayMetrics } from './outbox-relay.metrics';
import { OUTBOX_TICK_JOB, OutboxRelayProcessor } from './outbox-relay.processor';
import { OutboxModule } from './outbox.module';

/** The id of the scheduler that ticks the relay. */
export const OUTBOX_TICK_SCHEDULER = 'outbox-relay-tick';
/** The id of the scheduler of the daily outbox purge (decision 055). */
export const OUTBOX_PURGE_SCHEDULER = 'outbox-purge';

/**
 * Provides the relay, its NOTIFY listener, its tick processor and its metrics, and the outbox purge with its processor; registers the
 * one-second tick and the daily purge.
 *
 * Why: decision 020 runs the relay only in the worker. The tick is a BullMQ job scheduler (created on every worker boot,
 * idempotent); the processor is found by `QueueWorkers`, so the worker needs this module and QueueWorkersModule and
 * nothing else to relay. It needs the global database, queue and metrics modules. Decision 055: relayed rows are deleted after 45 days.
 */
@Module({
  imports: [OutboxModule],
  providers: [OutboxRelay, OutboxRelayMetrics, OutboxListener, OutboxRelayProcessor, OutboxPurge, OutboxPurgeProcessor],
  exports: [OutboxRelay, OutboxPurge],
})
export class OutboxRelayModule implements OnModuleInit {
  constructor(private readonly schedulers: JobSchedulerRegistry) {}

  /** Registers the tick and the purge; the worker creates them in Redis when it starts. */
  onModuleInit(): void {
    this.schedulers.register({
      id: OUTBOX_TICK_SCHEDULER,
      queue: 'outbox-relay',
      jobName: OUTBOX_TICK_JOB,
      every: 1_000,
      // One job a second would fill the completed set of the noeviction Redis with ticks nobody looks at.
      jobOptions: { removeOnComplete: { count: 20 }, removeOnFail: { age: 60 * 60, count: 1_000 } },
      description: 'Safety net for the outbox NOTIFY wake-up: relays pending outbox events and retries failed ones.',
    });
    this.schedulers.register({
      id: OUTBOX_PURGE_SCHEDULER,
      queue: 'maintenance',
      jobName: OUTBOX_PURGE_JOB,
      pattern: '50 4 * * *',
      description: 'Deletes outbox events handed to their queues more than 45 days ago (decision 055).',
    });
  }
}
