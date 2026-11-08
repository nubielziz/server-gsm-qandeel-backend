// Unit tests of the pure figures of the reports (feature 11): the day window, the default profit range, the ranking and totals of the
// profit rows, the rejection rate, the rounded mean seconds and the credit in use.
import { describe, expect, it } from 'bun:test';
import { Money } from '../../../common/money';
import {
  type ProfitBucket,
  dayWindow,
  defaultProfitRange,
  isOrderedRange,
  overdraftUsed,
  profitRows,
  rejectionRate,
  roundSeconds,
} from './report-figures';

const m = (amount: string): Money => Money.of(amount);
const bucket = (key: string, label: string, orders: number, revenue: string, cost: string): ProfitBucket => ({
  key,
  label,
  orders,
  revenue: m(revenue),
  cost: m(cost),
});

describe('dayWindow', () => {
  it('runs from the first midnight to the midnight after the last day (both days included)', () => {
    const { start, end } = dayWindow('2026-11-01', '2026-11-03');
    expect(start.toISOString()).toBe('2026-11-01T00:00:00.000Z');
    expect(end.toISOString()).toBe('2026-11-04T00:00:00.000Z');
  });

  it('is one day long for a single day', () => {
    const { start, end } = dayWindow('2026-02-28', '2026-02-28');
    expect(end.getTime() - start.getTime()).toBe(86_400_000);
  });

  it('crosses a month and a year end', () => {
    expect(dayWindow('2026-12-31', '2026-12-31').end.toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });
});

describe('isOrderedRange and defaultProfitRange', () => {
  it('accepts a range whose first day is not after the last', () => {
    expect(isOrderedRange('2026-11-01', '2026-11-01')).toBe(true);
    expect(isOrderedRange('2026-11-01', '2026-11-02')).toBe(true);
    expect(isOrderedRange('2026-11-02', '2026-11-01')).toBe(false);
  });

  it('defaults to the 30 days ending today', () => {
    expect(defaultProfitRange(new Date('2026-11-07T15:30:00.000Z'))).toEqual({ from: '2026-10-09', to: '2026-11-07' });
  });

  it('counts the 30 days back from a `to` the client sent', () => {
    expect(defaultProfitRange(new Date('2026-11-07T15:30:00.000Z'), '2026-03-31')).toEqual({
      from: '2026-03-02',
      to: '2026-03-31',
    });
  });
});

describe('profitRows', () => {
  const buckets = [
    bucket('3', 'Beta', 2, '20.0000', '18.0000'),
    bucket('1', 'Alpha', 5, '50.0000', '35.0000'),
    bucket('2', 'Gamma', 1, '10.0000', '12.5000'),
  ];

  it('ranks the splits by profit, highest first, and a loss is negative', () => {
    const { rows } = profitRows('service', buckets);
    expect(rows.map((row) => [row.label, row.profit])).toEqual([
      ['Alpha', '15.0000'],
      ['Beta', '2.0000'],
      ['Gamma', '-2.5000'],
    ]);
  });

  it('runs the days oldest first whatever the profit', () => {
    const days = [
      bucket('2026-11-03', '2026-11-03', 1, '5.0000', '1.0000'),
      bucket('2026-11-01', '2026-11-01', 1, '2.0000', '1.5000'),
    ];
    expect(profitRows('day', days).rows.map((row) => row.key)).toEqual(['2026-11-01', '2026-11-03']);
  });

  it('breaks a tie of profit by label and then by key, so the order never flickers', () => {
    const tied = [
      bucket('9', 'Same', 1, '4.0000', '2.0000'),
      bucket('4', 'Same', 1, '4.0000', '2.0000'),
      bucket('5', 'Alpha', 1, '4.0000', '2.0000'),
    ];
    expect(profitRows('client', tied).rows.map((row) => row.key)).toEqual(['5', '4', '9']);
  });

  it('adds the totals over every group', () => {
    expect(profitRows('service', buckets).totals).toEqual({
      orders: 8,
      revenue: '80.0000',
      cost: '65.5000',
      profit: '14.5000',
    });
  });

  it('answers zero totals and no rows for an empty range', () => {
    expect(profitRows('day', [])).toEqual({
      rows: [],
      totals: { orders: 0, revenue: '0.0000', cost: '0.0000', profit: '0.0000' },
    });
  });
});

describe('rejectionRate', () => {
  it('is rejected over finished orders, as a percent', () => {
    expect(rejectionRate(39, 4)).toBeCloseTo(9.3023, 3);
    expect(rejectionRate(0, 3)).toBe(100);
    expect(rejectionRate(5, 0)).toBe(0);
  });

  it('is null while nothing has finished', () => {
    expect(rejectionRate(0, 0)).toBeNull();
  });
});

describe('roundSeconds and overdraftUsed', () => {
  it('rounds a mean to one decimal and keeps null', () => {
    expect(roundSeconds(97.0887435897436)).toBe(97.1);
    expect(roundSeconds(null)).toBeNull();
  });

  it('is the credit in use: positive only for a negative balance, not capped by any limit', () => {
    expect(overdraftUsed(m('-120.5')).toWire()).toBe('120.5000');
    expect(overdraftUsed(m('10')).toWire()).toBe('0.0000');
    expect(overdraftUsed(Money.zero()).toWire()).toBe('0.0000');
  });
});
