// Unit tests of the supplier health rules: the shared health word, its mapping for the suppliers page, the runway and the low balance.
import { describe, expect, it } from 'bun:test';
import {
  healthFromCalls,
  isLowBalance,
  runwayDays,
  successRate,
  supplierHealth,
  toPageHealth,
} from './supplier-health';

describe('healthFromCalls', () => {
  it('is unknown without calls', () => {
    expect(healthFromCalls({ total: 0, errors: 0, timeouts: 0 })).toBe('unknown');
  });

  it('counts errors and timeouts together against 5 % (degraded) and 20 % (down)', () => {
    expect(healthFromCalls({ total: 100, errors: 2, timeouts: 2 })).toBe('ok');
    expect(healthFromCalls({ total: 100, errors: 3, timeouts: 2 })).toBe('degraded');
    expect(healthFromCalls({ total: 100, errors: 10, timeouts: 10 })).toBe('down');
  });

  it('never calls a supplier down on fewer than 5 calls', () => {
    expect(healthFromCalls({ total: 2, errors: 2, timeouts: 0 })).toBe('degraded');
    expect(healthFromCalls({ total: 5, errors: 5, timeouts: 0 })).toBe('down');
  });
});

describe('supplierHealth', () => {
  const quiet = { total: 0, errors: 0, timeouts: 0 };

  it('uses a fresh periodic check, and the calls when the check is old or unknown', () => {
    expect(supplierHealth({ status: 'active', check: { status: 'down', ageMs: 60_000 }, calls: quiet })).toBe('down');
    expect(supplierHealth({ status: 'active', check: { status: 'down', ageMs: 11 * 60_000 }, calls: quiet })).toBe(
      'unknown',
    );
    expect(
      supplierHealth({
        status: 'active',
        check: { status: 'unknown', ageMs: 1000 },
        calls: { total: 10, errors: 3, timeouts: 0 },
      }),
    ).toBe('down');
  });

  it('reads a disabled supplier as unknown, and a paused one like an active one', () => {
    expect(supplierHealth({ status: 'disabled', check: { status: 'ok', ageMs: 1 }, calls: quiet })).toBe('unknown');
    expect(supplierHealth({ status: 'paused', check: { status: 'degraded', ageMs: 1 }, calls: quiet })).toBe(
      'degraded',
    );
  });
});

describe('toPageHealth', () => {
  it('maps ok and unknown to up (orders-suppliers-5)', () => {
    expect(['ok', 'unknown', 'degraded', 'down'].map((word) => toPageHealth(word as never))).toEqual([
      'up',
      'up',
      'degraded',
      'down',
    ]);
  });
});

describe('runwayDays and isLowBalance', () => {
  it('is balance x rate over the daily spend, one decimal, null without spend (orders-suppliers-7)', () => {
    expect(runwayDays({ balance: '1850.0000', creditRate: '1.00000000', weeklySpend: '700.0000' })).toBe(18.5);
    expect(runwayDays({ balance: '100.0000', creditRate: '2.00000000', weeklySpend: '70.0000' })).toBe(20);
    expect(runwayDays({ balance: '100.0000', creditRate: '1', weeklySpend: '0.0000' })).toBeNull();
  });

  it('is low below the alert amount or under two days of spending', () => {
    expect(isLowBalance({ balance: '100.0000', lowBalanceAlert: '150.0000', runwayDays: null })).toBe(true);
    expect(isLowBalance({ balance: '500.0000', lowBalanceAlert: '150.0000', runwayDays: 1.9 })).toBe(true);
    expect(isLowBalance({ balance: '500.0000', lowBalanceAlert: '150.0000', runwayDays: 2 })).toBe(false);
    expect(isLowBalance({ balance: '150.0000', lowBalanceAlert: '150.0000', runwayDays: null })).toBe(false);
  });
});

describe('successRate', () => {
  it('is the percentage of calls that worked with one decimal, null without calls', () => {
    expect(successRate(97, 100)).toBe(97);
    expect(successRate(2, 3)).toBe(66.7);
    expect(successRate(0, 0)).toBeNull();
  });
});
