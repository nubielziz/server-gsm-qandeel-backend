// Unit tests of the bulk price arithmetic: reading the signed amount and the new price of a percent or a fixed change.
import { describe, expect, it } from 'bun:test';
import { Money } from '../../../common/money';
import { bulkNewPrice, readBulkAmount } from './bulk-price';

describe('readBulkAmount', () => {
  it('reads signed decimals with up to four decimals', () => {
    for (const text of ['5', '-0.25', '+3.5', '0.0001', '-12.3456']) {
      const read = readBulkAmount(text);
      expect('value' in read && read.value.toString()).toBe(String(Number(text)));
    }
  });

  it('refuses zero, text that is not a number, too many decimals and absurd sizes', () => {
    for (const text of ['0', '0.0000', '-0', '', 'abc', '1e3', '1,5', '5%', '1.23456', '--1', '2000000']) {
      expect('problem' in readBulkAmount(text), text).toBe(true);
    }
  });
});

describe('bulkNewPrice', () => {
  const price = (text: string) => Money.of(text);

  it('raises or lowers by a percent of the current price, rounded half-up to cents', () => {
    const five = readBulkAmount('5');
    if ('problem' in five) throw new Error(five.problem);
    expect(bulkNewPrice(price('17.28'), 'percent', five.value).toWire()).toBe('18.1400');
    const minus = readBulkAmount('-50');
    if ('problem' in minus) throw new Error(minus.problem);
    expect(bulkNewPrice(price('0.13'), 'percent', minus.value).toWire()).toBe('0.0700');
  });

  it('adds or takes off a fixed amount, rounded to cents', () => {
    const plus = readBulkAmount('1');
    const minus = readBulkAmount('-0.25');
    if ('problem' in plus || 'problem' in minus) throw new Error('bad amount');
    expect(bulkNewPrice(price('9.35'), 'fixed', plus.value).toWire()).toBe('10.3500');
    expect(bulkNewPrice(price('9.35'), 'fixed', minus.value).toWire()).toBe('9.1000');
    const tiny = readBulkAmount('0.0049');
    if ('problem' in tiny) throw new Error('bad amount');
    expect(bulkNewPrice(price('9.3500'), 'fixed', tiny.value).toWire()).toBe('9.3500');
  });

  it('can come out at zero or below: the caller refuses it', () => {
    const cut = readBulkAmount('-100');
    if ('problem' in cut) throw new Error(cut.problem);
    expect(bulkNewPrice(price('5'), 'percent', cut.value).isPositive()).toBe(false);
    expect(bulkNewPrice(price('5'), 'fixed', cut.value).isNegative()).toBe(true);
  });
});
