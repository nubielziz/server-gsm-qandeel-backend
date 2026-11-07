// InvoiceAdminService: the staff routes on invoices (map routes /admin/invoices): list, read and issue a manual invoice, audited.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import type { ParsedListQuery } from '../../../common/contract';
import { AppError } from '../../../common/errors';
import { type DbExecutor, DbService } from '../../../infra/db';
import { AuditService, SettingsReader } from '../../platform';
import { BASE_CURRENCY } from '../domain/accounts';
import {
  B2B_VAT_RATE_KEY,
  INVOICE_DUE_DAYS_BOUNDS,
  INVOICE_DUE_DAYS_KEY,
  DEFAULT_INVOICE_DUE_DAYS,
  checkDescription,
  dueAtOf,
  invoiceNumber,
  manualInvoiceTotals,
  parseAmount,
  vatRateFrom,
} from '../domain/invoice-rules';
import { loadBillingCustomers, loadBillingMerchants } from '../infra/foreign-directory.repository';
import {
  type InvoiceSortField,
  findInvoice,
  insertInvoice,
  listInvoiceRows,
  reserveInvoiceId,
} from '../infra/invoice.repository';
import type { Invoice } from '../db/schema';
import { type WireInvoice, invoiceToWire } from './billing-wire';
import { InvoiceDocuments } from './invoice-documents';

/** What staff type when they issue a manual invoice. */
export interface IssueInvoiceInput {
  readonly clientId: number;
  readonly amount: string;
  readonly description: string;
}

const notFound = () => new AppError('NOT_FOUND', { detail: 'No invoice has this id.' });

/**
 * Lists, reads and issues invoices for staff.
 *
 * Why: the Finance page lists every invoice (merchant top-ups, manual invoices, storefront receipts) and staff issue a manual one
 * to bill a merchant (user rule 3: it is a top-up invoice, paying it credits the wallet and emits `invoice.paid`). Issuing writes no
 * ledger entry: the money moves when the invoice is paid.
 *
 * Side effects: `issue` inserts an `invoices` row and an audit row and, after the commit, renders its PDF.
 *
 * @see docs/contract/endpoints/money.md (GET|POST /admin/invoices, GET /admin/invoices/:id)
 */
@Injectable()
export class InvoiceAdminService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly settings: SettingsReader,
    private readonly documents: InvoiceDocuments,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Lists invoices.
   *
   * @param query the parsed list request
   * @returns the page and the number matching the filters
   */
  async list(query: ParsedListQuery<InvoiceSortField>): Promise<{ rows: WireInvoice[]; total: number }> {
    const { rows, total } = await listInvoiceRows(this.db.db, query, { searchNames: true });
    return { rows: await this.wireOf(this.db.db, rows), total };
  }

  /**
   * Reads one invoice.
   *
   * @param id the invoice id
   * @returns the invoice
   * @throws {AppError} `NOT_FOUND`
   */
  async get(id: number): Promise<WireInvoice> {
    const row = await findInvoice(this.db.db, id);
    if (!row) throw notFound();
    return (await this.wireOf(this.db.db, [row]))[0]!;
  }

  /**
   * Issues a manual invoice to a merchant.
   *
   * @param input the merchant, the amount and what it is for
   * @returns the new invoice
   * @throws {AppError} `VALIDATION_FAILED` on `clientId` (unknown merchant, or no billing country), `amount` or `description`
   */
  async issue(input: IssueInvoiceInput): Promise<WireInvoice> {
    const errors = [];
    const parsed = parseAmount(input.amount);
    if ('problem' in parsed) errors.push(parsed.problem);
    const description = checkDescription(input.description);
    if (description) errors.push(description);
    const merchant = (await loadBillingMerchants(this.db.db, [input.clientId])).get(input.clientId);
    if (!merchant) errors.push({ field: 'clientId', code: 'unknown', message: 'Choose a merchant that exists.' });
    else if (merchant.country === '')
      errors.push({ field: 'clientId', code: 'no_country', message: 'This merchant has no billing country.' });
    if (errors.length > 0 || !merchant || 'problem' in parsed) throw new AppError('VALIDATION_FAILED', { errors });

    const now = this.clock.now();
    const vatRate = vatRateFrom(await this.settings.get(B2B_VAT_RATE_KEY));
    const dueDays = await this.settings.integer(
      INVOICE_DUE_DAYS_KEY,
      DEFAULT_INVOICE_DUE_DAYS,
      INVOICE_DUE_DAYS_BOUNDS,
    );
    const totals = manualInvoiceTotals(parsed.amount, vatRate);
    const id = await reserveInvoiceId(this.db.db);
    const row = await this.db.runInTransaction(async (work) => {
      const created = await insertInvoice(work.tx, {
        id,
        number: invoiceNumber(now.getUTCFullYear(), id),
        clientId: merchant.id,
        kind: 'manual',
        amount: totals.amount.toWire(),
        fee: totals.fee.toWire(),
        netAmount: totals.net.toWire(),
        taxAmount: totals.tax.toWire(),
        taxRate: vatRate,
        taxCountry: merchant.country,
        total: totals.total.toWire(),
        currency: BASE_CURRENCY,
        status: 'open',
        description: input.description,
        dueAt: dueAtOf(now, dueDays),
        createdAt: now,
        updatedAt: now,
      });
      await this.audit.record(work.tx, {
        action: 'issued invoice for',
        entityType: 'invoice',
        entityId: created.id,
        entityLabel: `${merchant.name} (${created.number})`,
        after: { number: created.number, amount: created.amount, total: created.total, description: input.description },
      });
      work.afterCommit(() => this.documents.render(created.id));
      return created;
    });
    return (await this.wireOf(this.db.db, [row]))[0]!;
  }

  /** The wire of invoices with their merchants and customers (one read each for the whole page). */
  private async wireOf(db: DbExecutor, rows: readonly Invoice[]): Promise<WireInvoice[]> {
    const [merchants, customers] = await Promise.all([
      loadBillingMerchants(
        db,
        rows.flatMap((row) => (row.clientId === null ? [] : [row.clientId])),
      ),
      loadBillingCustomers(
        db,
        rows.flatMap((row) => (row.customerId === null ? [] : [row.customerId])),
      ),
    ]);
    return rows.map((row) =>
      invoiceToWire(
        row,
        row.clientId === null ? undefined : merchants.get(row.clientId),
        row.customerId === null ? undefined : customers.get(row.customerId),
      ),
    );
  }
}
