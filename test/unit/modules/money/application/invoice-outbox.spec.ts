// Unit tests of the invoice.paid outbox event: the payload is ids only, and the worker process loads the module that writes it. Its route to the
// notifications queue is registered by the platform's `NotificationRoutes`, not here.
import { describe, expect, it } from 'bun:test';
import { WorkerModule } from '@src/worker.module';
import type { OutboxService } from '@src/modules/platform';
import { PaymentAutoCreditModule } from '@src/modules/money/jobs/payment-auto-credit.module';
import { MoneyOutboxModule } from '@src/modules/money/money-outbox.module';
import { INVOICE_PAID_EVENT, InvoiceOutbox } from '@src/modules/money/application/invoice-outbox';

/** An outbox that remembers what was written. */
function recording() {
  const written: Array<{ type: string; aggregateType: string; aggregateId: number; payload?: unknown }> = [];
  const outbox = { add: (_tx: unknown, event: (typeof written)[number]) => Promise.resolve(void written.push(event)) };
  return { written, outbox: outbox as unknown as OutboxService };
}

describe('InvoiceOutbox', () => {
  it('writes the invoice and merchant ids only', async () => {
    const { written, outbox } = recording();
    await new InvoiceOutbox(outbox).paid({} as never, { invoiceId: 12, clientId: 5 });
    expect(written).toEqual([
      { type: INVOICE_PAID_EVENT, aggregateType: 'invoices', aggregateId: 12, payload: { invoiceId: 12, clientId: 5 } },
    ]);
  });

  it('is loaded by the worker module, through the automatic credit module', () => {
    expect(Reflect.getMetadata('imports', WorkerModule) as unknown[]).toContain(PaymentAutoCreditModule);
    expect(Reflect.getMetadata('imports', PaymentAutoCreditModule) as unknown[]).toContain(MoneyOutboxModule);
  });
});
