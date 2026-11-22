// Nest module of the pass that seals the tracking tokens stored as issued (orders module, decision 054). Import it in the worker process
// only (src/worker.module.ts).
import { Module, type OnModuleInit } from '@nestjs/common';
import { JobRunsModule } from '../../health';
import { OutboxRouteRegistry } from '../../platform';
import {
  TRACKING_TOKENS_SEAL_EVENT,
  TRACKING_TOKENS_SEAL_JOB,
  TrackingTokenSeal,
} from '../application/tracking-token-seal';
import { TrackingTokenSealProcessor } from './tracking-token-seal.processor';

/**
 * Provides the pass and its processor, and routes the event migration `capability_tokens_seal` writes to the `maintenance` queue.
 *
 * Why: decision 054: only the migration writes this event and only the worker's relay reads it, so the route lives here and the API does
 * not load it.
 *
 * Side effects: registers one outbox route at boot.
 *
 * @see docs/queues.md (maintenance, outbox event types)
 */
@Module({
  imports: [JobRunsModule],
  providers: [TrackingTokenSeal, TrackingTokenSealProcessor],
  exports: [TrackingTokenSeal],
})
export class TrackingTokenSealModule implements OnModuleInit {
  constructor(private readonly routes: OutboxRouteRegistry) {}

  /** Registers the route of the event. */
  onModuleInit(): void {
    this.routes.register({ type: TRACKING_TOKENS_SEAL_EVENT, queue: 'maintenance', jobName: TRACKING_TOKENS_SEAL_JOB });
  }
}
