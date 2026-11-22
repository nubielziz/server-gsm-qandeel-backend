// Global Nest module for writing outbox events (platform module, decision 020): OutboxService, the route registry and the registry of
// lost-work passes (decision 055). Shared by the API and the worker. The relay itself is OutboxRelayModule (worker only).
import { Global, Module } from '@nestjs/common';
import { LostWorkRegistry } from '../lost-work/lost-work.registry';
import { OutboxRouteRegistry } from './outbox-routes';
import { OutboxService } from './outbox.service';

/**
 * Provides {@link OutboxService} and {@link OutboxRouteRegistry} to every module, and the registry of lost-work passes, global so that a
 * module registering a pass needs no new import (decision 055).
 *
 * Why: any use case that needs async work writes an outbox row, and any module that produces an event type registers its
 * queue. The module needs no database or Redis provider (the transaction comes from the caller), so tests that leave
 * the infrastructure out still build the app.
 */
@Global()
@Module({
  providers: [OutboxRouteRegistry, OutboxService, LostWorkRegistry],
  exports: [OutboxRouteRegistry, OutboxService, LostWorkRegistry],
})
export class OutboxModule {}
