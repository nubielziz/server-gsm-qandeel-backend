// The registry that maps an outbox event type to the queue that handles it (platform module, decision 020).
// Modules extend it in onModuleInit; OutboxService checks it on write and the relay reads it for every row.
import { Injectable } from '@nestjs/common';
import { isQueueName } from '../../../infra/queues';
import type { OutboxRoute } from './outbox.types';

/**
 * Holds the event types and their queues.
 *
 * Why: decision 020 relays each outbox row to "the queue mapped from the event type"; the producing module knows which
 * queue handles its event, so it registers the mapping instead of the relay knowing every module. Registering in
 * `onModuleInit` is enough: the API and the worker load the same modules, so both see the same registry.
 *
 * @example
 * // in OrdersModule
 * onModuleInit(): void {
 *   this.outboxRoutes.register({ type: 'order.status_changed', queue: 'merchant-webhooks' });
 * }
 */
@Injectable()
export class OutboxRouteRegistry {
  private readonly routes = new Map<string, OutboxRoute>();

  /**
   * Maps an event type to a queue.
   *
   * @param route the event type, its queue and optionally the job name
   * @throws {Error} when the type is already registered or the queue does not exist
   */
  register(route: OutboxRoute): void {
    if (!isQueueName(route.queue))
      throw new Error(`Outbox event "${route.type}" names an unknown queue "${String(route.queue)}".`);
    if (this.routes.has(route.type)) throw new Error(`Outbox event type "${route.type}" is already registered.`);
    this.routes.set(route.type, route);
  }

  /**
   * Looks up an event type.
   *
   * @param type the event type
   * @returns its route, or `undefined` when no module registered it
   */
  get(type: string): OutboxRoute | undefined {
    return this.routes.get(type);
  }

  /**
   * Lists every route.
   *
   * @returns the routes in registration order
   */
  list(): readonly OutboxRoute[] {
    return [...this.routes.values()];
  }
}
