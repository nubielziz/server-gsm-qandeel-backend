// Unit tests of the invoice.paid outbox event: its type is registered with the merchant webhook queue, the payload is ids only, and the
// worker process loads the module that registers it (its relay only knows the routes of its own process, decision 020).
import { describe, expect, it } from 'bun:test';
import { WorkerModule } from '../../../worker.module';
import { OutboxRouteRegistry } from '../../platform';
import type { OutboxService } from '../../platform';
import { PaymentAutoCreditModule } from '../jobs/payment-auto-credit.module';
import { MoneyOutboxModule } from '../money-outbox.module';
import { INVOICE_PAID_EVENT, InvoiceOutbox } from './invoice-outbox';

/** An outbox that remembers what was written. */
function recording() {
  const written: Array<{ type: string; aggregateType: string; aggregateId: number; payload?: unknown }> = [];
  const outbox = { add: (_tx: unknown, event: (typeof written)[number]) => Promise.resolve(void written.push(event)) };
  return { written, outbox: outbox as unknown as OutboxService };
}

describe('InvoiceOutbox', () => {
  it('registers invoice.paid with the merchant-webhooks queue', () => {
    const routes = new OutboxRouteRegistry();
    new InvoiceOutbox(recording().outbox, routes).onModuleInit();
    expect(routes.list()).toEqual([{ type: 'invoice.paid', queue: 'merchant-webhooks' }]);
  });

  it('writes the invoice and merchant ids only', async () => {
    const { written, outbox } = recording();
    await new InvoiceOutbox(outbox, new OutboxRouteRegistry()).paid({} as never, { invoiceId: 12, clientId: 5 });
    expect(written).toEqual([
      { type: INVOICE_PAID_EVENT, aggregateType: 'invoices', aggregateId: 12, payload: { invoiceId: 12, clientId: 5 } },
    ]);
  });

  it('is loaded by the worker module, through the automatic credit module', () => {
    expect(Reflect.getMetadata('imports', WorkerModule) as unknown[]).toContain(PaymentAutoCreditModule);
    expect(Reflect.getMetadata('imports', PaymentAutoCreditModule) as unknown[]).toContain(MoneyOutboxModule);
  });
});
