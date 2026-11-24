// Unit tests of the invoice rules: number, due date, VAT setting, totals and the checks on typed input.
import { describe, expect, it } from 'bun:test';
import { Money } from '@src/common/money';
import {
  checkDescription,
  dueAtOf,
  invoiceNumber,
  invoiceWireSide,
  isIssuedBy,
  isTransferTopUp,
  judgePriorTopUp,
  manualInvoiceTotals,
  MERCHANT_OPEN_TOPUPS,
  NOT_MERCHANT_PROBLEM,
  OPEN_TOPUPS_DETAIL,
  parseAmount,
  paymentRef,
  TOPUP_OPENING_GRACE_MS,
  tooManyOpenTopUps,
  tooManyPendingReceipts,
  topUpFingerprint,
  topupInvoiceTotals,
  vatRateFrom,
} from '@src/modules/money/domain/invoice-rules';

describe('invoiceNumber and paymentRef', () => {
  it('writes INV-<year>-<id padded to 4> and PAY-<id>', () => {
    expect(invoiceNumber(2026, 42)).toBe('INV-2026-0042');
    expect(invoiceNumber(2027, 12345)).toBe('INV-2027-12345');
    expect(paymentRef(1000)).toBe('PAY-1000');
  });
});

describe('dueAtOf', () => {
  it('adds whole days to the issue time', () => {
    expect(dueAtOf(new Date('2026-11-01T10:00:00.000Z'), 14).toISOString()).toBe('2026-11-15T10:00:00.000Z');
  });
});

describe('vatRateFrom', () => {
  it('reads a percent from 0 to 100 and anything else as no tax', () => {
    expect(vatRateFrom(16)).toBe('16');
    expect(vatRateFrom(' 7.5 ')).toBe('7.5');
    expect(vatRateFrom('100')).toBe('100');
    for (const bad of [undefined, null, 'lots', -1, 101, '1.23456', {}, '']) expect(vatRateFrom(bad)).toBe('0');
  });
});

describe('invoice totals', () => {
  it('a manual invoice: no fee, tax on the net, total = net + tax', () => {
    const totals = manualInvoiceTotals(Money.of('250'), '16');
    expect([totals.fee, totals.net, totals.tax, totals.total].map((m) => m.toWire())).toEqual([
      '0.0000',
      '250.0000',
      '40.0000',
      '290.0000',
    ]);
    expect(manualInvoiceTotals(Money.of('250'), '0').total.toWire()).toBe('250.0000');
  });

  it('a top-up invoice: the merchant pays the amount, the wallet gets amount minus fee', () => {
    const totals = topupInvoiceTotals(Money.of('100'), Money.of('3.2'), '0');
    expect([totals.amount, totals.fee, totals.net, totals.tax, totals.total].map((m) => m.toWire())).toEqual([
      '100.0000',
      '3.2000',
      '96.8000',
      '0.0000',
      '100.0000',
    ]);
    expect(topupInvoiceTotals(Money.of('100'), Money.of('3.2'), '10').tax.toWire()).toBe('9.6800');
  });
});

describe('parseAmount and checkDescription', () => {
  it('reads up to four decimals above zero', () => {
    expect('amount' in parseAmount('25.5') && parseAmount('25.5')).toHaveProperty('amount');
    for (const bad of ['0', '0.0000', '-1', 'abc', '1.23456', '', '1e3', ' ']) {
      const result = parseAmount(bad);
      expect('problem' in result && result.problem.field).toBe('amount');
    }
  });

  it('wants a description of 1 to 500 characters', () => {
    expect(checkDescription('Annual fee')).toBeUndefined();
    expect(checkDescription('')?.code).toBe('required');
    expect(checkDescription('x'.repeat(501))?.code).toBe('length');
  });
});

describe('the limits of decision 049', () => {
  it('refuses the sixth live top-up invoice and the sixth receipt in review', () => {
    expect(MERCHANT_OPEN_TOPUPS).toEqual({ max: 5, liveHours: 24 });
    expect(tooManyOpenTopUps(4)).toBe(false);
    expect(tooManyOpenTopUps(5)).toBe(true);
    expect(tooManyPendingReceipts(4)).toBe(false);
    expect(tooManyPendingReceipts(5)).toBe(true);
    expect(OPEN_TOPUPS_DETAIL).toBe('You have 5 unpaid top-up invoices. Pay one of them first, or try again later.');
  });

  it('isIssuedBy is true only for a manual invoice of that staff member', () => {
    expect(isIssuedBy({ kind: 'manual', issuedBy: 7 }, 7)).toBe(true);
    expect(isIssuedBy({ kind: 'manual', issuedBy: 7 }, 8)).toBe(false);
    expect(isIssuedBy({ kind: 'manual', issuedBy: null }, 7)).toBe(false);
    expect(isIssuedBy({ kind: 'topup', issuedBy: 7 }, 7)).toBe(false);
  });

  it('isTransferTopUp is true only for a top-up through a manual method', () => {
    expect(isTransferTopUp({ kind: 'topup' }, { isManual: true })).toBe(true);
    expect(isTransferTopUp({ kind: 'topup' }, { isManual: false })).toBe(false);
    expect(isTransferTopUp({ kind: 'manual' }, { isManual: true })).toBe(false);
  });
});

describe('topUpFingerprint', () => {
  it('names the gateway and the amount in one stable text, whatever the amount was typed as', () => {
    expect(topUpFingerprint(7, Money.of('50'))).toBe('[7,"50.0000"]');
    expect(topUpFingerprint(7, Money.of('50.00'))).toBe(topUpFingerprint(7, Money.of('50')));
    expect(topUpFingerprint(7, Money.of('50'))).not.toBe(topUpFingerprint(8, Money.of('50')));
    expect(topUpFingerprint(7, Money.of('50'))).not.toBe(topUpFingerprint(7, Money.of('50.0001')));
  });
});

describe('judgePriorTopUp: what a create does with the invoice an earlier request left under its key', () => {
  const now = new Date('2026-11-10T09:00:00.000Z');
  const request = { fingerprint: topUpFingerprint(7, Money.of('50')), walletKind: 'client_wallet' as const };
  const prior = (overrides: Partial<Parameters<typeof judgePriorTopUp>[0]> = {}) => ({
    requestFingerprint: request.fingerprint,
    walletKind: 'client_wallet' as const,
    status: 'open' as const,
    checkoutUrl: null,
    createdAt: new Date(now.getTime() - 5_000),
    ...overrides,
  });

  it('replays the same request, whatever the invoice has become since', () => {
    for (const status of ['open', 'paid', 'void'] as const) {
      expect(judgePriorTopUp(prior({ status }), request, true, now)).toBe('replay');
    }
    expect(judgePriorTopUp(prior({ checkoutUrl: 'https://pay.example/cs_1' }), request, false, now)).toBe('replay');
  });

  it('refuses the key for another gateway, another amount, another wallet kind or an invoice without a fingerprint', () => {
    expect(
      judgePriorTopUp(prior({ requestFingerprint: topUpFingerprint(8, Money.of('50')) }), request, true, now),
    ).toBe('reused');
    expect(
      judgePriorTopUp(prior({ requestFingerprint: topUpFingerprint(7, Money.of('60')) }), request, true, now),
    ).toBe('reused');
    expect(judgePriorTopUp(prior({ walletKind: 'customer_wallet' }), request, true, now)).toBe('reused');
    expect(judgePriorTopUp(prior({ requestFingerprint: null }), request, true, now)).toBe('reused');
  });

  it('holds a retry while an automatic top-up has no page yet, then lets it take over', () => {
    const opening = (age: number) => prior({ createdAt: new Date(now.getTime() - age) });
    expect(judgePriorTopUp(opening(1_000), request, false, now)).toBe('in_progress');
    expect(judgePriorTopUp(opening(TOPUP_OPENING_GRACE_MS - 1), request, false, now)).toBe('in_progress');
    expect(judgePriorTopUp(opening(TOPUP_OPENING_GRACE_MS), request, false, now)).toBe('restart');
    expect(judgePriorTopUp(opening(10 * TOPUP_OPENING_GRACE_MS), request, false, now)).toBe('restart');
  });

  it('never waits for the page of a manual top-up, and never restarts a top-up that is not open', () => {
    expect(judgePriorTopUp(prior({ createdAt: new Date(now.getTime() - 1_000) }), request, true, now)).toBe('replay');
    expect(judgePriorTopUp(prior({ status: 'void', createdAt: new Date(0) }), request, false, now)).toBe('replay');
    expect(judgePriorTopUp(prior({ status: 'paid', createdAt: new Date(0) }), request, false, now)).toBe('replay');
  });
});

describe('invoiceWireSide', () => {
  it('names the account the client of a merchant-wallet invoice and the customer of any other', () => {
    expect(invoiceWireSide({ kind: 'topup', walletKind: 'client_wallet' })).toBe('client');
    expect(invoiceWireSide({ kind: 'manual', walletKind: 'client_wallet' })).toBe('client');
    expect(invoiceWireSide({ kind: 'statement', walletKind: null })).toBe('client');
    expect(invoiceWireSide({ kind: 'topup', walletKind: 'customer_wallet' })).toBe('customer');
    expect(invoiceWireSide({ kind: 'receipt', walletKind: null })).toBe('customer');
  });
});

describe('NOT_MERCHANT_PROBLEM', () => {
  it('is the 422 the staff dialog shows under the Merchant field for a retail account', () => {
    expect(NOT_MERCHANT_PROBLEM).toMatchObject({ field: 'clientId', code: 'not_merchant' });
    expect(NOT_MERCHANT_PROBLEM.message).toContain('merchant');
  });
});
