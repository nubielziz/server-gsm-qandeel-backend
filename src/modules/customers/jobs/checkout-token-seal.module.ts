// Nest module of the pass that seals the checkout tokens stored as issued (customers module, decision 054). Import it in the worker process
// only (src/worker.module.ts).
import { Module, type OnModuleInit } from '@nestjs/common';
import { JobRunsModule } from '../../health';
import { OutboxRouteRegistry } from '../../platform';
import {
  CHECKOUT_TOKENS_SEAL_EVENT,
  CHECKOUT_TOKENS_SEAL_JOB,
  CheckoutTokenSeal,
} from '../application/checkout-token-seal';
import { CheckoutTokenSealProcessor } from './checkout-token-seal.processor';

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
  providers: [CheckoutTokenSeal, CheckoutTokenSealProcessor],
  exports: [CheckoutTokenSeal],
})
export class CheckoutTokenSealModule implements OnModuleInit {
  constructor(private readonly routes: OutboxRouteRegistry) {}

  /** Registers the route of the event. */
  onModuleInit(): void {
    this.routes.register({ type: CHECKOUT_TOKENS_SEAL_EVENT, queue: 'maintenance', jobName: CHECKOUT_TOKENS_SEAL_JOB });
  }
}
