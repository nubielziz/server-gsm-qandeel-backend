// ReceiptOutbox: registers the outbox route of the storefront receipt job (`receipt.render`) and writes its rows (ids only). Loaded by the API (it
// writes) and by the worker (its relay only knows the routes registered in its own process, decision 020).
import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { DbExecutor } from '../../../infra/db';
import { OutboxRouteRegistry, OutboxService } from '../../platform';

/** The outbox event type that draws and stores the PDF of a paid storefront receipt invoice. */
export const RECEIPT_RENDER_EVENT = 'receipt.render';

/**
 * Writes the storefront receipt event to the transactional outbox.
 *
 * Why: map `GET /store/v1/orders/:token/receipt`, decision 030: the receipt invoice is issued with the capture, but its PDF is drawn and stored
 * by a job, so the gateway's webhook is answered as soon as the capture commits instead of after the render and the upload. The row is written in
 * the capture's transaction, so the job exists exactly when the receipt does. The payload is the invoice id only.
 *
 * Side effects: registers the event type with the `files` queue at boot; `render` inserts one `outbox_events` row on the caller's transaction.
 *
 * @see docs/queues.md (outbox event types)
 */
@Injectable()
export class ReceiptOutbox implements OnModuleInit {
  constructor(
    private readonly outbox: OutboxService,
    private readonly routes: OutboxRouteRegistry,
  ) {}

  /** Registers `receipt.render`. */
  onModuleInit(): void {
    this.routes.register({ type: RECEIPT_RENDER_EVENT, queue: 'files' });
  }

  /**
   * Queues the PDF of a receipt invoice.
   *
   * @param tx the capture's transaction
   * @param invoiceId the receipt invoice the capture issued
   */
  async render(tx: DbExecutor, invoiceId: number): Promise<void> {
    await this.outbox.add(tx, {
      type: RECEIPT_RENDER_EVENT,
      aggregateType: 'invoices',
      aggregateId: invoiceId,
      payload: { invoiceId },
    });
  }
}
