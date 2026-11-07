// Unit tests of the invoice rules: number, due date, VAT setting, totals and the checks on typed input.
import { describe, expect, it } from 'bun:test';
import { Money } from '../../../common/money';
import {
  checkDescription,
  dueAtOf,
  invoiceNumber,
  manualInvoiceTotals,
  parseAmount,
  paymentRef,
  topupInvoiceTotals,
  vatRateFrom,
} from './invoice-rules';

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
