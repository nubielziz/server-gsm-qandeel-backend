// Nest module of the outbox relay (platform module, decision 020). Import it in the worker process only
// (src/worker.module.ts); the API process writes outbox rows and never relays them.
import { Module, type OnModuleInit } from '@nestjs/common';
import { JobSchedulerRegistry } from '../../../infra/queues';
import { OutboxListener } from './outbox-listener';
import { OutboxRelay } from './outbox-relay';
import { OutboxRelayMetrics } from './outbox-relay.metrics';
import { OUTBOX_TICK_JOB, OutboxRelayProcessor } from './outbox-relay.processor';
import { OutboxModule } from './outbox.module';

/** The id of the scheduler that ticks the relay. */
export const OUTBOX_TICK_SCHEDULER = 'outbox-relay-tick';

/**
 * Provides the relay, its NOTIFY listener, its tick processor and its metrics, and registers the one-second tick.
 *
 * Why: decision 020 runs the relay only in the worker. The tick is a BullMQ job scheduler (created on every worker boot,
 * idempotent); the processor is found by `QueueWorkers`, so the worker needs this module and QueueWorkersModule and
 * nothing else to relay. It needs the global database, queue and metrics modules.
 */
@Module({
  imports: [OutboxModule],
  providers: [OutboxRelay, OutboxRelayMetrics, OutboxListener, OutboxRelayProcessor],
  exports: [OutboxRelay],
})
export class OutboxRelayModule implements OnModuleInit {
  constructor(private readonly schedulers: JobSchedulerRegistry) {}

  /** Registers the tick; the worker creates it in Redis when it starts. */
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
  }
}
