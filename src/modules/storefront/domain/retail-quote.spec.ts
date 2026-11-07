// Unit tests of the storefront price arithmetic (feature 14a): the retail floor, the tax in cents, the locked rate and the
// conversion into the buyer's currency.
import { describe, expect, it } from 'bun:test';
import { Money } from '../../../common/money';
import { amountsOf, inCurrency, lockedFxRate, percentWire, retailNet, taxOn } from './retail-quote';

const m = (text: string) => Money.of(text);

describe('retailNet', () => {
  it('keeps the resolved price when it is above the storefront floor', () => {
    // base 17.28 x 1.10 = 19.008 -> 19.01; floor 14.31; the staff price 25.99 stands.
    expect(retailNet(m('25.99'), m('17.28'), m('14.31')).toWire()).toBe('25.9900');
  });

  it('lifts a price that is under 110 % of the base price', () => {
    expect(retailNet(m('18.00'), m('17.28'), m('14.31')).toWire()).toBe('19.0100');
  });

  it('lifts a price under the effective floor when that is the larger part', () => {
    // base 1.00 x 1.10 = 1.10 but the supplier cost rose: floor 2.50.
    expect(retailNet(m('1.20'), m('1.00'), m('2.50')).toWire()).toBe('2.5000');
  });

  it('keeps a price exactly at the floor', () => {
    expect(retailNet(m('19.01'), m('17.28'), m('14.31')).toWire()).toBe('19.0100');
  });
});

describe('taxOn', () => {
  it('rounds the tax half up to cents', () => {
    expect(taxOn(m('3.99'), '20.0000').toWire()).toBe('0.8000'); // 0.798
    expect(taxOn(m('25.99'), '19.0000').toWire()).toBe('4.9400'); // 4.9381
    expect(taxOn(m('10.25'), '10.0000').toWire()).toBe('1.0300'); // 1.025 rounds up
    expect(taxOn(m('9.99'), '0.0000').toWire()).toBe('0.0000');
  });
});

describe('amountsOf', () => {
  it('multiplies the unit price by the quantity before the tax', () => {
    const amounts = amountsOf(m('3.99'), 3, '20.0000');
    expect(amounts.net.toWire()).toBe('11.9700');
    expect(amounts.tax.toWire()).toBe('2.3900'); // 2.394
    expect(amounts.gross.toWire()).toBe('14.3600');
  });

  it('has no tax without a rate', () => {
    const amounts = amountsOf(m('25.99'), 1, '0.0000');
    expect(amounts.tax.isZero()).toBe(true);
    expect(amounts.gross.toWire()).toBe('25.9900');
  });
});

describe('lockedFxRate', () => {
  it('puts the markup on top of the market rate with 8 decimals', () => {
    expect(lockedFxRate('0.79000000', '1.5000')).toBe('0.80185000');
    expect(lockedFxRate('10.60000000', '1.5000')).toBe('10.75900000');
    expect(lockedFxRate('1.00000000', '0.0000')).toBe('1.00000000');
  });

  it('rounds half up at the eighth decimal', () => {
    expect(lockedFxRate('0.33333333', '1.0000')).toBe('0.33666666');
  });
});

describe('inCurrency', () => {
  it('converts the gross and the tax and keeps the three adding up', () => {
    const usd = amountsOf(m('3.99'), 1, '20.0000'); // net 3.99, tax 0.80, gross 4.79
    const gbp = inCurrency(usd, '0.80185000', 2);
    expect(gbp.gross.toWire()).toBe('3.8400'); // 3.84071
    expect(gbp.tax.toWire()).toBe('0.6400'); // 0.64148
    expect(gbp.net.toWire()).toBe('3.2000');
    expect(gbp.net.add(gbp.tax).eq(gbp.gross)).toBe(true);
  });

  it('rounds to the currency decimals (a zero-decimal currency has whole units)', () => {
    const jpy = inCurrency(amountsOf(m('3.99'), 1, '0.0000'), '150.50000000', 0);
    expect(jpy.gross.toWire()).toBe('600.0000'); // 600.495
    expect(jpy.tax.toWire()).toBe('0.0000');
    expect(jpy.net.toWire()).toBe('600.0000');
  });

  it('is the identity in USD', () => {
    const usd = amountsOf(m('25.99'), 1, '8.0000');
    const same = inCurrency(usd, '1.00000000', 2);
    expect(same.gross.eq(usd.gross)).toBe(true);
    expect(same.tax.eq(usd.tax)).toBe(true);
    expect(same.net.eq(usd.net)).toBe(true);
  });
});

describe('percentWire', () => {
  it('writes a percent with four decimals', () => {
    expect(percentWire('20')).toBe('20.0000');
    expect(percentWire('7.5')).toBe('7.5000');
  });
});
