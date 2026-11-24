// Unit tests of the storefront refund rules (feature 16): what is left to refund, how a refund is paid out, the check of an approval's amount,
// and which refunds a chargeback closes (decision 048).
import { describe, expect, it } from 'bun:test';
import { Money } from '@src/common/money';
import {
  CRYPTO_REFUND_NOTE,
  MANUAL_REFUND_NOTE,
  NOTHING_LEFT_MESSAGE,
  b2cWalletRefundPosting,
  checkApproval,
  closesAtChargeback,
  REFUND_RESEND_WINDOW_MS,
  refundRoute,
  refundSendKey,
  refundableLeft,
  resendNeedsGatewayCheck,
  settlesAtOnce,
  wholeCents,
} from '@src/modules/money/domain/refund-rules';

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

  it('returns a store balance payment to the balance, whatever a gateway could do (plan 21 O10)', () => {
    expect(refundRoute('balance', { supportsRefunds: false, driverRefunds: false })).toEqual({
      method: 'original',
      note: '',
    });
  });
});

describe('settlesAtOnce', () => {
  it('completes a hand payout and a refund to the store balance at once, never a gateway refund (plan 21 § 5.6.7)', () => {
    expect(settlesAtOnce('manual', 'card')).toBe(true);
    expect(settlesAtOnce('original', 'balance')).toBe(true);
    expect(settlesAtOnce('original', 'card')).toBe(false);
    expect(settlesAtOnce('original', 'wallet')).toBe(false);
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

describe('closesAtChargeback (decision 048)', () => {
  it('closes a request, a refund waiting to be sent and one that failed, also with a gateway id', () => {
    expect(closesAtChargeback({ status: 'requested', gatewayRefundId: null })).toBe(true);
    expect(closesAtChargeback({ status: 'processing', gatewayRefundId: null })).toBe(true);
    expect(closesAtChargeback({ status: 'failed', gatewayRefundId: null })).toBe(true);
    expect(closesAtChargeback({ status: 'failed', gatewayRefundId: 're_1' })).toBe(true);
  });

  it('leaves a refund the gateway acknowledged, a completed one and a closed one', () => {
    expect(closesAtChargeback({ status: 'processing', gatewayRefundId: 're_1' })).toBe(false);
    expect(closesAtChargeback({ status: 'completed', gatewayRefundId: 're_1' })).toBe(false);
    expect(closesAtChargeback({ status: 'completed', gatewayRefundId: null })).toBe(false);
    expect(closesAtChargeback({ status: 'rejected', gatewayRefundId: null })).toBe(false);
  });
});

describe('resendNeedsGatewayCheck', () => {
  const sent = new Date('2026-11-07T12:00:00.000Z');
  const after = (ms: number) => new Date(sent.getTime() + ms);

  it('is false when no send under the key went unanswered', () => {
    expect(resendNeedsGatewayCheck(null, after(30 * 24 * 60 * 60_000))).toBe(false);
  });

  it('is false up to 20 hours after the unanswered send: the gateway still knows the key', () => {
    expect(REFUND_RESEND_WINDOW_MS).toBe(20 * 60 * 60_000);
    expect(resendNeedsGatewayCheck(sent, after(0))).toBe(false);
    expect(resendNeedsGatewayCheck(sent, after(REFUND_RESEND_WINDOW_MS))).toBe(false);
  });

  it('is true after that: the gateway may have forgotten the key and could refund again', () => {
    expect(resendNeedsGatewayCheck(sent, after(REFUND_RESEND_WINDOW_MS + 1))).toBe(true);
    expect(resendNeedsGatewayCheck(sent, after(25 * 60 * 60_000))).toBe(true);
  });
});

/** The lines of a posting as `debit`/`credit` words: kind, owner and the amount on its side. */
const linesOf = (
  lines: ReadonlyArray<{
    account: { kind: string; ownerType?: string; ownerId?: number };
    debit: Money;
    credit: Money;
  }>,
) =>
  lines.map((line) => ({
    account:
      line.account.ownerType === undefined
        ? line.account.kind
        : `${line.account.kind}:${line.account.ownerType}:${line.account.ownerId}`,
    debit: line.debit.toWire(),
    credit: line.credit.toWire(),
  }));

describe('b2cWalletRefundPosting (decision 064)', () => {
  const input = { accountId: 7, net: m('3.99'), vat: m('0.80') };

  it('credits the store balance of the account when that is its live wallet, from customer funds before delivery', () => {
    const posting = b2cWalletRefundPosting({ wallet: 'customer_wallet', ...input });
    expect(posting).toMatchObject({ event: 'b2c_wallet_refund', kind: 'refund', refType: 'order' });
    expect(linesOf(posting.lines)).toEqual([
      { account: 'customer_funds', debit: '3.9900', credit: '0.0000' },
      { account: 'vat_payable', debit: '0.8000', credit: '0.0000' },
      { account: 'customer_wallet:account:7', debit: '0.0000', credit: '4.7900' },
    ]);
  });

  it('credits the merchant wallet when the account holds a merchant rank now, from revenue after delivery', () => {
    const posting = b2cWalletRefundPosting({ wallet: 'client_wallet', ...input, from: 'revenue' });
    expect(linesOf(posting.lines)).toEqual([
      { account: 'revenue', debit: '3.9900', credit: '0.0000' },
      { account: 'vat_payable', debit: '0.8000', credit: '0.0000' },
      { account: 'client_wallet:account:7', debit: '0.0000', credit: '4.7900' },
    ]);
  });

  it('always posts balanced lines and names the owner with the one word account, never the inactive wallet', () => {
    for (const wallet of ['client_wallet', 'customer_wallet'] as const) {
      const posting = b2cWalletRefundPosting({ wallet, ...input });
      const debit = posting.lines.reduce((sum, line) => sum.add(line.debit), Money.zero());
      const credit = posting.lines.reduce((sum, line) => sum.add(line.credit), Money.zero());
      expect(debit.toWire()).toBe(credit.toWire());
      const walletLines = posting.lines.filter((line) => line.account.kind.endsWith('_wallet'));
      expect(walletLines.map((line) => line.account.kind)).toEqual([wallet]);
      expect(walletLines.every((line) => line.account.ownerType === 'account')).toBe(true);
    }
  });

  it('leaves out a zero VAT line, and refuses a negative amount', () => {
    const noVat = b2cWalletRefundPosting({ wallet: 'customer_wallet', accountId: 7, net: m('2'), vat: m('0') });
    expect(noVat.lines.map((line) => line.account.kind)).toEqual(['customer_funds', 'customer_wallet']);
    expect(() =>
      b2cWalletRefundPosting({ wallet: 'customer_wallet', accountId: 7, net: m('-1'), vat: m('0') }),
    ).toThrow(RangeError);
  });
});
