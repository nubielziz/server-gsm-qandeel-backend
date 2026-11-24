// MerchantBillingService: the merchant portal's billing routes (MISMATCHES B162, B163): the payment methods, the merchant's invoices,
// a new top-up invoice (with an optional `Idempotency-Key`) and the receipt of a bank transfer. Portal writes write no audit rows (B121).
import { Inject, Injectable, Optional } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import type { ParsedListQuery } from '../../../common/contract';
import { AppError } from '../../../common/errors';
import { Money } from '../../../common/money';
import { APP_CONFIG, type AppConfig } from '../../../config';
import { type DbExecutor, DbService, isUniqueViolation } from '../../../infra/db';
import { OutboundHttp } from '../../../infra/http';
import { ClientGroupDirectory } from '../../catalog';
import { type AccountRecord, AccountDirectory, sessionStateOf } from '../../identity';
import { PROOF_MIME_TYPES, PublicImages, SettingsReader, StoredFiles, UPLOAD_AREA } from '../../platform';
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
  topUpFingerprint,
  topupInvoiceTotals,
  vatRateFrom,
} from '../domain/invoice-rules';
import { bankReferenceProblem, normalizeBankReference } from '../domain/payment-rules';
import { type Invoice, type InvoiceKind, type PaymentGateway, RECEIPT_LIVE_INDEX } from '../db/schema';
import { judgeTopUpKey, storeTopUpCheckoutUrl, voidUnpaidTopUp } from '../infra/customer-topup.repository';
import { GATEWAY_HTTP_POLICY, type GatewayHttpPolicy } from '../infra/gateway-drivers/driver';
import { driverFor } from '../infra/gateway-drivers/drivers';
import { findGateway, findGatewaysByIds, listGatewaysForGroup } from '../infra/gateway.repository';
import {
  type InvoiceSortField,
  countLiveMerchantTopUps,
  findInvoiceOfAccount,
  insertInvoice,
  listInvoiceRows,
  reserveInvoiceId,
  updateInvoice,
} from '../infra/invoice.repository';
import {
  countPendingTopUpReceipts,
  findLiveBankReference,
  insertPayment,
  listPaymentsOfInvoice,
  pendingPaymentsOfInvoice,
} from '../infra/payment.repository';
import { lockAccountTopUps } from '../infra/topup-lock.repository';
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

/** The kinds a merchant sees: storefront receipts belong to customers and never show (B163). `statement` is retired and never created; it stays so an old row is still read. */
const MERCHANT_KINDS: readonly InvoiceKind[] = ['topup', 'manual', 'statement'];
const MAX_REFERENCE = 64;

/** Whether an invoice is one the merchant portal shows: a merchant kind, and not a store top-up the account made as a retail account. */
const isMerchantInvoice = (invoice: Invoice): boolean =>
  MERCHANT_KINDS.includes(invoice.kind) && invoice.walletKind !== 'customer_wallet';

/** The answer of a new top-up invoice. */
export interface CreatedInvoice {
  readonly invoice: WireMerchantInvoice;
  readonly instructions?: string;
  readonly paymentUrl?: string;
}

/** The answer of a create and whether it replayed the answer of the same `Idempotency-Key`. */
export interface CreatedInvoiceAnswer {
  readonly answer: CreatedInvoice;
  readonly replayed: boolean;
}

/** The answer of one invoice: the invoice, its payments and how to pay while it is open. */
export interface InvoiceDetail extends CreatedInvoice {
  readonly payments: WireMerchantPayment[];
}

const fieldError = (field: string, code: string, message: string): AppError =>
  new AppError('VALIDATION_FAILED', { errors: [{ field, code, message }] });
const notFound = () => new AppError('NOT_FOUND', { detail: 'No invoice has this id.' });

/**
 * Checks the locked account of a merchant create and hands it on.
 *
 * Why: the session gate has already checked the rank and the status, but the account row is read again under its lock, so a rank change
 * or a suspension that committed between the gate and the lock refuses the create instead of billing the wrong wallet (decision 064).
 *
 * @param account the account read with `FOR KEY SHARE`
 * @returns the same account, known to be active and of a merchant rank
 * @throws {AppError} `UNAUTHORIZED` (gone), `ACCOUNT_SUSPENDED`, `RANK_NOT_ALLOWED`
 */
function assertMerchant(account: AccountRecord | undefined): AccountRecord {
  const state = account ? sessionStateOf(account.status) : 'gone';
  if (!account || state === 'gone') throw new AppError('UNAUTHORIZED');
  if (state === 'suspended') throw new AppError('ACCOUNT_SUSPENDED');
  if (account.rankKind !== 'merchant') throw new AppError('RANK_NOT_ALLOWED');
  return account;
}

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
 * Decision 064: the merchant is an account of a merchant rank, and its invoices carry `account_id` and the wallet kind
 * `client_wallet` (`client_id` is still written until the contract release). A create takes the account row `FOR KEY SHARE`, then the
 * account's top-up lock `topup:<accountId>`, and reads the rank (its group, limits and methods) only after both, so a rank change cannot
 * land between the checks and the insert. The optional `Idempotency-Key` makes a retry answer the same invoice.
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
    private readonly accounts: AccountDirectory,
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
   * @param accountId the signed-in merchant account
   * @returns the methods by name (one page: there are few), each with its `preset` and the `logoUrl` of an uploaded logo
   * @throws {AppError} `UNAUTHORIZED` when the account is gone
   */
  async methods(accountId: number): Promise<{ rows: WirePaymentMethod[]; total: number }> {
    const account = await this.accounts.findById(this.db.db, accountId);
    if (!account) throw new AppError('UNAUTHORIZED');
    const { gateways, depositLimit } = await this.methodsOf(this.db.db, account.groupId);
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
   * @param accountId the signed-in merchant account
   * @param query the parsed list request
   * @returns the page and the number matching the filters (a store top-up the account made as a retail account does not show)
   */
  async list(
    accountId: number,
    query: ParsedListQuery<InvoiceSortField>,
  ): Promise<{ rows: WireMerchantInvoice[]; total: number }> {
    const { rows, total } = await listInvoiceRows(this.db.db, query, {
      accountId,
      kinds: MERCHANT_KINDS,
      excludeWalletKind: 'customer_wallet',
    });
    const gateways = await findGatewaysByIds(
      this.db.db,
      rows.flatMap((row) => (row.gatewayId === null ? [] : [row.gatewayId])),
    );
    return { rows: rows.map((row) => merchantInvoiceToWire(row, gatewayRef(gateways.get(row.gatewayId ?? 0)))), total };
  }

  /**
   * Reads one invoice of the merchant with its payments.
   *
   * @param accountId the signed-in merchant account
   * @param id the invoice id
   * @returns the invoice, its payments and, while it is open, how to pay
   * @throws {AppError} `NOT_FOUND` for an unknown id or another account's invoice
   */
  async get(accountId: number, id: number): Promise<InvoiceDetail> {
    const invoice = await findInvoiceOfAccount(this.db.db, id, accountId);
    if (!invoice || !isMerchantInvoice(invoice)) throw notFound();
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
   * Why: B162 and decision 049. One transaction takes the account row `FOR KEY SHARE`, then the account's top-up lock, then reads the
   * rank (its group's limit and methods), counts the live unpaid top-ups and inserts the open invoice, so parallel requests cannot pass
   * the limit of five and a rank change cannot land in between (decision 064). An automatic method's page is opened after that commit
   * (no network call under a lock); its address is stored, or the invoice is voided when the gateway fails. A card page asks for 3-D
   * Secure while the shop's `require3ds` policy is on. An `Idempotency-Key`, when sent, is stored with the request's fingerprint: the
   * same request answers the same invoice, another one is refused, and a page that never opened is retried after a minute.
   *
   * Side effects: inserts one `invoices` row (its PDF is rendered after the commit; for an automatic method once its page is stored);
   * an automatic method's API is called, then the page is stored or the invoice voided; a stale attempt under the same key is voided.
   *
   * @param accountId the signed-in merchant account
   * @param input the amount and the gateway
   * @param key the optional `Idempotency-Key`
   * @returns the invoice with the transfer instructions (manual) or the checkout address (automatic), and whether it replayed a key
   * @throws {AppError} `VALIDATION_FAILED` on `gatewayId` or `amount` (`not_chargeable`: an automatic method that cannot charge the
   *   amount exactly, such as a card page for a third decimal); `CONFLICT` (409) when the account has five live unpaid
   *   top-up invoices (decision 049), before any gateway is asked; `GATEWAY_ERROR` (502) when the gateway fails: the invoice is voided;
   *   `IDEMPOTENCY_KEY_REUSED` and `IDEMPOTENCY_IN_PROGRESS` (409); `RANK_NOT_ALLOWED` (403) when the account is no longer of a merchant
   *   rank; `ACCOUNT_SUSPENDED` (403); `UNAUTHORIZED` when the account is gone
   */
  async createInvoice(
    accountId: number,
    input: { amount: string; gatewayId: number },
    key?: string,
  ): Promise<CreatedInvoiceAnswer> {
    const parsed = parseAmount(input.amount);
    if ('problem' in parsed) throw new AppError('VALIDATION_FAILED', { errors: [parsed.problem] });
    const fingerprint = topUpFingerprint(input.gatewayId, parsed.amount);
    const now = this.clock.now();
    const since = new Date(now.getTime() - MERCHANT_OPEN_TOPUPS.liveHours * 3_600_000);
    const vatRate = vatRateFrom(await this.settings.get(B2B_VAT_RATE_KEY));
    const dueDays = await this.settings.integer(
      INVOICE_DUE_DAYS_KEY,
      DEFAULT_INVOICE_DUE_DAYS,
      INVOICE_DUE_DAYS_BOUNDS,
    );
    const require3dsSetting = await this.settings.get(REQUIRE_3DS_KEY);

    const outcome = await this.db.runInTransaction(async (work) => {
      // Lock order (decision 064): the account row, then the account's top-up lock; the rank is read only after both.
      const merchant = assertMerchant(await this.accounts.lockForKeyShare(work.tx, accountId));
      await lockAccountTopUps(work.tx, accountId);
      if (key !== undefined) {
        const found = await judgeTopUpKey(work.tx, accountId, key, { fingerprint, walletKind: 'client_wallet' }, now);
        if (found?.verdict === 'reused') {
          throw new AppError('IDEMPOTENCY_KEY_REUSED', {
            detail: 'This Idempotency-Key was already used for another top-up.',
          });
        }
        if (found?.verdict === 'in_progress') throw new AppError('IDEMPOTENCY_IN_PROGRESS');
        if (found?.verdict === 'replay') {
          const gateway = await findGateway(work.tx, found.prior.gatewayId);
          return { kind: 'replay' as const, invoice: found.prior, gateway };
        }
        // The attempt that opened it never stored its page: void it (which frees the key) and start again with the same key.
        if (found?.verdict === 'restart') await voidUnpaidTopUp(work.tx, found.prior.id, now);
      }
      const { gateways, depositLimit } = await this.methodsOf(work.tx, merchant.groupId);
      const gateway = gateways.find((candidate) => candidate.id === input.gatewayId);
      if (!gateway) throw fieldError('gatewayId', 'unavailable', 'Choose one of your payment methods.');
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
      // Decision 049: the count and the insert run under the account's lock, so two requests at once cannot both pass the limit;
      // the refusal comes before the number is reserved and before any gateway page is opened.
      if (tooManyOpenTopUps(await countLiveMerchantTopUps(work.tx, accountId, since))) {
        throw new AppError('CONFLICT', { detail: OPEN_TOPUPS_DETAIL });
      }
      const totals = topupInvoiceTotals(
        parsed.amount,
        depositFee(parsed.amount, gateway.feePercent, gateway.feeFixed),
        vatRate,
      );
      const id = await reserveInvoiceId(work.tx);
      const created = await insertInvoice(work.tx, {
        id,
        number: invoiceNumber(now.getUTCFullYear(), id),
        accountId: merchant.id,
        walletKind: 'client_wallet',
        // The old column repeats the account while it lasts (the contract release drops it).
        legacyClientId: merchant.id,
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
        ...(key === undefined ? {} : { idempotencyKey: key, requestFingerprint: fingerprint }),
        dueAt: dueAtOf(now, dueDays),
        createdAt: now,
        updatedAt: now,
      });
      if (gateway.isManual) work.afterCommit(() => this.documents.render(created.id));
      return { kind: 'created' as const, invoice: created, gateway };
    });
    if (outcome.kind === 'replay') {
      return {
        answer: {
          invoice: merchantInvoiceToWire(outcome.invoice, gatewayRef(outcome.gateway)),
          ...(outcome.invoice.status === 'open' ? howToPay(outcome.invoice, outcome.gateway) : {}),
        },
        replayed: true,
      };
    }
    const { invoice, gateway } = outcome;
    if (gateway.isManual) {
      return {
        answer: { invoice: merchantInvoiceToWire(invoice, gatewayRef(gateway)), instructions: gateway.instructions },
        replayed: false,
      };
    }
    const require3ds = asks3ds(require3dsSetting, gateway.supports3ds);
    return { answer: await this.openCheckout(invoice, gateway, require3ds), replayed: false };
  }

  /**
   * Attaches a bank transfer receipt to an open invoice and queues the payment for staff review.
   *
   * Why: B163 and decision 049: one receipt, or a copy of its bytes, backs one pending or approved payment, whoever uploaded it; a
   * merchant has at most five receipts on top-up invoices waiting for review (checked under the merchant's top-up lock). The receipt is
   * a file the merchant uploaded itself (`POST /client/files`), never a document the platform stored for it (an invoice PDF). The bank
   * reference is compared and stored in one form (`normalizeBankReference`), holds printable ASCII characters only (`bankReferenceProblem`) and is
   * held by a pending or approved payment of the gateway only: a rejected claim releases it.
   *
   * Side effects: inserts one `payments` row; may set the invoice's gateway; takes the account row (`FOR KEY SHARE`), the account's top-up
   * lock (`topup:<accountId>`), the invoice row and the receipt content's lock until the commit (the lock order of decision 064).
   *
   * @param accountId the signed-in merchant account
   * @param invoiceId the invoice
   * @param input the receipt file, the bank reference and, for a staff-issued invoice, the manual method used
   * @returns the new pending payment
   * @throws {AppError} `NOT_FOUND`; `CONFLICT` when the invoice is not open, is paid online, or has a receipt waiting, or the
   *   merchant has five top-up receipts in review (decision 049); `VALIDATION_FAILED` on `fileId` (`invalid`: unknown, another owner's,
   *   not an upload, or not a PDF, JPEG or PNG; `taken`: the receipt, or a copy of it, backs a pending or approved payment, decision 049),
   *   `reference` (`length`; `invalid`: a character other than printable ASCII, `bankReferenceProblem`; `taken`: a pending or approved payment of the
   *   gateway holds it) or `gatewayId`
   */
  async uploadReceipt(
    accountId: number,
    invoiceId: number,
    input: { fileId: number; reference?: string | undefined; gatewayId?: number | undefined },
  ): Promise<WireMerchantPayment> {
    const reference = input.reference?.trim() ?? '';
    if (reference.length > MAX_REFERENCE) {
      throw fieldError('reference', 'length', `Keep the reference to ${MAX_REFERENCE} characters or fewer.`);
    }
    const bankReference = normalizeBankReference(reference);
    const referenceProblem = bankReferenceProblem(bankReference);
    if (referenceProblem) throw fieldError('reference', 'invalid', referenceProblem);
    try {
      const payment = await this.db.runInTransaction(async ({ tx }) => {
        // Decision 064 lock order, the one of both top-up creates: the account row, the account's top-up lock, the invoice row, then the
        // receipt content's lock. The payment's foreign key needs the account row too; taking it first means an upload never holds the
        // top-up lock or the invoice row while it waits for a rank change or an erasure that holds the row and waits for those.
        await this.accounts.lockForKeyShare(tx, accountId);
        await lockAccountTopUps(tx, accountId);
        const invoice = await findInvoiceOfAccount(tx, invoiceId, accountId, true);
        if (!invoice || !isMerchantInvoice(invoice)) throw notFound();
        if (invoice.status !== 'open') {
          throw new AppError('CONFLICT', {
            detail: invoice.status === 'paid' ? 'This invoice is already paid.' : 'This invoice was cancelled.',
          });
        }
        const gateway = await this.receiptGateway(tx, accountId, invoice, input.gatewayId);
        if ((await pendingPaymentsOfInvoice(tx, invoice.id)).length > 0) {
          throw new AppError('CONFLICT', { detail: 'A receipt for this invoice is waiting for review.' });
        }
        // Decision 049: counted under the account's top-up lock, taken above.
        if (invoice.kind === 'topup' && tooManyPendingReceipts(await countPendingTopUpReceipts(tx, accountId))) {
          throw new AppError('CONFLICT', { detail: PENDING_RECEIPTS_DETAIL });
        }
        const file = await this.files.findOwned(tx, input.fileId, { type: 'account', id: accountId });
        // Only the merchant's own upload: a document the platform stored for the merchant (an invoice PDF) is no transfer receipt.
        if (!file || file.area !== UPLOAD_AREA || !PROOF_MIME_TYPES.includes(file.mime)) {
          throw fieldError('fileId', 'invalid', 'Upload the receipt as a PDF, JPEG or PNG file first.');
        }
        if (bankReference !== '' && (await findLiveBankReference(tx, gateway.id, bankReference))) {
          throw fieldError('reference', 'taken', 'This reference was already used for this payment method.');
        }
        await assertReceiptUnused(tx, this.files, file.id);
        const now = this.clock.now();
        if (invoice.gatewayId === null) await updateInvoice(tx, invoice.id, { gatewayId: gateway.id, updatedAt: now });
        return insertPayment(tx, {
          purpose: 'topup',
          invoiceId: invoice.id,
          accountId: invoice.accountId,
          gatewayId: gateway.id,
          gatewayTxnId: bankReference === '' ? null : bankReference,
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
          // PORTAL_BASE_URL is the base of the account area (`https://<shop host>/account`, decision 064), so the buyer returns to `/account/wallet`.
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
    accountId: number,
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
    const account = await this.accounts.findById(tx, accountId);
    if (!account) throw new AppError('UNAUTHORIZED');
    const { gateways } = await this.methodsOf(tx, account.groupId);
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

  /** The gateways open to a rank (its group) and the group's limit per deposit. */
  private async methodsOf(db: DbExecutor, groupId: number) {
    const [gateways, group] = await Promise.all([listGatewaysForGroup(db, groupId), this.groups.find(db, groupId)]);
    return { gateways, depositLimit: group?.depositLimit ?? Money.zero().toWire() };
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
