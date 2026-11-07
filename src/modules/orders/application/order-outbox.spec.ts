// Unit tests of the order outbox events: the two types are registered with the queues the lead assigned, the payloads are ids and status
// words only, and the worker process loads the module that registers them (its relay needs the routes).
import { describe, expect, it } from 'bun:test';
import { WorkerModule } from '../../../worker.module';
import { OutboxRouteRegistry } from '../../platform';
import type { OutboxService } from '../../platform';
import { OrdersOutboxModule } from '../orders-outbox.module';
import { ORDER_OUTBOX_EVENTS, OrderOutbox } from './order-outbox';

/** An outbox that remembers what was written. */
function recording() {
  const written: Array<{ type: string; aggregateType: string; aggregateId: number; payload?: unknown }> = [];
  const outbox = { add: (_tx: unknown, event: (typeof written)[number]) => Promise.resolve(void written.push(event)) };
  return { written, outbox: outbox as unknown as OutboxService };
}

describe('OrderOutbox', () => {
  it('registers order.status_changed with merchant-webhooks and order.dispatch_requested with supplier-dispatch', () => {
    const routes = new OutboxRouteRegistry();
    new OrderOutbox(recording().outbox, routes).onModuleInit();
    expect(routes.list()).toEqual([
      { type: 'order.status_changed', queue: 'merchant-webhooks' },
      { type: 'order.dispatch_requested', queue: 'supplier-dispatch' },
    ]);
  });

  it('writes ids and status words only', async () => {
    const { written, outbox } = recording();
    const orderOutbox = new OrderOutbox(outbox, new OutboxRouteRegistry());
    await orderOutbox.statusChanged({} as never, {
      orderId: 7,
      clientId: null,
      fromStatus: 'pending',
      toStatus: 'completed',
    });
    await orderOutbox.dispatchRequested({} as never, 7);
    expect(written).toEqual([
      {
        type: ORDER_OUTBOX_EVENTS.statusChanged,
        aggregateType: 'orders',
        aggregateId: 7,
        payload: { orderId: 7, clientId: null, fromStatus: 'pending', toStatus: 'completed' },
      },
      { type: ORDER_OUTBOX_EVENTS.dispatchRequested, aggregateType: 'orders', aggregateId: 7, payload: { orderId: 7 } },
    ]);
  });

  it('is loaded by the worker module, whose relay only knows the routes registered in its own process', () => {
    const imports = Reflect.getMetadata('imports', WorkerModule) as unknown[];
    expect(imports).toContain(OrdersOutboxModule);
  });
});
