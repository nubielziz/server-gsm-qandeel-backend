// Unit tests of the storefront money arithmetic (feature 16): conversion at the locked rate, the VAT share of a refund, the gateway fee, the payment
// status after refunds, the method words, the brand line and the mismatch check of a confirmation.
import { describe, expect, it } from 'bun:test';
import { Money } from '../../../common/money';
import {
  amountText,
  b2cPaymentMethod,
  brandLine,
  fromUsd,
  gatewayFeeUsd,
  paymentFacts,
  refundSplit,
  statusAfterRefunds,
  storefrontMismatch,
  toUsd,
  wireUsd,
} from './b2c-money';

const m = (amount: string): Money => Money.of(amount);

describe('amountText', () => {
  it('keeps the currency digits and adds the code', () => {
    expect(amountText('3.8400', 'GBP', 2)).toBe('3.84 GBP');
    expect(amountText('1200.0000', 'JPY', 0)).toBe('1200 JPY');
    expect(amountText('0.1250', 'KWD', 3)).toBe('0.125 KWD');
    expect(amountText('12', 'USD', 2)).toBe('12.00 USD');
    expect(amountText('7.5', 'EUR', 4)).toBe('7.5000 EUR');
  });
});

describe('toUsd and fromUsd', () => {
  it('divides by the locked rate (units per USD) and rounds half up to four decimals', () => {
    expect(toUsd(m('3.84'), '0.80185000').toWire()).toBe('4.7889');
    expect(toUsd(m('10'), '1').toWire()).toBe('10.0000');
    expect(toUsd(m('1'), '3').toWire()).toBe('0.3333');
    expect(toUsd(m('2'), '3').toWire()).toBe('0.6667');
  });

  it('multiplies by the rate and rounds to the currency digits', () => {
    expect(fromUsd(m('4.79'), '0.80185000', 2).toWire()).toBe('3.8400');
    expect(fromUsd(m('1'), '0.80185000', 2).toWire()).toBe('0.8000');
    expect(fromUsd(m('1'), '0.80500000', 2).toWire()).toBe('0.8100');
    expect(fromUsd(m('1'), '151.23400000', 0).toWire()).toBe('151.0000');
    expect(fromUsd(m('1'), '151.50000000', 0).toWire()).toBe('152.0000');
    expect(fromUsd(m('1'), '0.31245000', 3).toWire()).toBe('0.3120');
  });
});

describe('refundSplit', () => {
  it('splits a part into its VAT share (rounded to cents) and the rest', () => {
    // tax 0.80 of 4.79 paid, refund 1.00: round(0.80 x 1.00 / 4.79, 2) = 0.17.
    const split = refundSplit(m('4.79'), m('0.80'), m('1.00'));
    expect(split.vat.toWire()).toBe('0.1700');
    expect(split.net.toWire()).toBe('0.8300');
    expect(split.total.toWire()).toBe('1.0000');
  });

  it('a refund of everything paid returns exactly the VAT that was paid', () => {
    const split = refundSplit(m('4.79'), m('0.80'), m('4.79'));
    expect(split).toEqual({ net: m('3.99'), vat: m('0.80'), total: m('4.79') });
    // More than paid is treated as everything paid.
    expect(refundSplit(m('4.79'), m('0.80'), m('9')).total.toWire()).toBe('4.7900');
  });

  it('has no VAT part when nothing was paid or no tax was charged', () => {
    expect(refundSplit(m('3.99'), m('0'), m('1.5'))).toEqual({ net: m('1.5'), vat: Money.zero(), total: m('1.5') });
    expect(refundSplit(m('0'), m('0'), m('0')).total.toWire()).toBe('0.0000');
  });

  it('shares sum back to the amount for any part', () => {
    for (const amount of ['0.01', '0.50', '1.33', '2.99', '4.78']) {
      const split = refundSplit(m('4.79'), m('0.80'), m(amount));
      expect(split.net.add(split.vat).toWire()).toBe(m(amount).toWire());
    }
  });
});

describe('gatewayFeeUsd', () => {
  it('is the percent of the gross plus the fixed amount (the map: 0.73 on 14.99)', () => {
    expect(gatewayFeeUsd(m('4.79'), '2.9000', '0.3000').toWire()).toBe('0.4389');
    expect(gatewayFeeUsd(m('14.99'), '2.9000', '0.3000').toWire()).toBe('0.7347');
    expect(gatewayFeeUsd(m('10'), '0', '0').toWire()).toBe('0.0000');
  });
});

describe('statusAfterRefunds', () => {
  it('is captured with no refund, partial_refund below what was paid and refunded from it', () => {
    expect(statusAfterRefunds(m('3.84'), m('0'))).toBe('captured');
    expect(statusAfterRefunds(m('3.84'), m('0.80'))).toBe('partial_refund');
    expect(statusAfterRefunds(m('3.84'), m('3.83'))).toBe('partial_refund');
    expect(statusAfterRefunds(m('3.84'), m('3.84'))).toBe('refunded');
    expect(statusAfterRefunds(m('3.84'), m('4.00'))).toBe('refunded');
  });
});

describe('b2cPaymentMethod', () => {
  it('keeps card, wallet and crypto, reads usdt as crypto and anything else as a card (RESOLUTIONS b2c-6)', () => {
    expect(b2cPaymentMethod('card')).toBe('card');
    expect(b2cPaymentMethod('wallet')).toBe('wallet');
    expect(b2cPaymentMethod('crypto')).toBe('crypto');
    expect(b2cPaymentMethod('usdt')).toBe('crypto');
    expect(b2cPaymentMethod('bank')).toBe('card');
    expect(b2cPaymentMethod('wise')).toBe('card');
    expect(b2cPaymentMethod('')).toBe('card');
  });
});

describe('brandLine', () => {
  it('writes a card as Brand and the last digits, a coin with its network, a wallet by name (RESOLUTIONS money-4)', () => {
    expect(brandLine('card', { brand: 'visa', last4: '4242' })).toBe('Visa •••• 4242');
    expect(brandLine('card', { brand: 'mastercard' })).toBe('Mastercard');
    expect(brandLine('crypto', { coin: 'usdt', network: 'TRC-20' })).toBe('USDT TRC-20');
    expect(brandLine('crypto', { coin: 'btc' })).toBe('BTC');
    expect(brandLine('wallet', { brand: 'apple_pay' })).toBe('Apple Pay');
    expect(brandLine('wallet', { brand: 'google pay' })).toBe('Google Pay');
  });

  it('is empty when the driver could not tell', () => {
    expect(brandLine('card', {})).toBe('');
    expect(brandLine('crypto', {})).toBe('');
    expect(brandLine('wallet', {})).toBe('');
  });
});

describe('paymentFacts', () => {
  it('a card paid with a wallet is a wallet payment', () => {
    expect(paymentFacts('card', { brand: 'apple_pay', wallet: 'apple_pay', last4: '4242' })).toEqual({
      method: 'wallet',
      brand: 'Apple Pay',
    });
  });

  it('keeps the stored method otherwise, and survives an event with no details', () => {
    expect(paymentFacts('card', { brand: 'visa', last4: '4242' })).toEqual({ method: 'card', brand: 'Visa •••• 4242' });
    expect(paymentFacts('crypto', { coin: 'usdt', network: 'TRC-20' })).toEqual({
      method: 'crypto',
      brand: 'USDT TRC-20',
    });
    expect(paymentFacts('usdt', undefined)).toEqual({ method: 'crypto', brand: '' });
  });
});

describe('storefrontMismatch', () => {
  const opened = { amount: '3.8400', currency: 'GBP' };

  it('accepts a confirmation that agrees, or one that does not say', () => {
    expect(storefrontMismatch({ amount: '3.8400', currency: 'GBP' }, opened)).toBeUndefined();
    expect(storefrontMismatch({ amount: '3.84', currency: 'GBP' }, opened)).toBeUndefined();
    expect(storefrontMismatch({ amount: null, currency: null }, opened)).toBeUndefined();
  });

  it('names another currency or another amount', () => {
    expect(storefrontMismatch({ amount: '3.8400', currency: 'USD' }, opened)).toBe(
      'The gateway confirmed USD but the payment was opened in GBP.',
    );
    expect(storefrontMismatch({ amount: '1.0000', currency: 'GBP' }, opened)).toBe(
      'The gateway confirmed 1.0000 but the payment was opened for 3.8400.',
    );
  });
});

describe('wireUsd', () => {
  const payment = { amount: '3.8400', grossUsd: '4.7900' };

  it('the whole payment is exactly what the checkout locked', () => {
    expect(wireUsd(m('3.84'), payment, '0.80185000').toWire()).toBe('4.7900');
  });

  it('a part is converted at the rate; without a payment everything is converted', () => {
    expect(wireUsd(m('1.92'), payment, '0.80185000').toWire()).toBe('2.3945');
    expect(wireUsd(m('3.84'), undefined, '0.80185000').toWire()).toBe('4.7889');
  });
});
