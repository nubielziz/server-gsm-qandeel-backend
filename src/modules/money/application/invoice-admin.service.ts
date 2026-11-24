// InvoiceAdminService: the staff routes on invoices (map routes /admin/invoices): list, read and issue a manual invoice, audited.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import type { ParsedListQuery } from '../../../common/contract';
import { type CustomerContact, customerEmailIn } from '../../../common/customer-contact';
import { AppError, type FieldError } from '../../../common/errors';
import { type DbExecutor, DbService } from '../../../infra/db';
import { type AccountRecord, AccountDirectory, type StaffPrincipal, customerContactOf } from '../../identity';
import { AuditService, SettingsReader } from '../../platform';
import { BASE_CURRENCY } from '../domain/accounts';
import {
  B2B_VAT_RATE_KEY,
  INVOICE_DUE_DAYS_BOUNDS,
  INVOICE_DUE_DAYS_KEY,
  DEFAULT_INVOICE_DUE_DAYS,
  NOT_MERCHANT_PROBLEM,
  checkDescription,
  dueAtOf,
  invoiceNumber,
  invoiceWireSide,
  manualInvoiceTotals,
  parseAmount,
  vatRateFrom,
} from '../domain/invoice-rules';
import { loadBillingMerchants } from '../infra/foreign-directory.repository';
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
 * What is wrong with the account a manual invoice is issued to.
 *
 * Why: decision 064: a staff-issued invoice is for a merchant wallet only. An account of the retail rank (a guest included) has no route
 * to pay it, so it is refused as `not_merchant`; a merchant without a billing country cannot be taxed.
 *
 * @param account the account read by the id staff typed, or `undefined` when there is none
 * @returns the problem on `clientId`, or `undefined` when the invoice may be issued
 */
function issueTargetProblem(account: AccountRecord | undefined): FieldError | undefined {
  if (!account) return { field: 'clientId', code: 'unknown', message: 'Choose a merchant that exists.' };
  if (account.rankKind !== 'merchant') return NOT_MERCHANT_PROBLEM;
  if (account.country === '')
    return { field: 'clientId', code: 'no_country', message: 'This merchant has no billing country.' };
  return undefined;
}

/**
 * Lists, reads and issues invoices for staff.
 *
 * Why: the Finance page lists every invoice (merchant top-ups, manual invoices, store top-ups, storefront receipts) and staff issue a
 * manual one to bill a merchant (user rule 3: it is a top-up invoice, paying it credits the wallet and emits `invoice.paid`). Issuing
 * writes no ledger entry: the money moves when the invoice is paid. Every invoice belongs to an account (decision 064): the row says
 * which side of the wire it is on (`client` for a merchant wallet, `customer` otherwise), and a manual invoice is for a merchant rank only.
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
    private readonly accounts: AccountDirectory,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Lists invoices.
   *
   * @param query the parsed list request
   * @param contact what the caller may see of a storefront customer's address (decision 047, rule A)
   * @returns the page and the number matching the filters
   */
  async list(
    query: ParsedListQuery<InvoiceSortField>,
    contact: CustomerContact,
  ): Promise<{ rows: WireInvoice[]; total: number }> {
    const { rows, total } = await listInvoiceRows(this.db.db, query, { searchNames: true });
    return { rows: await this.wireOf(this.db.db, rows, contact), total };
  }

  /**
   * Reads one invoice.
   *
   * @param id the invoice id
   * @param contact what the caller may see of a storefront customer's address (decision 047)
   * @returns the invoice
   * @throws {AppError} `NOT_FOUND`
   */
  async get(id: number, contact: CustomerContact): Promise<WireInvoice> {
    const row = await findInvoice(this.db.db, id);
    if (!row) throw notFound();
    return (await this.wireOf(this.db.db, [row], contact))[0]!;
  }

  /**
   * Issues a manual invoice to a merchant.
   *
   * Why: user rule 3; the invoice records its issuer, whose own approval of the payment is refused unless they are an Owner
   * (decision 049). Decision 064: it names the account (`account_id`, and `client_id` while the old column lasts) and the merchant
   * wallet it fills. The account row is read under `FOR KEY SHARE` before the insert, so a rank change cannot turn the account into a
   * retail one between the check and the row.
   *
   * Side effects: inserts an `invoices` row (with `issued_by`) and an audit row; renders the PDF after the commit.
   *
   * @param caller the staff member who issues it; the answer shows a storefront customer's address in the form this caller may see
   *   (decision 047: `customerContactOf(caller)`)
   * @param input the merchant, the amount and what it is for
   * @returns the new invoice
   * @throws {AppError} `VALIDATION_FAILED` on `clientId` (`unknown`; `not_merchant`: an account of the retail rank; `no_country`: no billing
   *   country), `amount` or `description`
   */
  async issue(caller: StaffPrincipal, input: IssueInvoiceInput): Promise<WireInvoice> {
    const errors: FieldError[] = [];
    const parsed = parseAmount(input.amount);
    if ('problem' in parsed) errors.push(parsed.problem);
    const description = checkDescription(input.description);
    if (description) errors.push(description);
    // Every problem at once, so the dialog shows them together; the check under the lock below decides.
    const target = issueTargetProblem(await this.accounts.findById(this.db.db, input.clientId));
    if (target) errors.push(target);
    if (errors.length > 0 || 'problem' in parsed) throw new AppError('VALIDATION_FAILED', { errors });

    const now = this.clock.now();
    const vatRate = vatRateFrom(await this.settings.get(B2B_VAT_RATE_KEY));
    const dueDays = await this.settings.integer(
      INVOICE_DUE_DAYS_KEY,
      DEFAULT_INVOICE_DUE_DAYS,
      INVOICE_DUE_DAYS_BOUNDS,
    );
    const totals = manualInvoiceTotals(parsed.amount, vatRate);
    const row = await this.db.runInTransaction(async (work) => {
      // Lock order (decision 064): the account row first, then the invoice; the rank is read only after the lock.
      const merchant = await this.accounts.lockForKeyShare(work.tx, input.clientId);
      const refused = issueTargetProblem(merchant);
      if (refused || !merchant) throw new AppError('VALIDATION_FAILED', { errors: [refused ?? NOT_MERCHANT_PROBLEM] });
      const id = await reserveInvoiceId(work.tx);
      const created = await insertInvoice(work.tx, {
        id,
        number: invoiceNumber(now.getUTCFullYear(), id),
        accountId: merchant.id,
        walletKind: 'client_wallet',
        legacyClientId: merchant.id,
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
        issuedBy: caller.staffId,
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
    return (await this.wireOf(this.db.db, [row], customerContactOf(caller)))[0]!;
  }

  /**
   * The wire of invoices with the account each belongs to (one read for the whole page).
   *
   * The account is named as the `client` of a merchant-wallet invoice and as the `customer` of any other one (`invoiceWireSide`); a
   * customer's address follows `contact`.
   */
  private async wireOf(db: DbExecutor, rows: readonly Invoice[], contact: CustomerContact): Promise<WireInvoice[]> {
    const accounts = await loadBillingMerchants(
      db,
      rows.map((row) => row.accountId),
    );
    return rows.map((row) => {
      const account = accounts.get(row.accountId);
      const side = invoiceWireSide(row);
      return invoiceToWire(
        row,
        side === 'client' && account ? { id: account.id, name: account.name } : undefined,
        side === 'customer' && account
          ? { id: account.id, name: account.name, email: customerEmailIn(contact, account.email) }
          : undefined,
      );
    });
  }
}
