// Unit tests of the payment score (feature 18): each signal, the hard blocks, the thresholds and the hold sentence.
import { describe, expect, it } from 'bun:test';
import { Money } from '@src/common/money';
import { defaultRuleSet, mergeRules } from '@src/modules/risk/domain/risk-rules';
import {
  SIGNAL_POINTS,
  type ScreeningFacts,
  guestFirstOrderSignal,
  holdReason,
  scorePayment,
  taxEvidenceSignal,
  withReviewReasons,
} from '@src/modules/risk/domain/risk-scoring';

const CALM: ScreeningFacts = {
  amountUsd: Money.of('15.0000'),
  paymentMethod: 'card',
  firstOrder: false,
  ordersLast24hByEmail: 0,
  ordersLastHourByDevice: 0,
  disposableEmail: false,
  ipCountry: 'GB',
  cardCountry: 'GB',
  prepaidCard: false,
  blocklistHits: [],
};
const facts = (change: Partial<ScreeningFacts>): ScreeningFacts => ({ ...CALM, ...change });

describe('scorePayment', () => {
  const rules = defaultRuleSet();

  it('allows a calm repeat customer with no signal', () => {
    expect(scorePayment(CALM, rules)).toEqual({ score: 0, signals: [], decision: 'allow' });
  });

  it('adds the demo points per signal', () => {
    const verdict = scorePayment(
      facts({ disposableEmail: true, prepaidCard: true, ipCountry: 'US', cardCountry: 'GB' }),
      rules,
    );
    expect(verdict.signals).toEqual([
      'Disposable email domain',
      'IP country differs from card country',
      'Prepaid card BIN',
    ]);
    expect(verdict.score).toBe(22 + 25 + 12);
    expect(verdict.decision).toBe('review');
  });

  it('has a signal for each of these facts and none for a VPN or proxy address or an earlier IMEI check', () => {
    expect(Object.keys(SIGNAL_POINTS).sort()).toEqual([
      'cardDetailsMissing',
      'disposableEmail',
      'firstOrderAbove',
      'ipCountryMismatch',
      'orderBurst',
      'prepaidCard',
      'tooManyOrders',
    ]);
  });

  it('adds the card-details signal (24C), which alone never holds', () => {
    const alone = scorePayment(facts({ cardDetailsMissing: true }), rules);
    expect(alone).toEqual({ score: 10, signals: ['Card details unavailable from the gateway'], decision: 'allow' });
    expect(SIGNAL_POINTS.cardDetailsMissing).toBeLessThan(rules.reviewThreshold.value!);
    // 22 + 25 = 47 is three points short of a hold; the missing details tip it over.
    const base = facts({ disposableEmail: true, ipCountry: 'US' });
    expect(scorePayment(base, rules)).toMatchObject({ score: 47, decision: 'allow' });
    expect(scorePayment({ ...base, cardDetailsMissing: true }, rules)).toMatchObject({ score: 57, decision: 'review' });
  });

  it('scores the first order above the limit with the limit in the sentence, and not at or below it', () => {
    const over = scorePayment(facts({ firstOrder: true, amountUsd: Money.of('40.0001') }), rules);
    expect(over.signals).toEqual(['New customer, first order above $40']);
    expect(over.score).toBe(18);
    expect(scorePayment(facts({ firstOrder: true, amountUsd: Money.of('40.0000') }), rules).score).toBe(0);
  });

  it('holds at the review threshold and blocks at the block threshold, inclusive', () => {
    const base = facts({ disposableEmail: true, prepaidCard: true }); // 22 + 12 = 34
    expect(scorePayment(base, rules).decision).toBe('allow');
    expect(scorePayment({ ...base, ordersLastHourByDevice: 3 }, rules)).toMatchObject({
      score: 54,
      decision: 'review',
    });
    const heavy = facts({
      disposableEmail: true,
      prepaidCard: true,
      ordersLastHourByDevice: 3,
      ipCountry: 'US',
      firstOrder: true,
      amountUsd: Money.of('90'),
    });
    expect(scorePayment(heavy, rules)).toMatchObject({ score: 97, decision: 'block' }); // 22 + 12 + 20 + 25 + 18
  });

  it('counts the burst by the earlier orders and writes the order number', () => {
    expect(scorePayment(facts({ ordersLastHourByDevice: 2 }), rules).score).toBe(0);
    expect(scorePayment(facts({ ordersLastHourByDevice: 3 }), rules).signals).toEqual([
      '4 orders in one hour from one device',
    ]);
  });

  it('holds an email that passed the daily limit', () => {
    const verdict = scorePayment(facts({ ordersLast24hByEmail: 3 }), rules);
    expect(verdict.signals).toEqual(['More than 3 orders in 24 hours from this email']);
    expect(verdict.decision).toBe('review');
    expect(scorePayment(facts({ ordersLast24hByEmail: 2 }), rules).decision).toBe('allow');
  });

  it('makes a blocklist hit a hard block at 100 whatever else is calm', () => {
    const verdict = scorePayment(facts({ blocklistHits: ['Email is on the blocklist'] }), rules);
    expect(verdict).toEqual({ score: 100, signals: ['Email is on the blocklist'], decision: 'block' });
  });

  it('blocks a disposable email only while that rule is on (it is off by default)', () => {
    expect(scorePayment(facts({ disposableEmail: true }), rules)).toMatchObject({ score: 22, decision: 'allow' });
    const on = mergeRules(rules, [{ id: 'blockDisposableEmail', on: true, value: null }]);
    if (!on.ok) throw new Error('unexpected');
    expect(scorePayment(facts({ disposableEmail: true }), on.next)).toMatchObject({ score: 100, decision: 'block' });
  });

  it('ignores a threshold or a signal whose switch is off', () => {
    const off = mergeRules(rules, [
      { id: 'reviewThreshold', on: false, value: 50 },
      { id: 'reviewIpCountryMismatch', on: false, value: null },
      { id: 'reviewFirstOrderAbove', on: false, value: 40 },
    ]);
    if (!off.ok) throw new Error('unexpected');
    const verdict = scorePayment(
      facts({
        disposableEmail: true,
        prepaidCard: true,
        ipCountry: 'US',
        cardCountry: 'GB',
        firstOrder: true,
        amountUsd: Money.of('99'),
      }),
      off.next,
    );
    expect(verdict.signals).toEqual(['Disposable email domain', 'Prepaid card BIN']);
    expect(verdict.decision).toBe('allow');
  });

  it('judges the country mismatch for card payments only, and only when both countries are known', () => {
    expect(scorePayment(facts({ paymentMethod: 'wallet', ipCountry: 'US' }), rules).score).toBe(0);
    expect(scorePayment(facts({ ipCountry: null }), rules).score).toBe(0);
    expect(scorePayment(facts({ cardCountry: null, ipCountry: 'US' }), rules).score).toBe(0);
  });

  it('caps the score at 100', () => {
    const verdict = scorePayment(
      facts({
        disposableEmail: true,
        prepaidCard: true,
        ordersLastHourByDevice: 5,
        ordersLast24hByEmail: 9,
        ipCountry: 'US',
        firstOrder: true,
        amountUsd: Money.of('90'),
      }),
      rules,
    );
    expect(verdict.score).toBe(100);
    expect(verdict.decision).toBe('block');
  });
});

describe('holdReason', () => {
  it('names the score, the first signal and how many more there are', () => {
    expect(holdReason({ score: 84, signals: ['IP country differs from card country', 'Prepaid card BIN', 'x'] })).toBe(
      'Risk hold: score 84. IP country differs from card country and 2 more signals',
    );
    expect(holdReason({ score: 55, signals: ['a', 'b'] })).toBe('Risk hold: score 55. a and 1 more signal');
    expect(holdReason({ score: 55, signals: ['a'] })).toBe('Risk hold: score 55. a');
    expect(holdReason({ score: 55, signals: [] })).toBe('Risk hold: score 55.');
  });
});

describe('withReviewReasons (decision 048)', () => {
  const late = "Paid 31 minutes after the checkout's price lock ended";

  it('a review reason holds a payment the rules allow, and leaves a block a block', () => {
    expect(withReviewReasons({ score: 0, signals: [], decision: 'allow' }, [late])).toEqual({
      score: 0,
      signals: [late],
      decision: 'review',
    });
    expect(withReviewReasons({ score: 60, signals: ['Prepaid card BIN'], decision: 'review' }, [late])).toEqual({
      score: 60,
      signals: [late, 'Prepaid card BIN'],
      decision: 'review',
    });
    expect(withReviewReasons({ score: 100, signals: ['Blocked email'], decision: 'block' }, [late])).toEqual({
      score: 100,
      signals: ['Blocked email', late],
      decision: 'block',
    });
    const verdict = { score: 10, signals: ['Card details unavailable from the gateway'], decision: 'allow' } as const;
    expect(withReviewReasons(verdict, [])).toBe(verdict);
  });
});

describe('the first-order signal of a guest payment (decision 050)', () => {
  const rules = defaultRuleSet();

  it("says when a guest's first order is judged without the history of its email", () => {
    const guest = scorePayment(
      facts({ firstOrder: true, guestWithHistory: true, amountUsd: Money.of('40.0001') }),
      rules,
    );
    expect(guest.signals).toEqual(['Guest checkout, treated as a first order above $40']);
    expect(guest.score).toBe(18);
    expect(guestFirstOrderSignal(100)).toBe('Guest checkout, treated as a first order above $100');
    const plain = scorePayment(facts({ firstOrder: true, amountUsd: Money.of('40.0001') }), rules);
    expect(plain.signals).toEqual(['New customer, first order above $40']);
  });
});

describe('taxEvidenceSignal (decision 050)', () => {
  it('names the declared country and the card country when they differ', () => {
    expect(taxEvidenceSignal({ taxCountry: 'GB', cardCountry: 'US', ipCountry: 'GB' })).toBe(
      'Tax country GB differs from the card country US',
    );
  });

  it("uses the visitor's country as evidence only when the card does not say its country", () => {
    expect(taxEvidenceSignal({ taxCountry: 'GB', cardCountry: null, ipCountry: 'US' })).toBe(
      'Tax country GB differs from the IP country US',
    );
    expect(taxEvidenceSignal({ taxCountry: 'GB', ipCountry: 'US' })).toBe(
      'Tax country GB differs from the IP country US',
    );
    expect(taxEvidenceSignal({ taxCountry: 'GB', cardCountry: 'GB', ipCountry: 'US' })).toBeUndefined();
  });

  it('keeps the declared country when no evidence is known or the evidence agrees', () => {
    expect(taxEvidenceSignal({ taxCountry: null, cardCountry: 'US', ipCountry: 'US' })).toBeUndefined();
    expect(taxEvidenceSignal({ cardCountry: 'US', ipCountry: 'US' })).toBeUndefined();
    expect(taxEvidenceSignal({ taxCountry: 'GB', cardCountry: null, ipCountry: null })).toBeUndefined();
    expect(taxEvidenceSignal({ taxCountry: 'GB', cardCountry: 'GB', ipCountry: null })).toBeUndefined();
    expect(taxEvidenceSignal({ taxCountry: 'GB', cardCountry: null, ipCountry: 'GB' })).toBeUndefined();
  });

  describe('as a review reason', () => {
    const rules = defaultRuleSet();
    const tax = 'Tax country GB differs from the card country US';
    const late = "Paid 31 minutes after the checkout's price lock ended";

    it('holds a payment the score allows, with no points, whatever the review switch says', () => {
      const calm = scorePayment(CALM, rules);
      expect(withReviewReasons(calm, [tax])).toEqual({ score: 0, signals: [tax], decision: 'review' });
      const merged = mergeRules(rules, [{ id: 'reviewThreshold', on: false, value: 50 }]);
      if (!merged.ok) throw new Error('unexpected');
      const off = scorePayment(
        facts({ disposableEmail: true, prepaidCard: true, ordersLastHourByDevice: 3 }),
        merged.next,
      );
      expect(off.decision).toBe('allow');
      expect(withReviewReasons(off, [tax]).decision).toBe('review');
    });

    it('comes after the payment side’s own reasons, and a block stays a block with the signal last', () => {
      const calm = scorePayment(CALM, rules);
      expect(withReviewReasons(calm, [late, tax])).toEqual({ score: 0, signals: [late, tax], decision: 'review' });
      const blocked = scorePayment(facts({ blocklistHits: ['Email is on the blocklist'] }), rules);
      expect(withReviewReasons(blocked, [late, tax])).toEqual({
        score: 100,
        signals: ['Email is on the blocklist', late, tax],
        decision: 'block',
      });
    });

    it('is applied once for every reason together: the score and the decision are those of one review', () => {
      const scored = scorePayment(facts({ disposableEmail: true, prepaidCard: true }), rules); // 34 points: allow
      const verdict = withReviewReasons(scored, [late, tax]);
      expect(verdict).toEqual({
        score: 34,
        signals: [late, tax, 'Disposable email domain', 'Prepaid card BIN'],
        decision: 'review',
      });
      expect(holdReason(verdict)).toBe(`Risk hold: score 34. ${late} and 3 more signals`);
    });
  });
});
