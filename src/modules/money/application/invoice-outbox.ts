// InvoiceOutbox: writes the outbox rows of `invoice.paid` (ids only). Loaded by the API (it writes) and by the worker.
import { Injectable } from '@nestjs/common';
import type { DbExecutor } from '../../../infra/db';
import { OutboxService } from '../../platform';

/** The outbox event type of a paid invoice; the platform's `NotificationRoutes` registers its route and the notifications queue turns it into the merchant's message. */
export const INVOICE_PAID_EVENT = 'invoice.paid';

/**
 * Writes `invoice.paid` to the transactional outbox.
 *
 * Why: user rule 3: paying an invoice credits the wallet and tells the merchant. The row is written in the same
 * transaction as the credit, so the event exists exactly when the money moved. The payload is ids only: the notification job re-reads
 * the invoice (decision 020) and needs `clientId` to find the merchant.
 *
 * Side effects: `paid` inserts one `outbox_events` row.
 */
@Injectable()
export class InvoiceOutbox {
  constructor(private readonly outbox: OutboxService) {}

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
