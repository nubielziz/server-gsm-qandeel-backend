// StorefrontPayments: the money side of paying a storefront checkout (feature 16): opening the gateway's hosted page, and recording a
// confirmed payment (the payment row, the `b2c_pay` and `b2c_fee` journals and the tax receipt invoice).
import { Inject, Injectable, Optional } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import { AppError } from '../../../common/errors';
import { Money } from '../../../common/money';
import { OutboundHttp } from '../../../infra/http';
import { DbService, type DbExecutor } from '../../../infra/db';
import type { Order } from '../../orders';
import type { Invoice, Payment, PaymentGateway } from '../db/schema';
import { b2cPaymentMethod, fromUsd, gatewayFeeUsd, paymentFacts, payRequestFingerprint } from '../domain/b2c-money';
import { invoiceNumber } from '../domain/invoice-rules';
import { b2cFee, b2cPay } from '../domain/money-events';
import { GATEWAY_HTTP_POLICY, type GatewayHttpPolicy, type PaymentEvent } from '../infra/gateway-drivers/driver';
import { driverFor } from '../infra/gateway-drivers/drivers';
import { findGateway, findGatewayByCode } from '../infra/gateway.repository';
import { insertInvoice, reserveInvoiceId } from '../infra/invoice.repository';
import { orderForRefund } from '../infra/b2c-reads.repository';
import {
  CAPTURED_STATUSES,
  findOrderPayment,
  findPaymentByKey,
  insertOrderPayment,
  reservePaymentId,
  tryLockPayKey,
  updateOrderPayment,
  updateOrderPaymentIn,
} from '../infra/order-payment.repository';
import { paymentRef } from '../domain/invoice-rules';
import { B2cRefunds } from './b2c-refunds';
import { GatewayCredentialsVault } from './gateway-credentials';
import { LedgerPoster } from './post-transaction';
import { ReceiptOutbox } from './receipt-outbox';

/** What the checkout session locked, as recording a capture needs it. */
export interface CapturedSession {
  readonly currency: string;
  readonly fxRate: string;
  readonly taxRate: string;
  readonly taxCountry: string | null;
  /** The currency's fraction digits. */
  readonly decimals: number;
}

/** What the customers module hands over to open a payment. */
export interface StartPaymentInput {
  readonly sessionId: number;
  readonly customerId: number;
  /** The `Idempotency-Key` header of the call. */
  readonly key: string;
  /** The `code` of the gateway the buyer chose. */
  readonly gatewayCode: string;
  readonly returnUrl: string;
  /** What the buyer pays (the gross in their currency, as the checkout shows) and in which currency. */
  readonly amount: Money;
  readonly currency: string;
  /** The gross in USD, to judge the gateway's limits. */
  readonly grossUsd: Money;
  /** The text of the hosted page. */
  readonly description: string;
  /** Whether the shop asks for 3-D Secure. */
  readonly require3ds: boolean;
}

/** The payment a pay call opened, as the route answers (and answers again on a replay). */
export interface StartedPayment {
  readonly payment: {
    readonly id: number;
    readonly reference: string;
    readonly status: string;
    readonly method: 'card' | 'wallet' | 'crypto';
    readonly currency: string;
    readonly amount: string;
  };
  readonly gateway: { readonly code: string; readonly name: string; readonly supports3ds: boolean };
  readonly paymentUrl: string;
  /** True when the answer is the stored one of an earlier call with the same key. */
  readonly replayed: boolean;
}

/** How long a payment may sit without its hosted page before a retry with the same key starts over (a crashed call). */
const ABANDONED_AFTER_MS = 60_000;

/** The columns of the order a capture needs. */
export type CapturedOrder = Pick<Order, 'id' | 'customerId' | 'totalPrice' | 'taxAmount'>;

/** What recording a capture decided. */
export interface RecordedCapture {
  readonly method: 'card' | 'wallet' | 'crypto';
  readonly brand: string;
  /** The receipt invoice the capture issued; `null` for a duplicate payment, which gets none (the order has its receipt already). */
  readonly invoiceId: number | null;
}

/**
 * Opens storefront checkouts at the gateway and records captured payments.
 *
 * Why: scenario b2c-paid steps 4, 7 and 8, RESOLUTIONS money-2, money-4, money-7 and b2c-5: the gateway is asked for a hosted page for
 * the session's gross in the buyer's currency; a confirmation posts `b2c_pay` (Dr gateway_clearing gross, Cr customer_funds net, Cr
 * vat_payable VAT, ref `order`, key `payment:<id>:capture`) and `b2c_fee` (key `payment:<id>:fee`) in the session's locked USD, stores
 * the brand line, the card fingerprint and 3-D Secure flag the driver read, and issues the paid tax receipt invoice (kind `receipt`:
 * net, VAT, rate and country as the session locked them). The PDF is drawn once by the `receipt.render` job (`OrderReceipts`), queued in the
 * same transaction. An order has one paid receipt: a duplicate payment for it is booked and refunded but issues none.
 *
 * Side effects: `openCheckout` calls the gateway; `recordCapture` updates `payments`, writes two ledger transactions and inserts one
 * `invoices` row and one `receipt.render` outbox row (none for a duplicate), all on the caller's transaction.
 */
@Injectable()
export class StorefrontPayments {
  constructor(
    private readonly db: DbService,
    private readonly vault: GatewayCredentialsVault,
    private readonly http: OutboundHttp,
    private readonly poster: LedgerPoster,
    private readonly refunds: B2cRefunds,
    private readonly receipts: ReceiptOutbox,
    @Inject(CLOCK) private readonly clock: Clock,
    @Optional() @Inject(GATEWAY_HTTP_POLICY) private readonly policy?: GatewayHttpPolicy,
  ) {}

  /**
   * Opens a payment for a checkout: one pending payment per `Idempotency-Key`, and the gateway's hosted page for it.
   *
   * Why: scenario b2c-paid steps 4 and 5, ALIGNMENT § 7: `Idempotency-Key` is required on `/pay`. The key is kept on the payment row (unique
   * per checkout) together with the request's fingerprint (its own column, so capture, failure and review never overwrite it): the same key
   * and the same request answer the same payment and page again, whatever became of the payment since (`status` says `captured`, `failed` or
   * `pending`); another gateway or return address under the key is `409 IDEMPOTENCY_KEY_REUSED`; a call still opening its page is `409
   * IDEMPOTENCY_IN_PROGRESS`, and one whose page is still empty after a minute (or whose payment was written off) is freed and starts over.
   * The payment id is reserved and the row written first (under a non-waiting lock of the key), the gateway is asked outside any
   * transaction, and a gateway that refuses marks the payment `failed` and frees the key. If the payment was written off while the gateway
   * answered, its page is not handed out. Nothing is ever captured here: only the gateway's confirmation does that.
   *
   * Side effects: inserts a `payments` row (`pending`), calls the gateway, updates the row with the page's address or marks it failed; a
   * replay that restarts a dead call marks the old payment `failed` and frees its key.
   *
   * @param input the checkout, the buyer's choice and the amounts
   * @param guard checks the checkout may be paid now (open, customer active, consents given); skipped on a replay
   * @returns the payment, the gateway and the address to pay at
   * @throws {AppError} whatever the guard throws; `VALIDATION_FAILED` on `gateway` (not offered, over or under its limits);
   *   `IDEMPOTENCY_KEY_REUSED`, `IDEMPOTENCY_IN_PROGRESS` (409); `INVALID_TRANSITION` (409) when the payment was closed while its page was
   *   opening; `GATEWAY_ERROR` (502) when the gateway cannot open the page
   */
  async start(input: StartPaymentInput, guard: () => Promise<void>): Promise<StartedPayment> {
    const fingerprint = payRequestFingerprint(input.gatewayCode, input.returnUrl);
    const prior = await this.replay(input, fingerprint);
    if (prior) return prior;
    await guard();
    const gateway = await findGatewayByCode(this.db.db, input.gatewayCode);
    const driver = gateway ? driverFor(gateway.driver) : undefined;
    const offered = gateway?.isActive && !gateway.isManual && gateway.audience !== 'b2b' && driver !== undefined;
    if (!gateway || !driver || !offered) {
      throw new AppError('VALIDATION_FAILED', {
        errors: [{ field: 'gateway', code: 'not_offered', message: 'This payment method is not available.' }],
      });
    }
    const min = Money.of(gateway.minAmount);
    const max = Money.of(gateway.maxAmount);
    if (input.grossUsd.cmp(min) < 0 || (max.isPositive() && input.grossUsd.cmp(max) > 0)) {
      throw new AppError('VALIDATION_FAILED', {
        errors: [{ field: 'gateway', code: 'out_of_range', message: 'This payment method does not take this amount.' }],
      });
    }
    const id = await reservePaymentId(this.db.db);
    const now = this.clock.now();
    await this.db.runInTransaction(async ({ tx }) => {
      if (!(await tryLockPayKey(tx, input.sessionId, input.key))) throw inProgress();
      if (await findPaymentByKey(tx, input.sessionId, input.key)) throw inProgress();
      await insertOrderPayment(tx, {
        id,
        purpose: 'order',
        customerId: input.customerId,
        checkoutSessionId: input.sessionId,
        idempotencyKey: input.key,
        gatewayId: gateway.id,
        amount: input.amount.toWire(),
        currency: input.currency,
        status: 'pending',
        methodType: b2cPaymentMethod(driver.methodType),
        requestFingerprint: fingerprint,
        createdAt: now,
        updatedAt: now,
      });
    });
    let paymentUrl: string;
    try {
      ({ paymentUrl } = await this.openCheckout(gateway, {
        reference: paymentRef(id),
        amount: input.amount,
        currency: input.currency,
        description: input.description,
        returnUrl: input.returnUrl,
        require3ds: input.require3ds && gateway.supports3ds,
        // The payment's own reference: a retried call for this payment never opens a second page at the gateway.
        idempotencyKey: paymentRef(id),
      }));
    } catch (error) {
      await this.db.runInTransaction(async ({ tx }) => {
        await updateOrderPaymentIn(tx, id, ['pending'], {
          status: 'failed',
          idempotencyKey: null,
          updatedAt: this.clock.now(),
        });
      });
      throw error;
    }
    // Keep the page on the payment unless the payment was written off while the gateway answered (a replay restarted it after a minute, or
    // the gateway already said failed): a page for a failed payment is never handed to the buyer.
    const stored = await this.db.runInTransaction(async ({ tx }) =>
      updateOrderPaymentIn(tx, id, ['pending', ...CAPTURED_STATUSES], {
        checkoutUrl: paymentUrl,
        updatedAt: this.clock.now(),
      }),
    );
    if (!stored) {
      throw new AppError('INVALID_TRANSITION', {
        detail: 'This payment was closed while its page was opening. Start the payment again.',
      });
    }
    return {
      payment: {
        id,
        reference: paymentRef(id),
        status: stored.status,
        method: b2cPaymentMethod(driver.methodType),
        currency: input.currency,
        amount: input.amount.toWire(),
      },
      gateway: { code: gateway.code, name: gateway.name, supports3ds: gateway.supports3ds },
      paymentUrl,
      replayed: false,
    };
  }

  /** The stored answer of an earlier call with the same key, `undefined` when there is none (or it crashed and starts over). */
  private async replay(input: StartPaymentInput, fingerprint: string): Promise<StartedPayment | undefined> {
    const prior = await findPaymentByKey(this.db.db, input.sessionId, input.key);
    if (!prior) return undefined;
    // The fingerprint has its own column: capture, failure and review overwrite `raw`, and a replay after them must still match.
    if (prior.requestFingerprint !== fingerprint) {
      throw new AppError('IDEMPOTENCY_KEY_REUSED', {
        detail: 'This Idempotency-Key was already used for a different request. Use a new key for a new request.',
      });
    }
    if (prior.checkoutUrl === null) {
      const opening = prior.status === 'pending';
      if (opening && this.clock.now().getTime() - prior.createdAt.getTime() < ABANDONED_AFTER_MS) throw inProgress();
      // The call that opened it died before the gateway answered (or its payment was written off meanwhile): free the key and start over.
      await this.db.runInTransaction(async ({ tx }) => {
        await updateOrderPaymentIn(tx, prior.id, ['pending', 'failed'], {
          status: 'failed',
          idempotencyKey: null,
          updatedAt: this.clock.now(),
        });
      });
      return undefined;
    }
    const gateway = await findGateway(this.db.db, prior.gatewayId);
    return {
      payment: {
        id: prior.id,
        reference: paymentRef(prior.id),
        status: prior.status,
        method: b2cPaymentMethod(prior.methodType),
        currency: prior.currency,
        amount: prior.amount,
      },
      gateway: {
        code: gateway?.code ?? input.gatewayCode,
        name: gateway?.name ?? '',
        supports3ds: gateway?.supports3ds ?? false,
      },
      paymentUrl: prior.checkoutUrl,
      replayed: true,
    };
  }

  /**
   * Asks the gateway for a hosted checkout.
   *
   * @param gateway the gateway row
   * @param request the reference (`PAY-<id>`), the amount in the buyer's currency, the page text and the return address
   * @returns the address the buyer pays at
   * @throws {AppError} `GATEWAY_ERROR` when the gateway has no driver or the call fails
   */
  async openCheckout(
    gateway: PaymentGateway,
    request: {
      reference: string;
      amount: Money;
      currency: string;
      description: string;
      returnUrl: string;
      require3ds: boolean;
      idempotencyKey?: string | undefined;
    },
  ): Promise<{ paymentUrl: string }> {
    const driver = driverFor(gateway.driver);
    if (!driver)
      throw new AppError('GATEWAY_ERROR', { detail: `${gateway.name} has no driver that can open a checkout.` });
    return driver.createCheckout({ http: this.http, policy: this.policy }, this.vault.read(gateway), {
      invoiceNumber: request.reference,
      amount: request.amount,
      currency: request.currency,
      description: request.description,
      returnUrl: request.returnUrl,
      require3ds: request.require3ds,
      idempotencyKey: request.idempotencyKey,
    });
  }

  /**
   * Records a confirmed payment of an order that now exists.
   *
   * Why: an order has one paid receipt. The payment that created the order issues it (and queues its PDF); a duplicate payment for the same
   * order (`receipt: false`) posts its journals and is marked captured like any payment, but issues no second receipt.
   *
   * @param tx the capture's transaction (the payment row is locked)
   * @param input the payment, its gateway, the event, the order the capture created, what the session locked, and whether to issue the
   *   receipt (default true)
   * @returns the method and brand line stored, and the receipt invoice (`null` when none was issued)
   */
  async recordCapture(
    tx: DbExecutor,
    input: {
      payment: Payment;
      gateway: PaymentGateway;
      event: PaymentEvent;
      order: CapturedOrder;
      session: CapturedSession;
      receipt?: boolean;
    },
  ): Promise<RecordedCapture> {
    const { payment, gateway, event, order, session } = input;
    const now = this.clock.now();
    const facts = paymentFacts(payment.methodType, event.details);
    const net = Money.of(order.totalPrice);
    const vat = Money.of(order.taxAmount);
    const grossUsd = net.add(vat);
    const feeUsd = gatewayFeeUsd(grossUsd, gateway.feePercent, gateway.feeFixed);

    const pay = b2cPay({ net, vat });
    await this.poster.post(tx, {
      kind: pay.kind,
      refType: pay.refType,
      refId: order.id,
      idempotencyKey: `payment:${payment.id}:capture`,
      currency: 'USD',
      lines: pay.lines,
      memo: `Payment PAY-${payment.id} for SF-${order.id}`,
      createdBy: { type: 'system', id: null },
    });
    const fee = b2cFee({ fee: feeUsd });
    if (fee.lines.length > 0) {
      await this.poster.post(tx, {
        kind: fee.kind,
        refType: fee.refType,
        refId: order.id,
        idempotencyKey: `payment:${payment.id}:fee`,
        currency: 'USD',
        lines: fee.lines,
        memo: `Gateway fee of PAY-${payment.id}`,
        createdBy: { type: 'system', id: null },
      });
    }

    // An order has one paid receipt: the payment that created the order issues it; a duplicate payment (`receipt: false`) does not.
    const invoice =
      input.receipt === false
        ? undefined
        : await this.issueReceipt(tx, { gateway, order, session }, grossUsd, vat, now);

    await updateOrderPayment(tx, payment.id, {
      status: 'captured',
      orderId: order.id,
      ...(invoice === undefined ? {} : { invoiceId: invoice.id }),
      gatewayTxnId: event.reference,
      methodType: facts.method,
      brand: facts.brand,
      cardFingerprint: event.details?.fingerprint ?? null,
      threeDs: event.details?.threeDs ?? false,
      feeAmount: fromUsd(feeUsd, session.fxRate, session.decimals).toWire(),
      capturedAt: now,
      raw: event.raw,
      reviewRequired: false,
      reviewNote: null,
      updatedAt: now,
    });
    return { method: facts.method, brand: facts.brand, invoiceId: invoice?.id ?? null };
  }

  /**
   * Issues the paid tax receipt invoice of an order and queues its PDF.
   *
   * Why: the receipt is in the buyer's currency: the gross and the tax are converted and the net is what is left, as the checkout shows. The PDF
   * is not drawn here: the `receipt.render` event written with the invoice makes the worker do it after the commit.
   */
  private async issueReceipt(
    tx: DbExecutor,
    input: { gateway: PaymentGateway; order: CapturedOrder; session: CapturedSession },
    grossUsd: Money,
    vat: Money,
    now: Date,
  ): Promise<Invoice> {
    const { gateway, order, session } = input;
    const grossShown = fromUsd(grossUsd, session.fxRate, session.decimals);
    const taxShown = fromUsd(vat, session.fxRate, session.decimals);
    const id = await reserveInvoiceId(tx);
    const invoice = await insertInvoice(tx, {
      id,
      number: invoiceNumber(now.getUTCFullYear(), id),
      customerId: order.customerId,
      orderId: order.id,
      kind: 'receipt',
      amount: grossShown.toWire(),
      fee: '0',
      netAmount: grossShown.sub(taxShown).toWire(),
      taxAmount: taxShown.toWire(),
      taxRate: session.taxRate,
      taxCountry: session.taxCountry ?? '',
      customerVatId: '',
      total: grossShown.toWire(),
      currency: session.currency,
      status: 'paid',
      gatewayId: gateway.id,
      paidAt: now,
      description: `Order SF-${order.id}`,
      createdAt: now,
      updatedAt: now,
    });
    await this.receipts.render(tx, invoice.id);
    return invoice;
  }

  /**
   * Keeps a confirmed payment out of the books until staff look at it.
   *
   * Why: a confirmation that cannot be matched to its quote (another amount or currency) or to a payable checkout creates no order and
   * posts nothing; the payment stays `pending` with the reason and the event, and the problem is logged for the operator.
   *
   * @param tx the capture's transaction
   * @param paymentId the payment
   * @param reason the sentence for staff
   * @param event the confirmation, kept on the payment
   */
  async hold(tx: DbExecutor, paymentId: number, reason: string, event: PaymentEvent): Promise<void> {
    await updateOrderPayment(tx, paymentId, {
      reviewRequired: true,
      reviewNote: reason,
      raw: event.raw,
      updatedAt: this.clock.now(),
    });
  }

  /**
   * Records a payment that arrived for a checkout that was already paid, and sends the money straight back.
   *
   * @param tx the capture's transaction (the payment is locked)
   * @param input the payment, its gateway, the event, the order the first payment created and what the session locked
   */
  async recordDuplicate(
    tx: DbExecutor,
    input: {
      payment: Payment;
      gateway: PaymentGateway;
      event: PaymentEvent;
      orderId: number;
      session: CapturedSession;
    },
  ): Promise<void> {
    const order = await orderForRefund(tx, input.orderId);
    if (!order) throw new Error(`The paid checkout names order ${input.orderId}, which does not exist.`);
    // The order has its receipt already (the first payment's): the duplicate is booked and refunded, and issues no second one.
    await this.recordCapture(tx, { ...input, order, receipt: false });
    const captured = await findOrderPayment(tx, input.payment.id);
    if (captured) await this.refunds.refundDuplicate(tx, order, captured);
  }
}

function inProgress(): AppError {
  return new AppError('IDEMPOTENCY_IN_PROGRESS', {
    detail: 'A request with this Idempotency-Key is still being processed. Wait a moment and send it again.',
    retryAfterSeconds: 1,
  });
}
