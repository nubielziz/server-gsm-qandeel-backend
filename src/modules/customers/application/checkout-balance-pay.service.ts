// CheckoutBalancePayService: pays a storefront checkout from the signed-in customer's store balance (feature 21, plan § 5.6.6, route
// `POST /store/v1/checkout-sessions/:token/balance-payment`). It places the order and records the payment in one transaction.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import type { ResultOf } from '../../../common/contract';
import { AppError } from '../../../common/errors';
import { Money } from '../../../common/money';
import { DbService, type DbExecutor } from '../../../infra/db';
import { EncryptionService, TokenService } from '../../../infra/crypto';
import {
  BALANCE_BRAND,
  type BalancePaymentView,
  CustomerWalletPayments,
  CustomerWallets,
  type CustomerWalletPolicy,
  StorefrontMails,
  StorefrontMoney,
} from '../../money';
import { CustomerOrderPlacement, OrderReadService } from '../../orders';
import { RiskDecisionsService, RiskScreening, holdReason } from '../../risk';
import { StorefrontPolicies, StorefrontQuotes, inCurrency } from '../../storefront';
import type { payCheckoutFromBalance } from '../contracts/checkout-pay.contracts';
import { CHECKOUT_IMEI_AAD, consentState, effectiveStatus, requiredConsents } from '../domain/checkout';
import type { CheckoutSession } from '../db/schema';
import { lockCheckoutSession, markSessionPaid } from '../infra/checkout.repository';
import { listSessionConsents } from '../infra/consent.repository';
import { findCustomerById } from '../infra/customer.repository';
import { assertServiceOnSale } from './checkout-on-sale';

/** What the route answers. */
export type BalancePaymentResult = ResultOf<typeof payCheckoutFromBalance>;

/** Reads the string values of a session's stored order inputs (as the card capture does). */
function inputsOf(raw: Record<string, unknown> | null): Record<string, string> {
  return Object.fromEntries(
    Object.entries(raw ?? {}).flatMap(([key, value]) => (typeof value === 'string' ? [[key, value]] : [])),
  );
}

/**
 * Pays checkouts from the store balance.
 *
 * Why: plan 21 § 5.6.6 (R4, R10, R13, K1, K2, K4): a signed-in customer pays an open checkout from the balance and gets the order at once,
 * with no gateway, no webhook and no polling. The customer id always comes from the cookie session (with its CSRF token), never from the
 * checkout row alone: the checkout must belong to that customer **and** have been opened while signed in (a guest checkout typed with the
 * account's email, or a prepared link sent to the victim, can never spend a balance). The checkout row lock serializes every payer of one
 * checkout (a card capture racing it finds the session paid and is refunded as a duplicate); the wallet debit is guarded under the
 * wallet's row lock inside `postTransaction`, so parallel checkouts never overspend. Every payment is screened by the risk rules as a card
 * capture is: `review` places the order held, `block` places it held and refunds it to the balance at once.
 *
 * Side effects (one transaction): everything `CustomerOrderPlacement.place` writes, one `payments` row, the `b2c_wallet_pay` journal, the
 * receipt invoice and its `receipt.render` outbox row, one `risk_assessments` row, the session's `status`/`order_id`, the buyer's
 * `order.received` (and `order.completed`) mails; for a blocked payment the refund `RiskDecisionsService.refundBlocked` writes.
 */
@Injectable()
export class CheckoutBalancePayService {
  constructor(
    private readonly db: DbService,
    private readonly wallets: CustomerWallets,
    private readonly walletPayments: CustomerWalletPayments,
    private readonly placement: CustomerOrderPlacement,
    private readonly orders: OrderReadService,
    private readonly money: StorefrontMoney,
    private readonly mails: StorefrontMails,
    private readonly policies: StorefrontPolicies,
    private readonly quotes: StorefrontQuotes,
    private readonly risk: RiskScreening,
    private readonly decisions: RiskDecisionsService,
    private readonly encryption: EncryptionService,
    private readonly tokens: TokenService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Pays a checkout from the balance of the signed-in customer.
   *
   * @param sessionId the session the checkout token resolved to
   * @param customerId the customer of the cookie session (CSRF already checked); `undefined` for a guest
   * @param key the `Idempotency-Key`
   * @returns the payment, the order and the wallet after it; `replayed` when the key answered an earlier call
   * @throws {AppError} `UNAUTHORIZED` (no customer session), `NOT_FOUND`, `FORBIDDEN` (another account's checkout, or one opened as a
   *   guest), `IDEMPOTENCY_KEY_REUSED`, `WALLET_DISABLED`, `INVALID_TRANSITION` (paid, expired, or the service no longer on sale), `ACCOUNT_SUSPENDED`,
   *   `VALIDATION_FAILED` (`consent`), `WALLET_FROZEN`, `INSUFFICIENT_FUNDS` (402)
   */
  async pay(
    sessionId: number,
    customerId: number | undefined,
    key: string,
  ): Promise<{ view: BalancePaymentResult; replayed: boolean }> {
    if (customerId === undefined) {
      throw new AppError('UNAUTHORIZED', { detail: 'Sign in to pay from your store balance.' });
    }
    // Read once before the transaction (plan § 5.6); a switch change is seen at once or within the settings cache's minute.
    const policy = await this.wallets.policy();
    return this.db.runInTransaction(async ({ tx }) => {
      // Lock order (plan § 5.7): checkout session → (stock claim, inserts) → ledger accounts, by id, taken by the posting only.
      const session = await lockCheckoutSession(tx, sessionId);
      if (!session) throw new AppError('NOT_FOUND', { detail: 'This link is not valid.' });
      // Authorization comes before anything is revealed or replayed (K2).
      if (session.customerId !== customerId) {
        throw new AppError('FORBIDDEN', { detail: 'This checkout belongs to another account.' });
      }
      if (!session.openedSignedIn) {
        throw new AppError('FORBIDDEN', { detail: 'Open the checkout while signed in to pay from your balance.' });
      }
      const replay = await this.walletPayments.replayOf(tx, sessionId, key, session.grossAmount);
      if (replay?.kind === 'other') {
        throw new AppError('IDEMPOTENCY_KEY_REUSED', {
          detail: 'This Idempotency-Key was used for another payment of this checkout.',
        });
      }
      if (replay) {
        return { view: await this.answer(tx, replay.payment, replay.orderId, customerId, policy), replayed: true };
      }
      // The switch is checked after the replay, so a retry of a payment made just before the switch went off still gets its answer.
      if (!policy.enabled) throw new AppError('WALLET_DISABLED');
      await this.assertPayable(tx, session);

      const gross = Money.of(session.netAmount).add(Money.of(session.taxAmount));
      // A friendly refusal before anything is written; the authoritative checks run under the wallet's row lock in the posting.
      const peek = await this.wallets.peek(tx, customerId);
      if (peek.frozen) {
        throw new AppError('WALLET_FROZEN', { detail: 'Paying from your store balance is on hold. Contact support.' });
      }
      if (peek.balance.cmp(gross) < 0) {
        throw new AppError('INSUFFICIENT_FUNDS', {
          detail: `Your store balance is ${peek.balance.toWire()} USD; this order needs ${gross.toWire()} USD.`,
        });
      }

      const decimals = (await this.money.byCode(tx, session.currency))?.decimals ?? 2;
      const captured = {
        currency: session.currency,
        fxRate: session.fxRate,
        taxRate: session.taxRate,
        taxCountry: session.taxCountry,
        decimals,
      };
      const shown = inCurrency(
        { net: Money.of(session.netAmount), tax: Money.of(session.taxAmount), gross },
        session.fxRate,
        decimals,
      ).gross;
      const imei = session.imeiEnc === null ? undefined : this.encryption.decrypt(session.imeiEnc, CHECKOUT_IMEI_AAD);
      const screening = await this.risk.assess(tx, {
        customerId,
        email: session.email,
        checkoutSessionId: session.id,
        amountUsd: gross.toWire(),
        paymentMethod: 'balance',
        imei: imei ?? null,
        cardFingerprint: null,
        country: session.taxCountry,
        ip: session.ip,
        // Decision 050: the visitor's country kept on the checkout; the account itself opened it (the route's guard).
        ipCountry: session.ipCountry,
        openedSignedIn: session.openedSignedIn,
      });
      // A blocked payment is placed held too: the machine refunds only a held order (back to the balance, plan § 5.6.7).
      const held = screening.hold || screening.block;
      let payment: BalancePaymentView | undefined;
      const order = await this.placement.place(
        tx,
        {
          customerId,
          checkoutSessionId: session.id,
          serviceId: session.serviceId,
          quantity: session.quantity,
          imei,
          inputs: inputsOf(session.inputs),
          net: session.netAmount,
          tax: session.taxAmount,
          taxCountry: session.taxCountry,
          publicToken: this.tokens.random(16),
          snapshot: { currency: session.currency, fxRate: session.fxRate, taxRate: session.taxRate },
          paidMessage: `Payment of ${shown.toWire()} ${session.currency} received (${BALANCE_BRAND})`,
          ...(held ? { holdReason: screening.holdReason ?? holdReason(screening) } : {}),
        },
        async (created) => {
          // Any refusal here (INSUFFICIENT_FUNDS, WALLET_FROZEN) rolls back the order, its stock claim and the assessment with it.
          payment = await this.walletPayments.record(tx, {
            sessionId: session.id,
            key,
            customerId,
            order: created,
            session: captured,
          });
        },
      );
      if (!payment) throw new Error(`The placement of order ${order.id} did not record its balance payment.`);
      await this.risk.linkOrder(tx, screening.assessmentId, order.id);
      await markSessionPaid(tx, session.id, order.id, this.clock.now());
      if (screening.block) {
        await this.decisions.refundBlocked(tx, {
          orderId: order.id,
          assessmentId: screening.assessmentId,
          signals: screening.signals,
        });
      } else {
        await this.mails.orderReceived(tx, { orderId: order.id, amount: payment.amount, currency: payment.currency });
        if (order.status === 'completed') await this.mails.orderCompleted(tx, { orderId: order.id, completions: 1 });
      }
      return { view: await this.answer(tx, payment, order.id, customerId, policy), replayed: false };
    });
  }

  /** The checks of a new payment: open (not paid, not expired), active customer, a service still on sale, every required consent (as `/pay`). */
  private async assertPayable(tx: DbExecutor, session: CheckoutSession): Promise<void> {
    if (session.status === 'paid') {
      throw new AppError('INVALID_TRANSITION', { detail: 'This checkout was already paid.' });
    }
    if (effectiveStatus(session.status, session.expiresAt, this.clock.now()) !== 'open') {
      throw new AppError('INVALID_TRANSITION', { detail: 'This checkout has expired. Start again.' });
    }
    const customer = session.customerId === null ? undefined : await findCustomerById(tx, session.customerId);
    if (!customer) throw new AppError('NOT_FOUND', { detail: 'This link is not valid.' });
    if (customer.status !== 'active') {
      throw new AppError('ACCOUNT_SUSPENDED', { detail: 'This account cannot start a new order. Contact support.' });
    }
    await assertServiceOnSale(this.quotes, tx, session.serviceId);
    const switches = await this.policies.switches(tx);
    const state = consentState(await listSessionConsents(tx, session.id), requiredConsents(switches.withdrawalWaiver));
    if (!state.complete) {
      throw new AppError('VALIDATION_FAILED', {
        detail: 'Accept the terms before paying.',
        errors: [{ field: 'consent', code: 'required', message: 'Accept the terms before paying.' }],
      });
    }
  }

  /** The route's answer: the payment, the order's tracking token and the wallet as it is now. */
  private async answer(
    tx: DbExecutor,
    payment: BalancePaymentView,
    orderId: number,
    customerId: number,
    policy: CustomerWalletPolicy,
  ): Promise<BalancePaymentResult> {
    const [trackingToken, wallet] = await Promise.all([
      this.orders.trackingTokenOf(tx, orderId),
      this.wallets.figuresOf(tx, customerId, policy),
    ]);
    return { payment, order: { id: orderId, trackingToken: trackingToken ?? '' }, wallet };
  }
}
