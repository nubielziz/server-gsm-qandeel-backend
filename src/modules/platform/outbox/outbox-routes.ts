// The registry that maps an outbox event type to the queues that handle it (platform module, decision 020, amended by 12a:
// one type may have several routes). Modules extend it in onModuleInit; OutboxService checks it on write and the relay reads it
// for every row.
import { Injectable } from '@nestjs/common';
import { isQueueName } from '../../../infra/queues';
import type { OutboxRoute } from './outbox.types';

/**
 * Holds the event types and their queues.
 *
 * Why: decision 020 relays each outbox row to the queue mapped from the event type; the producing module knows which
 * queue handles its event, so it registers the mapping instead of the relay knowing every module. Registering in
 * `onModuleInit` is enough: the API and the worker load the same modules, so both see the same registry. Amended by feature
 * 12a: one event may be wanted by two consumers (an order change reaches the merchant's webhooks and its notifications), so a
 * type has one route per queue; the relay adds one job per route and the consumers stay independent.
 *
 * @example
 * // in OrdersModule
 * onModuleInit(): void {
 *   this.outboxRoutes.register({ type: 'order.status_changed', queue: 'merchant-webhooks' });
 * }
 */
@Injectable()
export class OutboxRouteRegistry {
  private readonly routes = new Map<string, OutboxRoute[]>();

  /**
   * Maps an event type to a queue. A type may have several routes, one per queue.
   *
   * @param route the event type, its queue and optionally the job name
   * @throws {Error} when the same type is already registered for the same queue, or the queue does not exist
   */
  register(route: OutboxRoute): void {
    if (!isQueueName(route.queue))
      throw new Error(`Outbox event "${route.type}" names an unknown queue "${String(route.queue)}".`);
    const existing = this.routes.get(route.type) ?? [];
    if (existing.some((other) => other.queue === route.queue)) {
      throw new Error(`Outbox event type "${route.type}" is already registered for the queue "${route.queue}".`);
    }
    this.routes.set(route.type, [...existing, route]);
  }

  /**
   * Looks up the first route of an event type.
   *
   * @param type the event type
   * @returns its first registered route, or `undefined` when no module registered it
   */
  get(type: string): OutboxRoute | undefined {
    return this.routes.get(type)?.[0];
  }

  /**
   * Looks up every route of an event type.
   *
   * Why: the relay adds one job per route, so each consumer of an event gets its own job.
   *
   * @param type the event type
   * @returns the routes in registration order; empty when no module registered the type
   */
  routesOf(type: string): readonly OutboxRoute[] {
    return this.routes.get(type) ?? [];
  }

  /**
   * Lists every route.
   *
   * @returns the routes in registration order of their types, then of their queues
   */
  list(): readonly OutboxRoute[] {
    return [...this.routes.values()].flat();
  }
}
