// RiskScreening: scores a paid storefront order against the risk rules and writes the assessment (feature 18, stage 18, RESOLUTIONS
// orders-suppliers-11 and money-3). The storefront payment calls it before it places the order, and a billing job asks it about a top-up.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import { Money } from '../../../common/money';
import type { DbExecutor } from '../../../infra/db';
import { normalizeImei } from '../../orders';
import type { RiskDecision } from '../db/schema';
import { isDisposableEmail } from '../domain/disposable-domains';
import {
  type ScreeningFacts,
  holdReason,
  scorePayment,
  taxEvidenceSignal,
  withReviewReasons,
} from '../domain/risk-scoring';
import { insertAssessment, linkAssessmentToOrder, lockBuyer } from '../infra/assessment.repository';
import { countEarlierOrders, hasAnyCurrentTaxRate } from '../infra/foreign-reads.repository';
import { Blocklist } from './blocklist';
import { RiskRules } from './risk-rules.service';

/** A country code as two upper-case letters, or `null` when the value is not one (decision 050: the three countries are compared in one form). */
function countryOrNull(value: string | null | undefined): string | null {
  const code = value?.trim().toUpperCase();
  return code !== undefined && /^[A-Z]{2}$/.test(code) ? code : null;
}

/** What the storefront payment tells the screening about the payment it just captured. */
export interface ScreeningInput {
  /** The customer, when the buyer has a customers row. */
  readonly customerId: number | null;
  /** The buyer's email as given at checkout. */
  readonly email: string;
  readonly checkoutSessionId?: number | null;
  /** The order, when it already exists; otherwise link it afterwards with {@link RiskScreening.linkOrder}. */
  readonly orderId?: number | null;
  /** The captured amount in USD, VAT included (4-decimal text). */
  readonly amountUsd: string;
  /** How the customer paid (`b2cPaymentMethod`, or `balance` for the store balance of feature 21). */
  readonly paymentMethod: 'card' | 'wallet' | 'crypto' | 'balance';
  /** The visitor's address (decision 018's trusted proxy address). */
  readonly ip?: string | null;
  /** The device's IMEI (or null for a service without one). */
  readonly imei?: string | null;
  /** The gateway's card fingerprint (`payments.card_fingerprint`). */
  readonly cardFingerprint?: string | null;
  /** The checkout's tax country. */
  readonly country?: string | null;
  /** The visitor's country kept on the checkout session (`checkout_sessions.ip_country`), when the proxy header is configured. */
  readonly ipCountry?: string | null;
  /** The country of the card, from the card driver's charge details, when the gateway reports it. */
  readonly cardCountry?: string | null;
  /** The card is prepaid, from the card driver's charge details. */
  readonly prepaidCard?: boolean;
  /**
   * True when a signed-in customer opened the checkout (`checkout_sessions.opened_signed_in`): only then do the account's history and
   * order counts apply to this payment (decision 050). A guest payment is judged as a first order.
   */
  readonly openedSignedIn: boolean;
  /** The gateway did not give the card's details (feature 24C): a signal, and the card blocklist could not be checked. */
  readonly cardDetailsMissing?: boolean;
  /**
   * Facts the payment side found that need staff review whatever the score: each is a signal and the decision is at least review
   * (decision 048: a payment made after the checkout's price lock ended). The first one is the hold sentence.
   */
  readonly reviewReasons?: readonly string[];
}

/** The verdict the payment acts on. */
export interface ScreeningResult {
  /** The stored `risk_assessments` row; pass it to {@link RiskScreening.linkOrder} when the order did not exist yet. */
  readonly assessmentId: number;
  readonly score: number;
  readonly signals: readonly string[];
  readonly decision: RiskDecision;
  /** True for `review`: place the order `held` (dispatch state `held`) and tell the timeline `holdReason`. */
  readonly hold: boolean;
  /** True for `block`: do not place the order; refund the payment (the card, IMEI or email is blocked or the score is too high). */
  readonly block: boolean;
  /** The timeline sentence of a held order, else `null`. */
  readonly holdReason: string | null;
}

/** What a billing job asks about a top-up. */
export interface TopUpScreeningInput {
  /** The merchant's email, when known. */
  readonly email?: string | null;
  /** The gateway's card fingerprint of the top-up payment. */
  readonly cardFingerprint?: string | null;
}

/** The answer for a top-up. */
export interface TopUpScreening {
  readonly flagged: boolean;
  /** The sentence for `payments.review_note` when flagged. */
  readonly reason: string | null;
}

/**
 * Screens payments.
 *
 * Why: orders-suppliers-11 and the map: "rules score a B2C payment; a flagged order is placed held". The rules come from the table
 * inside the caller's transaction (never from a cache: they decide whether a customer's money is held). Every screening writes
 * one `risk_assessments` row with the score, the signals (plain sentences) and the decision, whatever the decision is, so the
 * customer detail's risk panel and the queue's history have the record. A flagged automatic top-up goes to staff review
 * (`payments.review_required`, money-3): {@link RiskScreening.reviewTopUp} answers that without writing anything.
 *
 * Decision 050: `assess` first takes a transaction lock on the buyer's email, so payments of one email screened at the same moment see each
 * other's orders. A signed-in payment is judged on the account's own signed-in checkouts; a guest payment is always a first order, is counted
 * on its email and the customer row of that email, and adds nothing to the history of the account that owns the email. The three countries
 * (tax, visitor, card) are upper-cased once and all three are probed on the country blocklist. A declared tax country that the card's country
 * (else the visitor's) contradicts is a review reason, while the shop has a tax window in force: the order is held, whatever the score.
 *
 * Side effects: `assess` takes `pg_advisory_xact_lock` and inserts one `risk_assessments` row on the caller's transaction; `linkOrder`
 * updates it. No audit row (the system acts), no outbox row, no cache.
 */
@Injectable()
export class RiskScreening {
  constructor(
    private readonly rules: RiskRules,
    private readonly blocklist: Blocklist,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Scores a captured payment and records the assessment.
   *
   * @param tx the payment's transaction
   * @param input what the payment knows
   * @returns the verdict and the stored assessment's id
   */
  async assess(tx: DbExecutor, input: ScreeningInput): Promise<ScreeningResult> {
    const now = this.clock.now();
    const email = input.email.trim().toLowerCase();
    // Lock order (decision 050): the payment and checkout-session rows the caller holds, then this lock, then the order, stock and ledger
    // rows of the placement. No network call happens while it is held.
    await lockBuyer(tx, email);
    const proven = input.openedSignedIn && input.customerId !== null;
    const rules = await this.rules.load(tx);
    const imei = input.imei ? normalizeImei(input.imei) : null;
    const taxCountry = countryOrNull(input.country);
    const ipCountry = countryOrNull(input.ipCountry);
    const cardCountry = countryOrNull(input.cardCountry);
    const hits = await this.blocklist.match(tx, {
      email: input.email,
      imei,
      card: input.cardFingerprint ?? null,
      countries: [taxCountry, ipCountry, cardCountry],
      guest: !proven,
    });
    const counts = await countEarlierOrders(
      tx,
      {
        email,
        customerId: input.customerId,
        ip: input.ip ?? null,
        exceptOrderId: input.orderId ?? null,
        exceptSessionId: input.checkoutSessionId ?? null,
        proven,
      },
      now,
    );
    const facts: ScreeningFacts = {
      amountUsd: Money.of(input.amountUsd),
      paymentMethod: input.paymentMethod,
      // A guest payment is always a first order: the history of the account that owns the email is not the buyer's (decision 050).
      firstOrder: proven ? counts.earlierOrders === 0 : true,
      guestWithHistory: !proven && counts.earlierOrders > 0,
      ordersLast24hByEmail: counts.lastDayByEmail,
      ordersLastHourByDevice: counts.lastHourByDevice,
      disposableEmail: isDisposableEmail(input.email),
      ipCountry,
      cardCountry,
      prepaidCard: input.prepaidCard ?? false,
      cardDetailsMissing: input.cardDetailsMissing ?? false,
      blocklistHits: hits.map((hit) => hit.sentence),
    };
    // The declared tax country against the evidence (decision 050): a review reason after the payment side's own, and only while the shop
    // has a tax window in force (with none, the declared country decides no tax).
    const evidence = taxEvidenceSignal({ taxCountry, cardCountry, ipCountry });
    const taxReasons = evidence !== undefined && (await hasAnyCurrentTaxRate(tx, now)) ? [evidence] : [];
    const verdict = withReviewReasons(scorePayment(facts, rules), [...(input.reviewReasons ?? []), ...taxReasons]);
    const row = await insertAssessment(tx, {
      checkoutSessionId: input.checkoutSessionId ?? null,
      orderId: input.orderId ?? null,
      customerId: input.customerId,
      score: verdict.score,
      decision: verdict.decision,
      signals: [...verdict.signals],
      provider: 'internal',
      createdAt: now,
      updatedAt: now,
    });
    const hold = verdict.decision === 'review';
    return {
      assessmentId: row.id,
      score: verdict.score,
      signals: verdict.signals,
      decision: verdict.decision,
      hold,
      block: verdict.decision === 'block',
      holdReason: hold ? (input.reviewReasons?.[0] ?? holdReason(verdict)) : null,
    };
  }

  /**
   * Points an assessment at the order that was placed after it.
   *
   * @param tx the payment's transaction
   * @param assessmentId the id {@link RiskScreening.assess} returned
   * @param orderId the placed order
   * @returns false when the assessment was already linked
   */
  linkOrder(tx: DbExecutor, assessmentId: number, orderId: number): Promise<boolean> {
    return linkAssessmentToOrder(tx, assessmentId, orderId, this.clock.now());
  }

  /**
   * Tells whether an automatic top-up must wait for staff.
   *
   * Why: RESOLUTIONS money-3: after the delay the auto-credit job re-checks the gateway and risk; a flagged payment gets
   * `review_required` and the reason as its note. A top-up is a merchant paying in, so the only risk facts are the blocklist: the
   * card the money came from, and the merchant's email.
   *
   * @param db the database or the job's transaction
   * @param input the card fingerprint and the email
   * @returns whether it is flagged and the reason
   */
  async reviewTopUp(db: DbExecutor, input: TopUpScreeningInput): Promise<TopUpScreening> {
    const hits = await this.blocklist.match(db, { email: input.email ?? null, card: input.cardFingerprint ?? null });
    if (hits.length === 0) return { flagged: false, reason: null };
    return { flagged: true, reason: `Risk review: ${hits.map((hit) => hit.sentence).join('; ')}` };
  }
}
