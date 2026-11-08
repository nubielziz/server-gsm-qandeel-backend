// Nest module of the storefront receipt job (money module). Import it in the worker process only (src/worker.module.ts).
import { Module } from '@nestjs/common';
import { PdfModule, StoredFiles } from '../../platform';
import { OrderReceipts } from '../application/order-receipts';
import { MoneyOutboxModule } from '../money-outbox.module';
import { ReceiptRenderProcessor } from './receipt-render.processor';

/**
 * Provides the receipt renderer, its processor and the outbox route of `receipt.render`.
 *
 * Why: the API never draws a PDF or talks to the file storage while it answers a gateway (decision 020); the worker does. The classes the job
 * needs are plain services (the PDF renderer is dependency-free and the file storage module is the worker's own), so the worker builds them here
 * instead of loading the API's money module.
 */
@Module({
  imports: [MoneyOutboxModule, PdfModule],
  providers: [StoredFiles, OrderReceipts, ReceiptRenderProcessor],
  exports: [OrderReceipts],
})
export class ReceiptRenderModule {}
