// MerchantBillingService: the merchant portal's billing routes (MISMATCHES B162, B163): the payment methods, the merchant's invoices,
// a new top-up invoice and the receipt of a bank transfer. Portal writes write no audit rows (B121).
import { Inject, Injectable, Optional } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import type { ParsedListQuery } from '../../../common/contract';
import { AppError } from '../../../common/errors';
import { Money } from '../../../common/money';
import { APP_CONFIG, type AppConfig } from '../../../config';
import { type DbExecutor, DbService, isUniqueViolation } from '../../../infra/db';
import { OutboundHttp } from '../../../infra/http';
import { ClientGroupDirectory } from '../../catalog';
import { PROOF_MIME_TYPES, PublicImages, SettingsReader, StoredFiles } from '../../platform';
import { BASE_CURRENCY } from '../domain/accounts';
import {
  REQUIRE_3DS_KEY,
  asks3ds,
  checkChargeableAmount,
  checkDepositAmount,
  depositFee,
  topupMethodOf,
} from '../domain/gateway-rules';
import {
  B2B_VAT_RATE_KEY,
  DEFAULT_INVOICE_DUE_DAYS,
  INVOICE_DUE_DAYS_BOUNDS,
  INVOICE_DUE_DAYS_KEY,
  MERCHANT_OPEN_TOPUPS,
  OPEN_TOPUPS_DETAIL,
  PENDING_RECEIPTS_DETAIL,
  dueAtOf,
  invoiceNumber,
  parseAmount,
  tooManyOpenTopUps,
  tooManyPendingReceipts,
  topupInvoiceTotals,
  vatRateFrom,
} from '../domain/invoice-rules';
import { type Invoice, type InvoiceKind, type PaymentGateway, RECEIPT_LIVE_INDEX } from '../db/schema';
import { storeTopUpCheckoutUrl, voidUnpaidTopUp } from '../infra/customer-topup.repository';
import { loadBillingMerchants } from '../infra/foreign-directory.repository';
import { GATEWAY_HTTP_POLICY, type GatewayHttpPolicy } from '../infra/gateway-drivers/driver';
import { driverFor } from '../infra/gateway-drivers/drivers';
import { findGateway, findGatewaysByIds, listGatewaysForGroup } from '../infra/gateway.repository';
import {
  type InvoiceSortField,
  countLiveMerchantTopUps,
  findInvoiceOfClient,
  insertInvoice,
  listInvoiceRows,
  lockMerchantTopUps,
  reserveInvoiceId,
  updateInvoice,
} from '../infra/invoice.repository';
import {
  countPendingTopUpReceipts,
  findPaymentByReference,
  insertPayment,
  listPaymentsOfInvoice,
  pendingPaymentsOfInvoice,
} from '../infra/payment.repository';
import {
  type WireMerchantInvoice,
  type WireMerchantPayment,
  type WirePaymentMethod,
  merchantInvoiceToWire,
  merchantPaymentToWire,
  paymentMethodToWire,
} from './billing-wire';
import { GatewayCredentialsVault } from './gateway-credentials';
import { InvoiceDocuments } from './invoice-documents';
import { assertReceiptUnused, receiptTaken } from './receipt-proofs';

/** The kinds a merchant sees: storefront receipts belong to customers and never show (B163). */
const MERCHANT_KINDS: readonly InvoiceKind[] = ['topup', 'manual', 'statement'];
const MAX_REFERENCE = 64;

/** The answer of a new top-up invoice. */
export interface CreatedInvoice {
  readonly invoice: WireMerchantInvoice;
  readonly instructions?: string;
  readonly paymentUrl?: string;
}

/** The answer of one invoice: the invoice, its payments and how to pay while it is open. */
export interface InvoiceDetail extends CreatedInvoice {
  readonly payments: WireMerchantPayment[];
}

const fieldError = (field: string, code: string, message: string): AppError =>
  new AppError('VALIDATION_FAILED', { errors: [{ field, code, message }] });
const notFound = () => new AppError('NOT_FOUND', { detail: 'No invoice has this id.' });

/**
 * The portal's billing use cases.
 *
 * Why: B162 and B163. A merchant sees the payment methods open to its group (with the group's limit per deposit folded into
 * `maxAmount`), asks for a top-up invoice, and either pays online (an automatic gateway opens a checkout, and its signed
 * confirmation creates the payment, money-3) or sends a bank transfer receipt that staff review (user rule 4). A merchant never
 * reads another merchant's invoice (404). The wallet is credited only when staff approve or the automatic credit job runs.
 * Decision 049: a merchant holds at most five live unpaid top-up invoices and five receipts in review, one receipt (or a copy of
 * its bytes) backs one live payment, and a card page asks for 3-D Secure under the shop's `require3ds` policy.
 *
 * Side effects: `createInvoice` inserts an `invoices` row and may call a gateway's API (then stores its page, or voids the invoice
 * when the gateway fails); `uploadReceipt` inserts a `payments` row and may set the invoice's gateway.
 *
 * @see docs/contract/MISMATCHES.md (B162, B163)
 */
@Injectable()
export class MerchantBillingService {
  constructor(
    private readonly db: DbService,
    private readonly groups: ClientGroupDirectory,
    private readonly settings: SettingsReader,
    private readonly vault: GatewayCredentialsVault,
    private readonly files: StoredFiles,
    private readonly documents: InvoiceDocuments,
    private readonly http: OutboundHttp,
    private readonly images: PublicImages,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    @Optional() @Inject(GATEWAY_HTTP_POLICY) private readonly policy?: GatewayHttpPolicy,
  ) {}

  /**
   * Lists the payment methods open to a merchant.
   *
   * @param clientId the signed-in merchant
   * @returns the methods by name (one page: there are few), each with its `preset` and the `logoUrl` of an uploaded logo
   */
  async methods(clientId: number): Promise<{ rows: WirePaymentMethod[]; total: number }> {
    const { gateways, depositLimit } = await this.methodsOf(this.db.db, clientId);
    const logos = await this.images.urlsOf(
      this.db.db,
      gateways.map((gateway) => gateway.logoFileId),
    );
    const rows = gateways.map((gateway) =>
      paymentMethodToWire(gateway, depositLimit, logos.get(gateway.logoFileId ?? 0) ?? null),
    );
    return { rows, total: rows.length };
  }

  /**
   * Lists the merchant's invoices.
   *
   * @param clientId the signed-in merchant
   * @param query the parsed list request
   * @returns the page and the number matching the filters
   */
  async list(
    clientId: number,
    query: ParsedListQuery<InvoiceSortField>,
  ): Promise<{ rows: WireMerchantInvoice[]; total: number }> {
    const { rows, total } = await listInvoiceRows(this.db.db, query, { clientId, kinds: MERCHANT_KINDS });
    const gateways = await findGatewaysByIds(
      this.db.db,
      rows.flatMap((row) => (row.gatewayId === null ? [] : [row.gatewayId])),
    );
    return { rows: rows.map((row) => merchantInvoiceToWire(row, gatewayRef(gateways.get(row.gatewayId ?? 0)))), total };
  }

  /**
   * Reads one invoice of the merchant with its payments.
   *
   * @param clientId the signed-in merchant
   * @param id the invoice id
   * @returns the invoice, its payments and, while it is open, how to pay
   * @throws {AppError} `NOT_FOUND` for an unknown id or another merchant's invoice
   */
  async get(clientId: number, id: number): Promise<InvoiceDetail> {
    const invoice = await findInvoiceOfClient(this.db.db, id, clientId);
    if (!invoice || !MERCHANT_KINDS.includes(invoice.kind)) throw notFound();
    const [payments, gateway] = await Promise.all([
      listPaymentsOfInvoice(this.db.db, invoice.id),
      invoice.gatewayId === null ? undefined : findGateway(this.db.db, invoice.gatewayId),
    ]);
    return {
      invoice: merchantInvoiceToWire(invoice, gatewayRef(gateway)),
      payments: payments.map(merchantPaymentToWire),
      ...(invoice.status === 'open' ? howToPay(invoice, gateway) : {}),
    };
  }

  /**
   * Writes a top-up invoice through a payment method.
   *
   * Why: B162 and decision 049. The invoice is reserved first: one transaction under the merchant's top-up lock counts the live unpaid
   * top-ups and inserts the open invoice, so parallel requests cannot pass the limit of five. An automatic method's page is opened after
   * that commit (no network call under a lock); its address is stored, or the invoice is voided when the gateway fails. A card page asks
   * for 3-D Secure while the shop's `require3ds` policy is on.
   *
   * Side effects: inserts one `invoices` row (its PDF is rendered after the commit; for an automatic method once its page is stored);
   * an automatic method's API is called, then the page is stored or the invoice voided.
   *
   * @param clientId the signed-in merchant
   * @param input the amount and the gateway
   * @returns the invoice with the transfer instructions (manual) or the checkout address (automatic)
   * @throws {AppError} `VALIDATION_FAILED` on `gatewayId` or `amount` (`not_chargeable`: an automatic method that cannot charge the
   *   amount exactly, such as a card page for a third decimal); `CONFLICT` (409) when the merchant has five live unpaid
   *   top-up invoices (decision 049), before any gateway is asked; `GATEWAY_ERROR` (502) when the gateway fails: the invoice is voided
   */
  async createInvoice(clientId: number, input: { amount: string; gatewayId: number }): Promise<CreatedInvoice> {
    const { merchant, gateways, depositLimit } = await this.methodsOf(this.db.db, clientId);
    const gateway = gateways.find((candidate) => candidate.id === input.gatewayId);
    if (!gateway) throw fieldError('gatewayId', 'unavailable', 'Choose one of your payment methods.');
    const parsed = parseAmount(input.amount);
    if ('problem' in parsed) throw new AppError('VALIDATION_FAILED', { errors: [parsed.problem] });
    const problem = checkDepositAmount(parsed.amount, {
      minAmount: gateway.minAmount,
      maxAmount: gateway.maxAmount,
      depositLimit,
      feePercent: gateway.feePercent,
      feeFixed: gateway.feeFixed,
    });
    if (problem) throw new AppError('VALIDATION_FAILED', { errors: [problem] });
    // An automatic method that cannot charge this amount exactly would charge it rounded: refused before an invoice is reserved.
    const unchargeable = gateway.isManual
      ? undefined
      : checkChargeableAmount(parsed.amount, driverFor(gateway.driver)?.maxChargeDecimals?.(BASE_CURRENCY));
    if (unchargeable) throw new AppError('VALIDATION_FAILED', { errors: [unchargeable] });

    const now = this.clock.now();
    const since = new Date(now.getTime() - MERCHANT_OPEN_TOPUPS.liveHours * 3_600_000);
    const vatRate = vatRateFrom(await this.settings.get(B2B_VAT_RATE_KEY));
    const dueDays = await this.settings.integer(
      INVOICE_DUE_DAYS_KEY,
      DEFAULT_INVOICE_DUE_DAYS,
      INVOICE_DUE_DAYS_BOUNDS,
    );
    const require3ds = asks3ds(await this.settings.get(REQUIRE_3DS_KEY), gateway.supports3ds);
    const totals = topupInvoiceTotals(
      parsed.amount,
      depositFee(parsed.amount, gateway.feePercent, gateway.feeFixed),
      vatRate,
    );
    const row = await this.db.runInTransaction(async (work) => {
      // Decision 049: the count and the insert run under the merchant's lock, so two requests at once cannot both pass the limit;
      // the refusal comes before the number is reserved and before any gateway page is opened.
      await lockMerchantTopUps(work.tx, merchant.id);
      if (tooManyOpenTopUps(await countLiveMerchantTopUps(work.tx, merchant.id, since))) {
        throw new AppError('CONFLICT', { detail: OPEN_TOPUPS_DETAIL });
      }
      const id = await reserveInvoiceId(work.tx);
      const created = await insertInvoice(work.tx, {
        id,
        number: invoiceNumber(now.getUTCFullYear(), id),
        clientId: merchant.id,
        kind: 'topup',
        amount: totals.amount.toWire(),
        fee: totals.fee.toWire(),
        netAmount: totals.net.toWire(),
        taxAmount: totals.tax.toWire(),
        taxRate: vatRate,
        taxCountry: merchant.country,
        total: totals.total.toWire(),
        currency: BASE_CURRENCY,
        status: 'open',
        gatewayId: gateway.id,
        checkoutUrl: null,
        dueAt: dueAtOf(now, dueDays),
        createdAt: now,
        updatedAt: now,
      });
      if (gateway.isManual) work.afterCommit(() => this.documents.render(created.id));
      return created;
    });
    if (gateway.isManual) {
      return { invoice: merchantInvoiceToWire(row, gatewayRef(gateway)), instructions: gateway.instructions };
    }
    return this.openCheckout(row, gateway, require3ds);
  }

  /**
   * Attaches a bank transfer receipt to an open invoice and queues the payment for staff review.
   *
   * Why: B163 and decision 049: one receipt, or a copy of its bytes, backs one pending or approved payment, whoever uploaded it; a
   * merchant has at most five receipts on top-up invoices waiting for review (checked under the merchant's top-up lock).
   *
   * Side effects: inserts one `payments` row; may set the invoice's gateway; takes the merchant's top-up lock and the receipt
   * content's lock until the commit.
   *
   * @param clientId the signed-in merchant
   * @param invoiceId the invoice
   * @param input the receipt file, the bank reference and, for a staff-issued invoice, the manual method used
   * @returns the new pending payment
   * @throws {AppError} `NOT_FOUND`; `CONFLICT` when the invoice is not open, is paid online, or has a receipt waiting, or the
   *   merchant has five top-up receipts in review (decision 049); `VALIDATION_FAILED` on `fileId` (`invalid`; `taken`: the receipt,
   *   or a copy of it, backs a pending or approved payment, decision 049), `reference` or `gatewayId`
   */
  async uploadReceipt(
    clientId: number,
    invoiceId: number,
    input: { fileId: number; reference?: string | undefined; gatewayId?: number | undefined },
  ): Promise<WireMerchantPayment> {
    const reference = input.reference?.trim() ?? '';
    if (reference.length > MAX_REFERENCE) {
      throw fieldError('reference', 'length', `Keep the reference to ${MAX_REFERENCE} characters or fewer.`);
    }
    try {
      const payment = await this.db.runInTransaction(async ({ tx }) => {
        const invoice = await findInvoiceOfClient(tx, invoiceId, clientId, true);
        if (!invoice || !MERCHANT_KINDS.includes(invoice.kind)) throw notFound();
        if (invoice.status !== 'open') {
          throw new AppError('CONFLICT', {
            detail: invoice.status === 'paid' ? 'This invoice is already paid.' : 'This invoice was cancelled.',
          });
        }
        const gateway = await this.receiptGateway(tx, clientId, invoice, input.gatewayId);
        if ((await pendingPaymentsOfInvoice(tx, invoice.id)).length > 0) {
          throw new AppError('CONFLICT', { detail: 'A receipt for this invoice is waiting for review.' });
        }
        if (invoice.kind === 'topup') {
          // Decision 049: lock order invoice row, merchant top-up lock, receipt content lock.
          await lockMerchantTopUps(tx, clientId);
          if (tooManyPendingReceipts(await countPendingTopUpReceipts(tx, clientId))) {
            throw new AppError('CONFLICT', { detail: PENDING_RECEIPTS_DETAIL });
          }
        }
        const file = await this.files.findOwned(tx, input.fileId, { type: 'client', id: clientId });
        if (!file || !PROOF_MIME_TYPES.includes(file.mime)) {
          throw fieldError('fileId', 'invalid', 'Upload the receipt as a PDF, JPEG or PNG file first.');
        }
        if (reference !== '' && (await findPaymentByReference(tx, gateway.id, reference))) {
          throw fieldError('reference', 'taken', 'This reference was already used for this payment method.');
        }
        await assertReceiptUnused(tx, this.files, file.id);
        const now = this.clock.now();
        if (invoice.gatewayId === null) await updateInvoice(tx, invoice.id, { gatewayId: gateway.id, updatedAt: now });
        return insertPayment(tx, {
          purpose: 'topup',
          invoiceId: invoice.id,
          gatewayId: gateway.id,
          gatewayTxnId: reference === '' ? null : reference,
          amount: invoice.amount,
          feeAmount: invoice.fee,
          currency: invoice.currency,
          status: 'pending',
          methodType: topupMethodOf(gateway.driver, true),
          receiptFileId: file.id,
          createdAt: now,
          updatedAt: now,
        });
      });
      return merchantPaymentToWire(payment);
    } catch (error) {
      // Two receipts passed the checks together: the unique indexes decide (the receipt file first, then the bank reference).
      if (isUniqueViolation(error, RECEIPT_LIVE_INDEX)) throw receiptTaken();
      if (isUniqueViolation(error))
        throw fieldError('reference', 'taken', 'This reference was already used for this payment method.');
      throw error;
    }
  }

  /** Asks an automatic gateway for its page and stores it on the reserved invoice; a failure voids the invoice. */
  private async openCheckout(invoice: Invoice, gateway: PaymentGateway, require3ds: boolean): Promise<CreatedInvoice> {
    let paymentUrl: string;
    try {
      const driver = driverFor(gateway.driver);
      if (!driver)
        throw new AppError('GATEWAY_ERROR', { detail: `${gateway.name} has no driver that can open a checkout.` });
      ({ paymentUrl } = await driver.createCheckout(
        { http: this.http, policy: this.policy },
        this.vault.read(gateway),
        {
          invoiceNumber: invoice.number,
          amount: Money.of(invoice.amount),
          currency: BASE_CURRENCY,
          description: `Wallet top-up ${invoice.number}`,
          returnUrl: `${this.config.http.portalBaseUrl}/wallet`,
          require3ds,
        },
      ));
    } catch (error) {
      // The invoice was reserved before the call: a gateway that failed leaves it void, so it neither counts nor can be paid.
      await this.db.runInTransaction(({ tx }) => voidUnpaidTopUp(tx, invoice.id, this.clock.now()));
      throw error;
    }
    const stored = await this.db.runInTransaction(async (work) => {
      const updated = await storeTopUpCheckoutUrl(work.tx, invoice.id, paymentUrl, this.clock.now());
      work.afterCommit(() => this.documents.render(invoice.id));
      return updated;
    });
    return { invoice: merchantInvoiceToWire(stored ?? invoice, gatewayRef(gateway)), paymentUrl };
  }

  /** The manual gateway a receipt belongs to: the invoice's own, or the one the merchant names for a staff-issued invoice. */
  private async receiptGateway(
    tx: DbExecutor,
    clientId: number,
    invoice: Invoice,
    requested: number | undefined,
  ): Promise<PaymentGateway> {
    if (invoice.gatewayId !== null) {
      if (requested !== undefined && requested !== invoice.gatewayId) {
        throw fieldError('gatewayId', 'mismatch', 'This invoice is paid through another payment method.');
      }
      const own = await findGateway(tx, invoice.gatewayId);
      if (!own) throw new Error(`Invoice ${invoice.number} points at a gateway that does not exist.`);
      if (!own.isManual)
        throw new AppError('CONFLICT', { detail: 'This invoice is paid online: no receipt is needed.' });
      return own;
    }
    if (requested === undefined) {
      throw fieldError('gatewayId', 'required', 'Choose the payment method you paid through.');
    }
    const { gateways } = await this.methodsOf(tx, clientId);
    const chosen = gateways.find((candidate) => candidate.id === requested);
    if (!chosen || !chosen.isManual) {
      throw fieldError(
        'gatewayId',
        'unavailable',
        'Choose one of your manual payment methods, such as a bank transfer.',
      );
    }
    return chosen;
  }

  /** The merchant, the gateways open to its group and the group's limit per deposit. */
  private async methodsOf(db: DbExecutor, clientId: number) {
    const merchant = (await loadBillingMerchants(db, [clientId])).get(clientId);
    if (!merchant) throw new AppError('UNAUTHORIZED');
    const [gateways, group] = await Promise.all([
      listGatewaysForGroup(db, merchant.groupId),
      this.groups.find(db, merchant.groupId),
    ]);
    return { merchant, gateways, depositLimit: group?.depositLimit ?? Money.zero().toWire() };
  }
}

function gatewayRef(gateway: { id: number; name: string } | undefined): { id: number; name: string } | undefined {
  return gateway ? { id: gateway.id, name: gateway.name } : undefined;
}

/** How to pay an open invoice: the transfer instructions of a manual gateway, or the checkout address of an automatic one. */
function howToPay(
  invoice: Invoice,
  gateway: PaymentGateway | undefined,
): { instructions?: string; paymentUrl?: string } {
  if (gateway?.isManual) return { instructions: gateway.instructions };
  return invoice.checkoutUrl ? { paymentUrl: invoice.checkoutUrl } : {};
}
