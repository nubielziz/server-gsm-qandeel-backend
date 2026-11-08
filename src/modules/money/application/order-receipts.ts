// OrderReceipts: the PDF tax receipt of a paid storefront order (feature 16, map `GET /store/v1/orders/:token/receipt`, RESOLUTIONS money-7,
// decision 030). The receipt invoice is issued when the payment is captured; its PDF is drawn once, by the `receipt.render` job, and kept in `files`.
import { Injectable } from '@nestjs/common';
import { AppError } from '../../../common/errors';
import { DbService, type DbExecutor } from '../../../infra/db';
import { PdfRenderer, StoredFiles } from '../../platform';
import { loadOrderFacts } from '../infra/b2c-reads.repository';
import { loadBillingCustomers } from '../infra/foreign-directory.repository';
import type { Invoice } from '../db/schema';
import { findInvoice, findReceiptOfOrder, updateInvoice } from '../infra/invoice.repository';
import { findPaymentOfOrder } from '../infra/order-payment.repository';

const day = (date: Date | null): string => (date ? date.toISOString().slice(0, 10) : '-');

/** What one run of the render job did to a receipt's copy. */
export type ReceiptRenderResult = 'stored' | 'exists' | 'skipped';

/**
 * Draws, keeps and serves the receipts of storefront orders.
 *
 * Why: the map's receipt is a "PDF with the net amount, the tax and its rate, and the customer's country". Decision 030 and the brief: the
 * document is rendered once, when the invoice is paid, and stored in `files` (`invoices.pdf_file_id`, owned by the customer); every download
 * serves those stored bytes, so a receipt never changes after the customer has it, even when the service is renamed or the customer edits
 * their name. The capture only queues the render (the `receipt.render` job calls {@link render}), so the gateway's webhook is not held up by the
 * PDF or the upload. The numbers are the receipt invoice's (what the session locked, in the buyer's currency); the document is English text
 * with the Latin font. If the job could not make the copy (storage was down for every attempt, or the worker stopped), the first download
 * makes it, under the invoice's row lock so two downloads make one.
 *
 * Side effects: `render` and the fallback in `read` store one object and one `files` row and set `invoices.pdf_file_id`, once per invoice.
 */
@Injectable()
export class OrderReceipts {
  constructor(
    private readonly db: DbService,
    private readonly pdf: PdfRenderer,
    private readonly files: StoredFiles,
  ) {}

  /**
   * Draws and stores the PDF of a receipt invoice, for the `receipt.render` job.
   *
   * Why: the capture commits the invoice and queues this. It throws when the copy cannot be stored, so the queue retries the job; if every
   * attempt fails, the first download makes the copy ({@link read}). A repeat of the job, or a download that got there first, finds the
   * stored copy and does nothing.
   *
   * @param invoiceId the receipt invoice the capture issued
   * @returns `stored` when this call made the copy, `exists` when one was there already, `skipped` for an invoice that is gone or has no customer
   * @throws {AppError} `UNAVAILABLE` when the file storage cannot be reached
   */
  async render(invoiceId: number): Promise<ReceiptRenderResult> {
    return this.ensureStored(invoiceId).then((outcome) => outcome.result);
  }

  /**
   * Reads the receipt of an order.
   *
   * @param db the database
   * @param orderId the order the tracking token named
   * @returns the stored PDF bytes and the download name
   * @throws {AppError} `NOT_FOUND` when the order has no receipt (it was never paid through the storefront)
   */
  async read(db: DbExecutor, orderId: number): Promise<{ bytes: Uint8Array; filename: string }> {
    const invoice = await findReceiptOfOrder(db, orderId);
    if (!invoice) throw new AppError('NOT_FOUND', { detail: 'This order has no receipt.' });
    const fileId = invoice.pdfFileId ?? (await this.ensureStored(invoice.id)).fileId;
    const stored = fileId === undefined ? undefined : await this.files.read(db, fileId);
    if (!stored) throw new AppError('UNAVAILABLE', { detail: 'The receipt is not available right now. Try again.' });
    return { bytes: stored.bytes, filename: `${invoice.number}.pdf` };
  }

  /**
   * Renders and stores the PDF of a receipt invoice unless it already has one.
   *
   * Why: the invoice row is locked first and `pdf_file_id` re-read under the lock, so concurrent callers (the render job and a download)
   * store one copy.
   *
   * @param invoiceId the receipt invoice
   * @returns the id of the stored file (`undefined` for an invoice without a customer) and what this call did
   */
  private async ensureStored(invoiceId: number): Promise<{ fileId: number | undefined; result: ReceiptRenderResult }> {
    return this.db.runInTransaction(async ({ tx }) => {
      const invoice = await findInvoice(tx, invoiceId, true);
      if (!invoice || invoice.customerId === null) return { fileId: undefined, result: 'skipped' };
      if (invoice.pdfFileId !== null) return { fileId: invoice.pdfFileId, result: 'exists' };
      const bytes = await this.draw(tx, invoice);
      const file = await this.files.store(tx, {
        ownerType: 'customer',
        ownerId: invoice.customerId,
        filename: `${invoice.number}.pdf`,
        mime: 'application/pdf',
        bytes,
        area: 'receipts',
      });
      await updateInvoice(tx, invoice.id, { pdfFileId: file.id });
      return { fileId: file.id, result: 'stored' };
    });
  }

  /** Draws the receipt of an invoice from the invoice's own numbers. */
  private async draw(db: DbExecutor, invoice: Invoice): Promise<Uint8Array> {
    const orderId = invoice.orderId ?? 0;
    const order = (await loadOrderFacts(db, [orderId])).get(orderId);
    const customer =
      invoice.customerId === null
        ? undefined
        : (await loadBillingCustomers(db, [invoice.customerId])).get(invoice.customerId);
    const payment = await findPaymentOfOrder(db, orderId);
    return this.pdf.render({
      title: 'Tax receipt',
      subtitle: `${invoice.number}  -  PAID  -  ${day(invoice.paidAt)}`,
      createdAt: invoice.createdAt,
      footer: 'GSM',
      blocks: [
        {
          kind: 'facts',
          rows: [
            ['Receipt number', invoice.number],
            ['Order', `SF-${orderId}`],
            ['Date paid', day(invoice.paidAt)],
            ['Billed to', customer ? customer.name || customer.email : '-'],
            ['Email', customer?.email ?? '-'],
            ['Tax country', invoice.taxCountry || '-'],
            ['Paid with', payment?.brand || payment?.methodType || '-'],
          ],
        },
        { kind: 'space' },
        {
          kind: 'table',
          columns: [
            { title: 'Description', width: 5 },
            { title: 'Net', width: 2, align: 'right' },
            { title: 'VAT rate', width: 1.5, align: 'right' },
            { title: 'VAT', width: 2, align: 'right' },
            { title: 'Total', width: 2, align: 'right' },
          ],
          rows: [
            [
              order?.serviceName ?? invoice.description,
              `${invoice.netAmount} ${invoice.currency}`,
              `${invoice.taxRate}%`,
              `${invoice.taxAmount} ${invoice.currency}`,
              `${invoice.total} ${invoice.currency}`,
            ],
          ],
        },
        { kind: 'text', muted: true, text: `Total paid ${invoice.total} ${invoice.currency}, VAT included.` },
      ],
    });
  }
}
