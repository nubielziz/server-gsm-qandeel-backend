// The risk score of a paid storefront order (feature 18, RESOLUTIONS orders-suppliers-11 and b2c-11): which signals add points, how the
// points and the rules become allow, review (hold) or block. Pure, no database.
import { Money } from '../../../common/money';
import type { RiskDecision } from '../db/schema';
import type { RiskRuleSet } from './risk-rules';

/**
 * The points each signal adds.
 *
 * Why: the demo's own table (`B2C_SIGNALS`, 09-b2c-data.js): the queue prints the signal text, and the score is their sum.
 */
export const SIGNAL_POINTS = {
  disposableEmail: 22,
  firstOrderAbove: 18,
  proxyIp: 15,
  ipCountryMismatch: 25,
  prepaidCard: 12,
  orderBurst: 20,
  blacklistedBefore: 30,
  tooManyOrders: 50,
} as const;

/** Orders from one device (address or customer) in the last hour that make the next one a burst: it is the 4th. */
export const BURST_EARLIER_ORDERS = 3;

/** The highest score: the points are capped so the scale reads as 0 to 100. */
export const MAX_SCORE = 100;

/** The facts the score is made from. The service gathers them; this module only judges. */
export interface ScreeningFacts {
  /** Gross USD of the payment (incl. VAT). */
  readonly amountUsd: Money;
  readonly paymentMethod: 'card' | 'wallet' | 'crypto';
  /** The customer has no earlier order that was not rejected. */
  readonly firstOrder: boolean;
  /** Earlier orders from this email in the last 24 hours, not counting this one. */
  readonly ordersLast24hByEmail: number;
  /** Earlier orders from this device (address or customer) in the last hour, not counting this one. */
  readonly ordersLastHourByDevice: number;
  /** The email's domain is on the built-in list of throw-away mailboxes. */
  readonly disposableEmail: boolean;
  readonly ipCountry: string | null;
  readonly cardCountry: string | null;
  readonly prepaidCard: boolean;
  readonly proxyIp: boolean;
  /** An earlier IMEI check of this IMEI said blacklisted. */
  readonly imeiBlacklistedBefore: boolean;
  /** What the blocklist matched: one sentence per hit (an email, a domain, an IMEI, a card, a country). */
  readonly blocklistHits: readonly string[];
}

/** What the score decided. */
export interface ScreeningVerdict {
  /** 0 to {@link MAX_SCORE}. */
  readonly score: number;
  /** The signals in plain sentences, the first one is the one that seeds a refund reason. */
  readonly signals: readonly string[];
  readonly decision: RiskDecision;
}

/**
 * The sentence of the first-order signal.
 *
 * @param usd the rule's amount in whole USD
 * @returns for example `New customer, first order above $40`
 */
export function firstOrderSignal(usd: number): string {
  return `New customer, first order above $${usd}`;
}

/**
 * Scores a payment against the rules.
 *
 * Why: orders-suppliers-11 and the map: "rules score a B2C payment; a flagged order is placed held". A blocklist hit, a
 * blacklisted IMEI while its rule is on, and a disposable mailbox while its rule is on are hard blocks (score 100). Every other
 * signal adds its points; the sum is capped at 100. Then the thresholds decide: at or above the block threshold the payment is
 * cancelled (`block`), at or above the review threshold the order is held (`review`), else `allow`. A threshold whose switch is
 * off does not apply. The review threshold below the block threshold is kept by the rules route, so a score never needs both
 * answers.
 *
 * @param facts the facts about the payment
 * @param rules the stored rules
 * @returns the score, the signal sentences (hard blocks first) and the decision
 */
export function scorePayment(facts: ScreeningFacts, rules: RiskRuleSet): ScreeningVerdict {
  const signals: string[] = [...facts.blocklistHits];
  let hardBlock = facts.blocklistHits.length > 0;
  let points = 0;
  const add = (text: string, value: number): void => {
    signals.push(text);
    points += value;
  };

  if (facts.imeiBlacklistedBefore) {
    if (rules.blockBlacklistedImei.on) {
      signals.push('IMEI was checked blacklisted before');
      hardBlock = true;
    } else add('IMEI was checked blacklisted before', SIGNAL_POINTS.blacklistedBefore);
  }
  if (facts.disposableEmail) {
    if (rules.blockDisposableEmail.on) {
      signals.push('Disposable email domain');
      hardBlock = true;
    } else add('Disposable email domain', SIGNAL_POINTS.disposableEmail);
  }
  const firstOrderLimit = rules.reviewFirstOrderAbove;
  if (
    firstOrderLimit.on &&
    firstOrderLimit.value !== null &&
    facts.firstOrder &&
    facts.amountUsd.cmp(Money.of(firstOrderLimit.value)) > 0
  ) {
    add(firstOrderSignal(firstOrderLimit.value), SIGNAL_POINTS.firstOrderAbove);
  }
  if (facts.proxyIp) add('VPN or proxy IP', SIGNAL_POINTS.proxyIp);
  if (
    rules.reviewIpCountryMismatch.on &&
    facts.paymentMethod === 'card' &&
    facts.ipCountry !== null &&
    facts.cardCountry !== null &&
    facts.ipCountry !== facts.cardCountry
  ) {
    add('IP country differs from card country', SIGNAL_POINTS.ipCountryMismatch);
  }
  if (facts.prepaidCard) add('Prepaid card BIN', SIGNAL_POINTS.prepaidCard);
  if (facts.ordersLastHourByDevice >= BURST_EARLIER_ORDERS) {
    add(`${facts.ordersLastHourByDevice + 1} orders in one hour from one device`, SIGNAL_POINTS.orderBurst);
  }
  const maxPerDay = rules.maxOrdersPerEmail;
  if (maxPerDay.on && maxPerDay.value !== null && facts.ordersLast24hByEmail >= maxPerDay.value) {
    add(
      `More than ${maxPerDay.value} order${maxPerDay.value === 1 ? '' : 's'} in 24 hours from this email`,
      SIGNAL_POINTS.tooManyOrders,
    );
  }

  const score = hardBlock ? MAX_SCORE : Math.min(MAX_SCORE, points);
  return { score, signals, decision: decide(score, hardBlock, rules) };
}

function decide(score: number, hardBlock: boolean, rules: RiskRuleSet): RiskDecision {
  if (hardBlock) return 'block';
  const block = rules.blockThreshold;
  if (block.on && block.value !== null && score >= block.value) return 'block';
  const review = rules.reviewThreshold;
  if (review.on && review.value !== null && score >= review.value) return 'review';
  return 'allow';
}

/**
 * The reason the held order's timeline shows.
 *
 * Why: the demo writes `Risk hold: score 84. <first signal> and N more signals` on the order a rule held.
 *
 * @param verdict the verdict of a `review` decision
 * @returns the sentence
 */
export function holdReason(verdict: Pick<ScreeningVerdict, 'score' | 'signals'>): string {
  const [first, ...rest] = verdict.signals;
  const more = rest.length === 0 ? '' : ` and ${rest.length} more signal${rest.length === 1 ? '' : 's'}`;
  return `Risk hold: score ${verdict.score}.${first === undefined ? '' : ` ${first}`}${more}`;
}
