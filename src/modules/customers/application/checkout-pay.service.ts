// CheckoutPayService: starts the payment of a storefront checkout (feature 16, map `POST /store/v1/checkout-sessions/:token/pay`, scenario
// b2c-paid steps 4 and 5). It judges the checkout and hands the money side to `StorefrontPayments`.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import type { BodyOf, ResultOf } from '../../../common/contract';
import { AppError } from '../../../common/errors';
import { Money } from '../../../common/money';
import { DbService } from '../../../infra/db';
import { SettingsService } from '../../platform';
import { StorefrontMoney, StorefrontPayments } from '../../money';
import { StorefrontPolicies, inCurrency } from '../../storefront';
import type { payCheckoutSession } from '../contracts/checkout-pay.contracts';
import { consentState, effectiveStatus, requiredConsents } from '../domain/checkout';
import { findCheckoutSession } from '../infra/checkout.repository';
import { findCustomerById } from '../infra/customer.repository';
import { listSessionConsents } from '../infra/consent.repository';
import { CheckoutSessionService } from './checkout-session.service';

/** What the route answers. */
export type StartedPaymentView = ResultOf<typeof payCheckoutSession>;

/** The policy that asks for 3-D Secure on cards (RULES settings 5); on unless staff turn it off. */
const REQUIRE_3DS_KEY = 'require3ds';

/**
 * Starts payments.
 *
 * Why: scenario b2c-paid and ALIGNMENT § 7: the checkout must be open (an unpaid session past its expiry reads expired), its customer active,
 * every required consent granted (the proof for a chargeback, scenario b2c-chargeback step 4) and the method one of the shop's; then the
 * payment is opened once per `Idempotency-Key`. A replay of an earlier call answers before any of these checks, so a retry after the
 * session expired or was paid still receives the answer it missed. The order is NOT created here (CLAUDE.md: B2C never dispatches before
 * payment): the gateway's confirmation does it.
 *
 * Side effects: through `StorefrontPayments.start`: one `payments` row and one gateway call.
 */
@Injectable()
export class CheckoutPayService {
  constructor(
    private readonly db: DbService,
    private readonly payments: StorefrontPayments,
    private readonly money: StorefrontMoney,
    private readonly policies: StorefrontPolicies,
    private readonly settings: SettingsService,
    private readonly sessions: CheckoutSessionService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Starts a payment.
   *
   * @param sessionId the session the token resolved to
   * @param body the chosen method and the return address
   * @param key the `Idempotency-Key`
   * @returns the payment, its gateway and the hosted page
   * @throws {AppError} `NOT_FOUND`, `INVALID_TRANSITION`, `ACCOUNT_SUSPENDED`, `VALIDATION_FAILED`, the idempotency refusals, `GATEWAY_ERROR`
   */
  async pay(
    sessionId: number,
    body: BodyOf<typeof payCheckoutSession>,
    key: string,
  ): Promise<{ view: StartedPaymentView; replayed: boolean }> {
    const session = await findCheckoutSession(this.db.db, sessionId);
    if (!session) throw new AppError('NOT_FOUND', { detail: 'This link is not valid.' });
    const currency = await this.money.byCode(this.db.db, session.currency);
    const display = inCurrency(
      { net: Money.of(session.netAmount), tax: Money.of(session.taxAmount), gross: Money.of(session.grossAmount) },
      session.fxRate,
      currency?.decimals ?? 2,
    );
    const started = await this.payments.start(
      {
        sessionId,
        customerId: session.customerId ?? 0,
        key,
        gatewayCode: body.gateway,
        returnUrl: body.returnUrl,
        amount: display.gross,
        currency: session.currency,
        grossUsd: Money.of(session.grossAmount),
        description: `Order for ${(await this.sessions.view(this.db.db, session)).service.name}`,
        require3ds: (await this.settings.get(REQUIRE_3DS_KEY)) !== false,
      },
      () => this.assertPayable(sessionId),
    );
    const { replayed, ...view } = started;
    return { view, replayed };
  }

  /** The checks of a new payment: open session, active customer, every required consent. */
  private async assertPayable(sessionId: number): Promise<void> {
    const session = await findCheckoutSession(this.db.db, sessionId);
    if (!session) throw new AppError('NOT_FOUND', { detail: 'This link is not valid.' });
    if (session.status === 'paid') {
      throw new AppError('INVALID_TRANSITION', { detail: 'This checkout was already paid.' });
    }
    if (effectiveStatus(session.status, session.expiresAt, this.clock.now()) !== 'open') {
      throw new AppError('INVALID_TRANSITION', { detail: 'This checkout has expired. Start again.' });
    }
    const customer = session.customerId === null ? undefined : await findCustomerById(this.db.db, session.customerId);
    if (!customer) throw new AppError('NOT_FOUND', { detail: 'This link is not valid.' });
    if (customer.status !== 'active') {
      throw new AppError('ACCOUNT_SUSPENDED', { detail: 'This account cannot start a new order. Contact support.' });
    }
    const switches = await this.policies.switches(this.db.db);
    const state = consentState(
      await listSessionConsents(this.db.db, session.id),
      requiredConsents(switches.withdrawalWaiver),
    );
    if (!state.complete) {
      throw new AppError('VALIDATION_FAILED', {
        detail: 'Accept the terms before paying.',
        errors: [{ field: 'consent', code: 'required', message: 'Accept the terms before paying.' }],
      });
    }
  }
}
