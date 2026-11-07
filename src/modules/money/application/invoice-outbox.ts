// InvoiceOutbox: registers the outbox route of `invoice.paid` and writes its rows (ids only). Loaded by the API (it writes) and by
// the worker (its relay only knows the routes registered in its own process, decision 020).
import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { DbExecutor } from '../../../infra/db';
import { OutboxRouteRegistry, OutboxService } from '../../platform';

/** The outbox event type of a paid invoice; the merchant webhook fan-out (7b) turns it into the `invoice.paid` delivery. */
export const INVOICE_PAID_EVENT = 'invoice.paid';

/**
 * Writes `invoice.paid` to the transactional outbox.
 *
 * Why: user rule 3: paying an invoice credits the wallet and tells the merchant's webhook. The row is written in the same
 * transaction as the credit, so the event exists exactly when the money moved. The payload is ids only: the delivery job re-reads
 * the invoice (decision 020) and needs `clientId` to find the merchant's endpoints.
 *
 * Side effects: registers the event type with the `merchant-webhooks` queue at boot; `paid` inserts one `outbox_events` row.
 */
@Injectable()
export class InvoiceOutbox implements OnModuleInit {
  constructor(
    private readonly outbox: OutboxService,
    private readonly routes: OutboxRouteRegistry,
  ) {}

  /** Registers `invoice.paid` with the merchant webhook queue. */
  onModuleInit(): void {
    this.routes.register({ type: INVOICE_PAID_EVENT, queue: 'merchant-webhooks' });
  }

  /**
   * Writes `invoice.paid`.
   *
   * @param tx the transaction that credited the wallet
   * @param invoice the invoice and its merchant
   */
  async paid(tx: DbExecutor, invoice: { readonly invoiceId: number; readonly clientId: number }): Promise<void> {
    await this.outbox.add(tx, {
      type: INVOICE_PAID_EVENT,
      aggregateType: 'invoices',
      aggregateId: invoice.invoiceId,
      payload: { invoiceId: invoice.invoiceId, clientId: invoice.clientId },
    });
  }
}
