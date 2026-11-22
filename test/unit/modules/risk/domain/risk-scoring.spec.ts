// Unit tests of the payment score (feature 18): each signal, the hard blocks, the thresholds and the hold sentence.
import { describe, expect, it } from 'bun:test';
import { Money } from '@src/common/money';
import { defaultRuleSet, mergeRules } from '@src/modules/risk/domain/risk-rules';
import {
  SIGNAL_POINTS,
  type ScreeningFacts,
  holdReason,
  scorePayment,
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
  proxyIp: false,
  imeiBlacklistedBefore: false,
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
      facts({ disposableEmail: true, proxyIp: true, prepaidCard: true, ipCountry: 'US', cardCountry: 'GB' }),
      rules,
    );
    expect(verdict.signals).toEqual([
      'Disposable email domain',
      'VPN or proxy IP',
      'IP country differs from card country',
      'Prepaid card BIN',
    ]);
    expect(verdict.score).toBe(22 + 15 + 25 + 12);
    expect(verdict.decision).toBe('review');
  });

  it('adds the card-details signal (24C), which alone never holds', () => {
    const alone = scorePayment(facts({ cardDetailsMissing: true }), rules);
    expect(alone).toEqual({ score: 10, signals: ['Card details unavailable from the gateway'], decision: 'allow' });
    expect(SIGNAL_POINTS.cardDetailsMissing).toBeLessThan(rules.reviewThreshold.value!);
    // 22 + 15 + 12 = 49 is one point short of a hold; the missing details tip it over.
    const near = facts({ disposableEmail: true, proxyIp: true, prepaidCard: true, cardDetailsMissing: true });
    expect(scorePayment(near, rules)).toMatchObject({ score: 59, decision: 'review' });
  });

  it('scores the first order above the limit with the limit in the sentence, and not at or below it', () => {
    const over = scorePayment(facts({ firstOrder: true, amountUsd: Money.of('40.0001') }), rules);
    expect(over.signals).toEqual(['New customer, first order above $40']);
    expect(over.score).toBe(18);
    expect(scorePayment(facts({ firstOrder: true, amountUsd: Money.of('40.0000') }), rules).score).toBe(0);
  });

  it('holds at the review threshold and blocks at the block threshold, inclusive', () => {
    const base = facts({ disposableEmail: true, proxyIp: true, prepaidCard: true }); // 22 + 15 + 12 = 49
    expect(scorePayment(base, rules).decision).toBe('allow');
    expect(scorePayment({ ...base, ordersLastHourByDevice: 3 }, rules)).toMatchObject({
      score: 69,
      decision: 'review',
    });
    const heavy = facts({
      disposableEmail: true,
      proxyIp: true,
      prepaidCard: true,
      ordersLastHourByDevice: 3,
      ipCountry: 'US',
    });
    expect(scorePayment(heavy, rules)).toMatchObject({ score: 94, decision: 'block' });
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

  it('blocks a blacklisted IMEI while its rule is on and only scores it when the rule is off', () => {
    expect(scorePayment(facts({ imeiBlacklistedBefore: true }), rules)).toMatchObject({
      score: 100,
      decision: 'block',
    });
    const off = mergeRules(rules, [{ id: 'blockBlacklistedImei', on: false, value: null }]);
    if (!off.ok) throw new Error('unexpected');
    expect(scorePayment(facts({ imeiBlacklistedBefore: true }), off.next)).toMatchObject({
      score: 30,
      decision: 'allow',
    });
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
        proxyIp: true,
        ipCountry: 'US',
        cardCountry: 'GB',
        firstOrder: true,
        amountUsd: Money.of('99'),
      }),
      off.next,
    );
    expect(verdict.signals).toEqual(['Disposable email domain', 'VPN or proxy IP']);
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
        proxyIp: true,
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
    const verdict = { score: 10, signals: ['VPN or proxy IP'], decision: 'allow' } as const;
    expect(withReviewReasons(verdict, [])).toBe(verdict);
  });
});
