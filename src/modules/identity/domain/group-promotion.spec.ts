// Unit tests of the group promotion decision: highest reachable threshold, never a demotion, never a zero-threshold group.
import { describe, expect, it } from 'bun:test';
import { Money } from '../../../common/money';
import { breaksCreditRule, decidePromotion } from './group-promotion';

const group = (id: number, threshold: string, overdraftAllowed = true) => ({
  id,
  earnThreshold: Money.of(threshold),
  overdraftAllowed,
});
const STANDARD = { id: 1, earnThreshold: Money.zero() };
const WHOLESALE = group(2, '5000');
const VIP = group(3, '25000');

describe('decidePromotion', () => {
  it('stays below the lowest threshold', () => {
    expect(decidePromotion(Money.of('4999.9999'), STANDARD, [WHOLESALE, VIP])).toBeUndefined();
    expect(decidePromotion(Money.zero(), STANDARD, [WHOLESALE, VIP])).toBeUndefined();
  });

  it('promotes at the threshold itself (the spend reaches it)', () => {
    expect(decidePromotion(Money.of('5000'), STANDARD, [WHOLESALE, VIP])?.id).toBe(2);
  });

  it('picks the highest threshold the spend reaches, whatever the order of the groups', () => {
    expect(decidePromotion(Money.of('30000'), STANDARD, [WHOLESALE, VIP])?.id).toBe(3);
    expect(decidePromotion(Money.of('30000'), STANDARD, [VIP, WHOLESALE])?.id).toBe(3);
    expect(decidePromotion(Money.of('12000'), STANDARD, [VIP, WHOLESALE])?.id).toBe(2);
  });

  it('only moves up: a merchant in a group with a threshold at or above the target stays', () => {
    const inWholesale = { id: 2, earnThreshold: Money.of('5000') };
    expect(decidePromotion(Money.of('12000'), inWholesale, [WHOLESALE, VIP])).toBeUndefined();
    expect(decidePromotion(Money.of('30000'), inWholesale, [WHOLESALE, VIP])?.id).toBe(3);
    // Staff put the merchant in VIP by hand with little spend: no demotion.
    const inVip = { id: 3, earnThreshold: Money.of('25000') };
    expect(decidePromotion(Money.of('100'), inVip, [WHOLESALE, VIP])).toBeUndefined();
    // A merchant in a hand-made group with an unusual threshold keeps it when the spend reaches only lower ones.
    const custom = { id: 9, earnThreshold: Money.of('8000') };
    expect(decidePromotion(Money.of('9000'), custom, [WHOLESALE, VIP])).toBeUndefined();
  });

  it('never targets a group with a zero threshold', () => {
    expect(decidePromotion(Money.of('999999'), STANDARD, [group(7, '0'), group(8, '0.0000')])).toBeUndefined();
    expect(decidePromotion(Money.of('6000'), STANDARD, [group(7, '0'), WHOLESALE])?.id).toBe(2);
  });

  it('breaks a tie of equal thresholds with the lower group id', () => {
    expect(decidePromotion(Money.of('6000'), STANDARD, [group(9, '5000'), group(4, '5000')])?.id).toBe(4);
  });

  it('is idempotent: once promoted, the same spend picks nothing', () => {
    const first = decidePromotion(Money.of('30000'), STANDARD, [WHOLESALE, VIP])!;
    expect(
      decidePromotion(Money.of('30000'), { id: first.id, earnThreshold: first.earnThreshold }, [WHOLESALE, VIP]),
    ).toBeUndefined();
  });
});

describe('breaksCreditRule', () => {
  it('is true only for a group without overdraft and a merchant with credit', () => {
    expect(breaksCreditRule({ overdraftAllowed: false }, Money.of('1'))).toBe(true);
    expect(breaksCreditRule({ overdraftAllowed: false }, Money.zero())).toBe(false);
    expect(breaksCreditRule({ overdraftAllowed: true }, Money.of('1'))).toBe(false);
  });
});
