// Unit tests of the price-change guard of user rule 9 (MISMATCHES B117): no listing, a lower price, a raise within the
// tolerance, exactly the tolerance, and a raise above it.
import { describe, expect, it } from 'bun:test';
import { Money } from '../../../common/money';
import { checkPriceChange } from './price-change';

const m = (text: string) => Money.of(text);

describe('checkPriceChange', () => {
  it('has nothing to compare without a listed price', () => {
    expect(checkPriceChange(null, m('99'), 10)).toEqual({ outcome: 'ok', raised: false });
  });

  it('accepts the same price and a lower one', () => {
    expect(checkPriceChange(m('10'), m('10'), 10)).toEqual({ outcome: 'ok', raised: false });
    expect(checkPriceChange(m('10'), m('4.99'), 0)).toEqual({ outcome: 'ok', raised: false });
  });

  it('charges a raise within the tolerance and records it', () => {
    const verdict = checkPriceChange(m('10'), m('10.5'), 10);
    expect(verdict).toMatchObject({ outcome: 'raised', raised: true, reason: 'price_change' });
    if (verdict.outcome !== 'raised') throw new Error('expected a raise');
    expect(verdict.listedPrice.toWire()).toBe('10.0000');
    expect(verdict.currentPrice.toWire()).toBe('10.5000');
  });

  it('names the floor as the reason when the current price is the floor', () => {
    expect(checkPriceChange(m('10'), m('10.5'), 10, { floorRaised: true })).toMatchObject({
      outcome: 'raised',
      reason: 'floor',
    });
  });

  it('accepts exactly the tolerance and refuses anything above it', () => {
    expect(checkPriceChange(m('10'), m('11'), 10).outcome).toBe('raised');
    expect(checkPriceChange(m('10'), m('11.0001'), 10)).toMatchObject({ outcome: 'refuse' });
    expect(checkPriceChange(m('0.12'), m('0.1320'), 10).outcome).toBe('raised');
    expect(checkPriceChange(m('0.12'), m('0.1321'), 10).outcome).toBe('refuse');
  });

  it('refuses every raise at a tolerance of 0 and none at 100 below double', () => {
    expect(checkPriceChange(m('10'), m('10.0001'), 0).outcome).toBe('refuse');
    expect(checkPriceChange(m('10'), m('20'), 100).outcome).toBe('raised');
    expect(checkPriceChange(m('10'), m('20.0001'), 100).outcome).toBe('refuse');
  });

  it('carries both prices in a refusal', () => {
    const verdict = checkPriceChange(m('10'), m('15'), 10);
    if (verdict.outcome !== 'refuse') throw new Error('expected a refusal');
    expect(verdict.listedPrice.toWire()).toBe('10.0000');
    expect(verdict.currentPrice.toWire()).toBe('15.0000');
  });

  it('refuses any raise over a listed price of zero', () => {
    expect(checkPriceChange(m('0'), m('0.0100'), 100).outcome).toBe('refuse');
  });

  it('refuses a tolerance outside 0 to 100', () => {
    expect(() => checkPriceChange(m('10'), m('11'), -1)).toThrow(RangeError);
    expect(() => checkPriceChange(m('10'), m('11'), 101)).toThrow(RangeError);
    expect(() => checkPriceChange(m('10'), m('11'), Number.NaN)).toThrow(RangeError);
  });
});
