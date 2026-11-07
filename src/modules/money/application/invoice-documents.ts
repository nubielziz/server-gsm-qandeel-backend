// InvoiceDocuments: renders the PDF of a merchant invoice when it is issued or paid and keeps it in `files` (decision 030).
import { Inject, Injectable, Logger } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import { DbService } from '../../../infra/db';
import { PdfRenderer, StoredFiles } from '../../platform';
import type { Invoice } from '../db/schema';
import { findInvoice, updateInvoice } from '../infra/invoice.repository';
import { loadBillingMerchants } from '../infra/foreign-directory.repository';

const day = (date: Date | null): string => (date ? date.toISOString().slice(0, 10) : '-');

/**
 * Makes and stores the PDF copy of an invoice.
 *
 * Why: decision 030: an invoice PDF is rendered when the invoice is issued or paid and stored in `files`
 * (`invoices.pdf_file_id`), so staff download it from `GET /admin/files/:id` and the merchant from `GET /client/files/:id`. The file
 * is owned by the merchant. It is written after the commit of the use case that issued or paid the invoice, and a failure
 * (storage down) is logged and leaves `pdf_file_id` as it was: the money and the status never depend on a document. The paid PDF
 * replaces the open one.
 *
 * Side effects: `render` stores one object and one `files` row and sets `invoices.pdf_file_id`.
 */
@Injectable()
export class InvoiceDocuments {
  private readonly logger = new Logger(InvoiceDocuments.name);

  constructor(
    private readonly db: DbService,
    private readonly pdf: PdfRenderer,
    private readonly files: StoredFiles,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Renders the invoice as it is now and attaches it. Never throws.
   *
   * @param invoiceId the invoice (a merchant's; a storefront receipt is not rendered here)
   */
  async render(invoiceId: number): Promise<void> {
    try {
      const invoice = await findInvoice(this.db.db, invoiceId);
      if (!invoice || invoice.clientId === null) return;
      const merchant = (await loadBillingMerchants(this.db.db, [invoice.clientId])).get(invoice.clientId);
      const bytes = await this.pdf.render(
        this.documentOf(invoice, merchant?.name ?? `Merchant ${invoice.clientId}`, merchant?.country ?? ''),
      );
      const file = await this.files.store(this.db.db, {
        ownerType: 'client',
        ownerId: invoice.clientId,
        filename: `${invoice.number}.pdf`,
        mime: 'application/pdf',
        bytes,
        area: 'invoices',
      });
      await updateInvoice(this.db.db, invoice.id, { pdfFileId: file.id });
    } catch (error) {
      this.logger.error(
        `The PDF of invoice ${invoiceId} could not be made: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private documentOf(invoice: Invoice, merchantName: string, country: string) {
    const status = invoice.status === 'paid' ? 'PAID' : invoice.status === 'void' ? 'VOID' : 'OPEN';
    return {
      title: 'Invoice',
      subtitle: `${invoice.number}  -  ${status}  -  issued ${day(invoice.createdAt)}`,
      createdAt: this.clock.now(),
      footer: 'GSM',
      blocks: [
        {
          kind: 'facts' as const,
          rows: [
            ['Invoice number', invoice.number],
            ['Billed to', merchantName],
            ['Billing country', country || '-'],
            ['Status', status],
            ['Issued', day(invoice.createdAt)],
            ['Due', day(invoice.dueAt)],
            ['Paid', day(invoice.paidAt)],
          ] as Array<[string, string]>,
        },
        { kind: 'space' as const },
        {
          kind: 'table' as const,
          columns: [
            { title: 'Description', width: 5 },
            { title: 'Amount', width: 2, align: 'right' as const },
            { title: 'Fee', width: 1.5, align: 'right' as const },
            { title: 'Tax', width: 1.5, align: 'right' as const },
            { title: 'Total', width: 2, align: 'right' as const },
          ],
          rows: [
            [
              invoice.description || (invoice.kind === 'topup' ? 'Wallet top-up' : 'Invoice'),
              `${invoice.amount} ${invoice.currency}`,
              invoice.fee,
              `${invoice.taxAmount} (${invoice.taxRate}%)`,
              `${invoice.total} ${invoice.currency}`,
            ],
          ],
        },
        {
          kind: 'text' as const,
          muted: true,
          text: `When this invoice is paid, ${invoice.netAmount} ${invoice.currency} is credited to your wallet.`,
        },
      ],
    };
  }
}
