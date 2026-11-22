// CustomerTopUps: a storefront customer tops up the store balance (feature 21, plan § 5.6.4): the methods, a new top-up with its limits and
// idempotency, the list and one top-up, the transfer receipt and the cancel. Crediting is the billing pipeline's (PaymentCrediting).
import { Inject, Injectable, Optional } from '@nestjs/common';
import type { z } from 'zod';
import { CLOCK, type Clock } from '../../../common/clock';
import type { ParsedListQuery } from '../../../common/contract';
import { AppError, type FieldError } from '../../../common/errors';
import { Money } from '../../../common/money';
import { APP_CONFIG, type AppConfig } from '../../../config';
import { type DbExecutor, DbService, isUniqueViolation } from '../../../infra/db';
import { OutboundHttp } from '../../../infra/http';
import { RateLimitService } from '../../../infra/rate-limit';
import { PROOF_MIME_TYPES, PublicImages, SettingsReader, StoredFiles } from '../../platform';
import type { TopUpDetailSchema } from '../contracts/customer-topups.contracts';
import { type Invoice, type Payment, type PaymentGateway, RECEIPT_LIVE_INDEX } from '../db/schema';
import { BASE_CURRENCY } from '../domain/accounts';
import { type CustomerWalletPolicy, checkTopUp, topUpStatusOf } from '../domain/customer-wallet-policy';
import { REQUIRE_3DS_KEY, asks3ds, checkChargeableAmount, depositFee, topupMethodOf } from '../domain/gateway-rules';
import {
  DEFAULT_INVOICE_DUE_DAYS,
  INVOICE_DUE_DAYS_BOUNDS,
  INVOICE_DUE_DAYS_KEY,
  dueAtOf,
  invoiceNumber,
  parseAmount,
  topupInvoiceTotals,
} from '../domain/invoice-rules';
import {
  findCustomerTopUp,
  findTopUpByKey,
  latestPaymentsOf,
  listCustomerTopUps,
  listTopUpGateways,
  lockCustomerTopUps,
  storeTopUpCheckoutUrl,
  voidUnpaidTopUp,
} from '../infra/customer-topup.repository';
import { readCustomerWallet, readTopUpFigures } from '../infra/customer-wallet.repository';
import { findWalletCustomer } from '../infra/foreign-directory.repository';
import { GATEWAY_HTTP_POLICY, type GatewayHttpPolicy } from '../infra/gateway-drivers/driver';
import { driverFor } from '../infra/gateway-drivers/drivers';
import { findGateway, findGatewaysByIds } from '../infra/gateway.repository';
import { insertInvoice, reserveInvoiceId, updateInvoice } from '../infra/invoice.repository';
import { findPaymentByReference, insertPayment, pendingPaymentsOfInvoice } from '../infra/payment.repository';
import { type WirePaymentMethod, paymentMethodToWire } from './billing-wire';
import { CustomerWallets } from './customer-wallets';
import { GatewayCredentialsVault } from './gateway-credentials';
import { assertReceiptUnused, receiptTaken } from './receipt-proofs';
import { TopUpScreeningHooks } from './top-up-screening-hooks';

/** A top-up on the store wire, with how to pay it while it awaits payment. */
export type TopUpDetail = z.output<typeof TopUpDetailSchema>;

/** The answer of a create: the top-up and whether it was a replay of the same `Idempotency-Key`. */
export interface CreatedTopUp {
  readonly topUp: TopUpDetail;
  readonly replayed: boolean;
}

/** How long an automatic top-up may wait for its hosted page before a retry with its key takes over (the `/pay` rule). */
const OPENING_GRACE_MS = 60_000;
const MAX_REFERENCE = 64;

const fieldError = (field: string, code: string, message: string) =>
  new AppError('VALIDATION_FAILED', { errors: [{ field, code, message } satisfies FieldError] });
const notFound = () => new AppError('NOT_FOUND', { detail: 'No top-up with this id.' });

/** The fingerprint of a create request: the same key with another gateway or amount is refused. */
function fingerprintOf(gatewayId: number, amount: Money): string {
  return JSON.stringify([gatewayId, amount.toWire()]);
}

/** Whether a customer may top up through a gateway under the policy: manual ones always, automatic ones with a driver while card top-ups are on. */
function offered(gateway: PaymentGateway, policy: CustomerWalletPolicy): boolean {
  if (!gateway.isActive || gateway.audience === 'b2b') return false;
  return gateway.isManual || (policy.cardTopUps && driverFor(gateway.driver) !== undefined);
}

/**
 * Builds a top-up for the store.
 *
 * @param invoice the top-up invoice
 * @param gateway its gateway
 * @param payment its newest payment, if any
 * @returns the store's top-up, with the instructions or the payment page while it awaits payment
 */
function topUpToWire(invoice: Invoice, gateway: PaymentGateway | undefined, payment: Payment | undefined): TopUpDetail {
  const status = topUpStatusOf(invoice.status, payment?.status ?? null);
  const manual = gateway?.isManual ?? true;
  const how =
    status !== 'awaiting_payment'
      ? {}
      : manual
        ? { instructions: gateway?.instructions ?? '' }
        : invoice.checkoutUrl
          ? { paymentUrl: invoice.checkoutUrl }
          : {};
  return {
    id: invoice.id,
    number: invoice.number,
    status,
    amount: invoice.amount,
    fee: invoice.fee,
    netAmount: invoice.netAmount,
    currency: invoice.currency,
    method: {
      id: gateway?.id ?? invoice.gatewayId ?? 0,
      code: gateway?.code ?? '',
      name: gateway?.name ?? '',
      kind: manual ? 'manual' : 'automatic',
      methodType: topupMethodOf(gateway?.driver ?? 'manual', manual),
    },
    reference: payment?.gatewayTxnId ?? null,
    receiptUploaded: payment?.receiptFileId != null,
    rejectionReason: status === 'rejected' ? (payment?.reviewNote ?? null) : null,
    createdAt: invoice.createdAt.toISOString(),
    creditedAt: invoice.paidAt ? invoice.paidAt.toISOString() : null,
    ...how,
  };
}

/**
 * Lets a signed-in customer top up the store balance.
 *
 * Why: the owner's customer wallet (ROADMAP 2W, lead rule L5): top-ups through the shop's payment gateways, manual (bank, CliQ) first and
 * cards behind a second switch, within the owner's limits. A top-up is a `topup` invoice of the customer; the customer's receipt or the
 * gateway's confirmation creates the payment that staff (or the automatic credit) turn into a credit, exactly like a merchant's deposit.
 * Every customer id comes from the session (plan § 5.1 invariant 5). The limits are checked under a per-customer advisory lock; the Redis
 * limiter is only a hint. Decision 049: one receipt, or a copy of its bytes, backs one pending or approved payment, whoever uploaded it,
 * and a card page asks for 3-D Secure under the shop's `require3ds` policy.
 *
 * Side effects: `create` inserts an `invoices` row (and may call a gateway's API, then store its page); `attachReceipt` inserts a
 * `payments` row; `cancel` voids an invoice.
 */
@Injectable()
export class CustomerTopUps {
  constructor(
    private readonly db: DbService,
    private readonly wallets: CustomerWallets,
    private readonly settings: SettingsReader,
    private readonly vault: GatewayCredentialsVault,
    private readonly files: StoredFiles,
    private readonly screening: TopUpScreeningHooks,
    private readonly limits: RateLimitService,
    private readonly http: OutboundHttp,
    private readonly images: PublicImages,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    @Optional() @Inject(GATEWAY_HTTP_POLICY) private readonly policy?: GatewayHttpPolicy,
  ) {}

  /**
   * The methods the customer may top up through, with the effective limits.
   *
   * @param query the parsed list request (`name` sort)
   * @returns the methods (none while the balance is switched off), each with its `preset` and the `logoUrl` of an uploaded logo
   */
  async methods(query: ParsedListQuery<'name'>): Promise<{ rows: WirePaymentMethod[]; total: number }> {
    const policy = await this.wallets.policy();
    if (!policy.enabled) return { rows: [], total: 0 };
    const gateways = (await listTopUpGateways(this.db.db)).filter((gateway) => offered(gateway, policy));
    const logos = await this.images.urlsOf(
      this.db.db,
      gateways.map((gateway) => gateway.logoFileId),
    );
    const rows = gateways.map((gateway) => {
      const wire = paymentMethodToWire(gateway, policy.maxTopUp.toWire(), logos.get(gateway.logoFileId ?? 0) ?? null);
      const min = Money.of(gateway.minAmount);
      return {
        ...wire,
        minAmount: (min.cmp(policy.minTopUp) > 0 ? min : policy.minTopUp).toWire(),
        currency: BASE_CURRENCY,
      };
    });
    if (query.sort[0]?.order === 'desc') rows.reverse();
    return { rows, total: rows.length };
  }

  /**
   * Starts a top-up.
   *
   * Why: plan 21 § 5.6.4: one transaction under the customer's advisory lock checks the key, the customer, the gateway and the limits and
   * inserts the invoice; an automatic gateway is asked for its page after the commit (no network call under a lock), and a gateway that
   * fails voids the invoice and frees its key.
   *
   * Side effects: inserts one `invoices` row; an automatic gateway's API is called and the page stored; consumes the `wallet-topup` limiter.
   *
   * @param customerId the authenticated customer
   * @param input the amount and the gateway
   * @param key the `Idempotency-Key`
   * @returns the top-up with its instructions or page, and whether it was a replay
   * @throws {AppError} `WALLET_DISABLED`, `RATE_LIMITED`, `VALIDATION_FAILED` (`amount`: `format`, `range`, `min`, `max`, `fee`,
   *   `daily_count`, `daily_amount`, `max_balance`, `not_chargeable` (an automatic method that cannot charge the amount exactly);
   *   `gatewayId`: `unavailable`), `CONFLICT` (three unpaid top-ups), `WALLET_FROZEN`,
   *   `IDEMPOTENCY_KEY_REUSED`, `IDEMPOTENCY_IN_PROGRESS`, `UNAUTHORIZED` (no active account), `GATEWAY_ERROR`
   */
  async create(customerId: number, input: { amount: string; gatewayId: number }, key: string): Promise<CreatedTopUp> {
    const policy = await this.wallets.policy();
    if (!policy.enabled) throw new AppError('WALLET_DISABLED');
    await this.limits.enforce('wallet-topup', String(customerId));
    const parsed = parseAmount(input.amount);
    if ('problem' in parsed) throw new AppError('VALIDATION_FAILED', { errors: [parsed.problem] });
    const amount = parsed.amount;
    const fingerprint = fingerprintOf(input.gatewayId, amount);
    const dueDays = await this.settings.integer(
      INVOICE_DUE_DAYS_KEY,
      DEFAULT_INVOICE_DUE_DAYS,
      INVOICE_DUE_DAYS_BOUNDS,
    );

    const outcome = await this.db.runInTransaction(async ({ tx }) => {
      await lockCustomerTopUps(tx, customerId);
      const now = this.clock.now();
      const prior = await findTopUpByKey(tx, customerId, key);
      if (prior) {
        if (prior.requestFingerprint !== fingerprint) {
          throw new AppError('IDEMPOTENCY_KEY_REUSED', {
            detail: 'This Idempotency-Key was already used for another top-up.',
          });
        }
        const opening = prior.status === 'open' && prior.checkoutUrl === null && !(await this.isManual(tx, prior));
        if (!opening) return { kind: 'replay' as const, invoice: prior };
        if (now.getTime() - prior.createdAt.getTime() < OPENING_GRACE_MS) throw new AppError('IDEMPOTENCY_IN_PROGRESS');
        // The attempt that opened it never stored its page: void it and start again with the same key.
        await voidUnpaidTopUp(tx, prior.id, now);
      }
      const customer = await findWalletCustomer(tx, customerId);
      if (!customer || customer.status !== 'active' || !customer.hasAccount) throw new AppError('UNAUTHORIZED');
      const gateway = await findGateway(tx, input.gatewayId);
      if (!gateway || !offered(gateway, policy)) {
        throw fieldError('gatewayId', 'unavailable', 'Choose one of the top-up methods.');
      }
      const wallet = await readCustomerWallet(tx, customerId);
      if (!gateway.isManual && wallet?.frozenAt) throw new AppError('WALLET_FROZEN');
      const fee = depositFee(amount, gateway.feePercent, gateway.feeFixed);
      const figures = await readTopUpFigures(tx, customerId, now);
      const refusal = checkTopUp(
        {
          amount,
          fee,
          gatewayMin: gateway.minAmount,
          gatewayMax: gateway.maxAmount,
          balance: Money.of(wallet?.balance ?? '0'),
          liveOpenCount: figures.pendingCount,
          pendingNet: Money.of(figures.pendingNet),
          dayCount: figures.dayCount,
          dayAmount: Money.of(figures.dayAmount),
        },
        policy,
      );
      if (refusal) {
        if ('conflict' in refusal) throw new AppError('CONFLICT', { detail: refusal.conflict });
        throw new AppError('VALIDATION_FAILED', { errors: [refusal.field] });
      }
      // An automatic method that cannot charge this amount exactly would charge it rounded: refused before a top-up is reserved.
      const unchargeable = gateway.isManual
        ? undefined
        : checkChargeableAmount(amount, driverFor(gateway.driver)?.maxChargeDecimals?.(BASE_CURRENCY));
      if (unchargeable) throw new AppError('VALIDATION_FAILED', { errors: [unchargeable] });
      // Stored value carries no VAT (O9): the tax rate is 0 and the invoice has no PDF.
      const totals = topupInvoiceTotals(amount, fee, '0');
      const id = await reserveInvoiceId(tx);
      const invoice = await insertInvoice(tx, {
        id,
        number: invoiceNumber(now.getUTCFullYear(), id),
        customerId,
        kind: 'topup',
        amount: totals.amount.toWire(),
        fee: totals.fee.toWire(),
        netAmount: totals.net.toWire(),
        taxAmount: '0',
        taxRate: '0',
        total: totals.total.toWire(),
        currency: BASE_CURRENCY,
        status: 'open',
        gatewayId: gateway.id,
        idempotencyKey: key,
        requestFingerprint: fingerprint,
        description: 'Store balance top-up',
        dueAt: dueAtOf(now, dueDays),
        createdAt: now,
        updatedAt: now,
      });
      return { kind: 'created' as const, invoice, gateway };
    });

    if (outcome.kind === 'replay') return { topUp: await this.wireOf(this.db.db, outcome.invoice), replayed: true };
    const { invoice, gateway } = outcome;
    if (gateway.isManual) return { topUp: topUpToWire(invoice, gateway, undefined), replayed: false };
    return { topUp: await this.openCheckout(invoice, gateway), replayed: false };
  }

  /**
   * The customer's top-ups.
   *
   * @param customerId the authenticated customer
   * @param query the parsed list request
   * @returns the page and the total
   */
  async list(customerId: number, query: ParsedListQuery<'createdAt'>): Promise<{ rows: TopUpDetail[]; total: number }> {
    const db = this.db.db;
    const page = await listCustomerTopUps(db, customerId, query);
    const gateways = await findGatewaysByIds(
      db,
      page.rows.map((row) => row.gatewayId),
    );
    const payments = await latestPaymentsOf(
      db,
      page.rows.map((row) => row.id),
    );
    return {
      total: page.total,
      rows: page.rows.map((row) => {
        const {
          instructions: _instructions,
          paymentUrl: _paymentUrl,
          ...topUp
        } = topUpToWire(row, row.gatewayId === null ? undefined : gateways.get(row.gatewayId), payments.get(row.id));
        return topUp;
      }),
    };
  }

  /**
   * One of the customer's top-ups.
   *
   * @param customerId the authenticated customer
   * @param id the top-up
   * @returns the top-up with how to pay it
   * @throws {AppError} `NOT_FOUND` (unknown, or another customer's)
   */
  async get(customerId: number, id: number): Promise<TopUpDetail> {
    const invoice = await findCustomerTopUp(this.db.db, customerId, id);
    if (!invoice) throw notFound();
    return this.wireOf(this.db.db, invoice);
  }

  /**
   * Attaches the receipt of a manual transfer and queues the top-up for staff review.
   *
   * Why: plan 21 § 5.6.4: the merchant receipt flow for a customer. The file must be the customer's own upload; a bank reference is unique
   * per gateway; the receipt, or a copy of its bytes, must not back another pending or approved payment (decision 049). Sending the same
   * receipt again is a retry and answers the top-up. Manual top-ups always wait for staff; a risk hit only
   * writes its reason as a hint. Allowed while the balance is switched off (the money may already be on its way, P6).
   *
   * Side effects: inserts one `payments` row (`pending`); takes the receipt content's lock until the commit.
   *
   * @param customerId the authenticated customer
   * @param id the top-up
   * @param input the receipt file and the optional bank reference
   * @returns the top-up, now in review
   * @throws {AppError} `NOT_FOUND`; `CONFLICT` (not open, online, another receipt in review); `VALIDATION_FAILED` on `fileId` (`invalid`,
   *   `taken`: decision 049) or `reference` (`length`, `taken`)
   */
  async attachReceipt(
    customerId: number,
    id: number,
    input: { fileId: number; reference?: string | undefined },
  ): Promise<TopUpDetail> {
    const reference = input.reference?.trim() ?? '';
    if (reference.length > MAX_REFERENCE) {
      throw fieldError('reference', 'length', `Keep the reference to ${MAX_REFERENCE} characters or fewer.`);
    }
    try {
      return await this.db.runInTransaction(async ({ tx }) => {
        const invoice = await findCustomerTopUp(tx, customerId, id, true);
        if (!invoice) throw notFound();
        if (invoice.status !== 'open') {
          throw new AppError('CONFLICT', {
            detail: invoice.status === 'paid' ? 'This top-up is already credited.' : 'This top-up was closed.',
          });
        }
        const gateway = await findGateway(tx, invoice.gatewayId);
        if (!gateway) throw new Error(`Top-up ${invoice.number} points at a gateway that does not exist.`);
        if (!gateway.isManual)
          throw new AppError('CONFLICT', { detail: 'An online top-up is paid on its payment page.' });
        const pending = await pendingPaymentsOfInvoice(tx, invoice.id);
        if (pending.some((payment) => payment.receiptFileId === input.fileId)) return this.wireOf(tx, invoice);
        if (pending.length > 0)
          throw new AppError('CONFLICT', { detail: 'A receipt for this top-up is waiting for review.' });
        const file = await this.files.findOwned(tx, input.fileId, { type: 'customer', id: customerId });
        if (!file || !PROOF_MIME_TYPES.includes(file.mime)) {
          throw fieldError('fileId', 'invalid', 'Upload the receipt as a PDF, JPEG or PNG file first.');
        }
        if (reference !== '' && (await findPaymentByReference(tx, gateway.id, reference))) {
          throw fieldError('reference', 'taken', 'This reference was already used for this payment method.');
        }
        await assertReceiptUnused(tx, this.files, file.id);
        const customer = await findWalletCustomer(tx, customerId);
        const verdict = await this.screening.screen(tx, { email: customer?.email ?? null, cardFingerprint: null });
        const now = this.clock.now();
        await insertPayment(tx, {
          purpose: 'topup',
          invoiceId: invoice.id,
          customerId,
          gatewayId: gateway.id,
          gatewayTxnId: reference === '' ? null : reference,
          amount: invoice.amount,
          feeAmount: invoice.fee,
          currency: invoice.currency,
          status: 'pending',
          methodType: topupMethodOf(gateway.driver, true),
          receiptFileId: file.id,
          reviewNote: verdict.flagged ? verdict.reason : null,
          createdAt: now,
          updatedAt: now,
        });
        return this.wireOf(tx, invoice);
      });
    } catch (error) {
      // Two receipts passed the checks together: the unique indexes decide (the receipt file first, then the bank reference).
      if (isUniqueViolation(error, RECEIPT_LIVE_INDEX)) throw receiptTaken();
      if (isUniqueViolation(error)) {
        throw fieldError('reference', 'taken', 'This reference was already used for this payment method.');
      }
      throw error;
    }
  }

  /**
   * Cancels a manual top-up that has no receipt yet.
   *
   * Why: plan P8: a customer clears an unpaid top-up instead of waiting for a cleanup job. An online top-up closes by itself (a confirmation
   * for a closed invoice would not be recorded), a credited one or one in review cannot be cancelled. Cancelling twice answers the same.
   *
   * Side effects: sets the invoice `void` (its key stays, so a retry of the create answers the cancelled top-up).
   *
   * @param customerId the authenticated customer
   * @param id the top-up
   * @returns the cancelled top-up
   * @throws {AppError} `NOT_FOUND`; `CONFLICT`
   */
  async cancel(customerId: number, id: number): Promise<TopUpDetail> {
    return this.db.runInTransaction(async ({ tx }) => {
      const invoice = await findCustomerTopUp(tx, customerId, id, true);
      if (!invoice) throw notFound();
      if (invoice.status === 'void') return this.wireOf(tx, invoice);
      if (invoice.status === 'paid') throw new AppError('CONFLICT', { detail: 'This top-up is already credited.' });
      if (!(await this.isManual(tx, invoice))) {
        throw new AppError('CONFLICT', { detail: 'An online top-up closes by itself.' });
      }
      if ((await pendingPaymentsOfInvoice(tx, invoice.id)).length > 0) {
        throw new AppError('CONFLICT', { detail: 'A receipt for this top-up is waiting for review.' });
      }
      const cancelled = await updateInvoice(tx, invoice.id, { status: 'void', updatedAt: this.clock.now() });
      return this.wireOf(tx, cancelled);
    });
  }

  /** Asks an automatic gateway for its page and stores it; a failure voids the top-up and frees its key. */
  private async openCheckout(invoice: Invoice, gateway: PaymentGateway): Promise<TopUpDetail> {
    const driver = driverFor(gateway.driver);
    try {
      // Decision 049: a card top-up asks for 3-D Secure under the same policy as a shop card payment.
      const require3ds = asks3ds(await this.settings.get(REQUIRE_3DS_KEY), gateway.supports3ds);
      if (!driver)
        throw new AppError('GATEWAY_ERROR', { detail: `${gateway.name} has no driver that can open a checkout.` });
      const { paymentUrl } = await driver.createCheckout(
        { http: this.http, policy: this.policy },
        this.vault.read(gateway),
        {
          invoiceNumber: invoice.number,
          amount: Money.of(invoice.amount),
          currency: BASE_CURRENCY,
          description: `Store balance top-up ${invoice.number}`,
          returnUrl: `${this.config.http.storeBaseUrl}/account/wallet?topUp=${invoice.id}`,
          idempotencyKey: invoice.number,
          require3ds,
        },
      );
      const stored = await this.db.runInTransaction(({ tx }) =>
        storeTopUpCheckoutUrl(tx, invoice.id, paymentUrl, this.clock.now()),
      );
      return topUpToWire(stored ?? invoice, gateway, undefined);
    } catch (error) {
      await this.db.runInTransaction(({ tx }) => voidUnpaidTopUp(tx, invoice.id, this.clock.now()));
      if (error instanceof AppError && error.code === 'GATEWAY_ERROR') throw error;
      throw new AppError('GATEWAY_ERROR', { detail: `${gateway.name} could not open the payment page.` });
    }
  }

  private async isManual(db: DbExecutor, invoice: Invoice): Promise<boolean> {
    return (await findGateway(db, invoice.gatewayId))?.isManual ?? true;
  }

  private async wireOf(db: DbExecutor, invoice: Invoice): Promise<TopUpDetail> {
    const gateway = await findGateway(db, invoice.gatewayId);
    const payment = (await latestPaymentsOf(db, [invoice.id])).get(invoice.id);
    return topUpToWire(invoice, gateway, payment);
  }
}
