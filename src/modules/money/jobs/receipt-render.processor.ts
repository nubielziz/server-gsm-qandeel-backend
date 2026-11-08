// The worker job of storefront receipts (money module, queue files): `receipt.render` draws the PDF of a paid receipt invoice and stores it.
// It is an outbox event, so the job carries the invoice id only.
import { Injectable } from '@nestjs/common';
import type { Job } from 'bullmq';
import { type JobProcessor, QueueProcessor, UnrecoverableError } from '../../../infra/queues';
import type { OutboxJobData } from '../../platform';
import { OrderReceipts, type ReceiptRenderResult } from '../application/order-receipts';
import { RECEIPT_RENDER_EVENT } from '../application/receipt-outbox';

/** Reads the invoice id a payload carries. */
function invoiceIdOf(job: Job<OutboxJobData>): number {
  const value = (job.data.payload as Record<string, unknown> | undefined)?.['invoiceId'];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new UnrecoverableError(`The ${job.name} job has no invoiceId.`);
  }
  return value;
}

/**
 * Draws and stores the receipts of paid storefront orders.
 *
 * Why: the capture commits the receipt invoice and writes the `receipt.render` event; this job renders the PDF and stores it, so the gateway's
 * webhook never waits for the render or the upload. A failure (storage down) is thrown and the queue retries it (3 attempts, backoff from 10
 * s); if it still fails, the first download of the receipt makes the copy (`OrderReceipts.read`), so a buyer is never left without one. The
 * job id is the outbox row's (`outbox-<id>`).
 */
@Injectable()
@QueueProcessor('files', RECEIPT_RENDER_EVENT)
export class ReceiptRenderProcessor implements JobProcessor<OutboxJobData, ReceiptRenderResult> {
  constructor(private readonly receipts: OrderReceipts) {}

  /**
   * Handles one job.
   *
   * @param job the outbox job (`payload.invoiceId`)
   * @returns what happened to the receipt's copy
   * @throws {AppError} `UNAVAILABLE` when the file storage cannot be reached (the queue retries)
   */
  async process(job: Job<OutboxJobData, ReceiptRenderResult, string>): Promise<ReceiptRenderResult> {
    return this.receipts.render(invoiceIdOf(job));
  }
}
