// Unit tests of the storefront refund rules (feature 16): what is left to refund, how a refund is paid out, and the check of an approval's amount.
import { describe, expect, it } from 'bun:test';
import { Money } from '../../../common/money';
import {
  CRYPTO_REFUND_NOTE,
  MANUAL_REFUND_NOTE,
  NOTHING_LEFT_MESSAGE,
  checkApproval,
  refundRoute,
  refundSendKey,
  refundableLeft,
  wholeCents,
} from './refund-rules';

const m = (amount: string): Money => Money.of(amount);

describe('refundableLeft', () => {
  it('is what was paid minus the refunds completed or on their way', () => {
    expect(refundableLeft(m('3.84'), m('0')).toWire()).toBe('3.8400');
    expect(refundableLeft(m('3.84'), m('0.80')).toWire()).toBe('3.0400');
    expect(refundableLeft(m('3.84'), m('3.84')).toWire()).toBe('0.0000');
  });

  it('is never negative', () => {
    expect(refundableLeft(m('3.84'), m('5')).toWire()).toBe('0.0000');
  });
});

describe('refundRoute', () => {
  const capable = { supportsRefunds: true, driverRefunds: true };

  it('a card or wallet payment goes back through the gateway', () => {
    expect(refundRoute('card', capable)).toEqual({ method: 'original', note: '' });
    expect(refundRoute('wallet', capable)).toEqual({ method: 'original', note: '' });
  });

  it('a crypto payment is paid out by hand whatever the gateway can do', () => {
    expect(refundRoute('crypto', capable)).toEqual({ method: 'manual', note: CRYPTO_REFUND_NOTE });
  });

  it('a gateway that is not set up for refunds, or whose driver cannot send one, is paid out by hand', () => {
    expect(refundRoute('card', { supportsRefunds: false, driverRefunds: true })).toEqual({
      method: 'manual',
      note: MANUAL_REFUND_NOTE,
    });
    expect(refundRoute('card', { supportsRefunds: true, driverRefunds: false })).toEqual({
      method: 'manual',
      note: MANUAL_REFUND_NOTE,
    });
  });
});

describe('checkApproval', () => {
  const base = { requested: undefined, onRequestUsd: m('4.79'), leftUsd: m('4.79'), delivered: true };

  it('takes the amount on the request when staff type none', () => {
    expect(checkApproval(base)).toEqual({ ok: true, amountUsd: m('4.79') });
    expect(checkApproval({ ...base, onRequestUsd: m('1.20') })).toEqual({ ok: true, amountUsd: m('1.20') });
  });

  it('takes the amount staff typed, from one cent to everything left', () => {
    expect(checkApproval({ ...base, requested: m('0.01') })).toEqual({ ok: true, amountUsd: m('0.01') });
    expect(checkApproval({ ...base, requested: m('2.50') })).toEqual({ ok: true, amountUsd: m('2.50') });
    expect(checkApproval({ ...base, requested: m('4.79') })).toEqual({ ok: true, amountUsd: m('4.79') });
  });

  it('refuses zero, a negative amount, less than a cent and more than is left, with the sentence of the dialog', () => {
    for (const requested of ['0', '-1', '0.009', '4.80']) {
      expect(checkApproval({ ...base, requested: m(requested) })).toEqual({
        ok: false,
        field: 'amount',
        message: 'Enter an amount between $0.01 and $4.79.',
      });
    }
  });

  it('says nothing is left when no cent can go back, whatever amount was asked', () => {
    for (const leftUsd of ['0', '0.0000', '0.0099']) {
      for (const requested of [undefined, m('1'), m('0')]) {
        expect(checkApproval({ ...base, leftUsd: m(leftUsd), requested })).toEqual({
          ok: false,
          field: 'amount',
          message: 'Nothing is left to refund on this payment.',
        });
      }
    }
    expect(NOTHING_LEFT_MESSAGE).toBe('Nothing is left to refund on this payment.');
    // One cent is still something to refund.
    expect(checkApproval({ ...base, leftUsd: m('0.01'), requested: m('0.01') })).toEqual({
      ok: true,
      amountUsd: m('0.01'),
    });
  });

  it('prints what is left with two decimals, or four when the last two are not zero', () => {
    const check = checkApproval({ ...base, leftUsd: m('3.7923'), requested: m('4') });
    expect(check).toMatchObject({ ok: false, message: 'Enter an amount between $0.01 and $3.7923.' });
  });

  it('an order that was not delivered is cancelled, so only everything left is accepted', () => {
    const undelivered = { ...base, delivered: false };
    expect(checkApproval(undelivered)).toEqual({ ok: true, amountUsd: m('4.79') });
    expect(checkApproval({ ...undelivered, requested: m('4.79') })).toEqual({ ok: true, amountUsd: m('4.79') });
    expect(checkApproval({ ...undelivered, requested: m('1') })).toEqual({
      ok: false,
      field: 'amount',
      message: 'This order was not delivered, so it is cancelled and refunded in full: $4.79.',
    });
  });
});

describe('refundSendKey', () => {
  it('is refund-<id> for the first send and moves to refund-<id>-<n> for the next ones', () => {
    expect(refundSendKey(7, 1)).toBe('refund-7');
    expect(refundSendKey(7, 2)).toBe('refund-7-2');
    expect(refundSendKey(7, 11)).toBe('refund-7-11');
    expect(refundSendKey(7, 0)).toBe('refund-7');
  });
});

describe('wholeCents', () => {
  it('prints two decimals, four when the last two are not zero', () => {
    expect(wholeCents(m('4.79'))).toBe('4.79');
    expect(wholeCents(m('4.7900'))).toBe('4.79');
    expect(wholeCents(m('4.7889'))).toBe('4.7889');
    expect(wholeCents(m('0'))).toBe('0.00');
    expect(wholeCents(m('1234.5'))).toBe('1234.50');
  });
});
