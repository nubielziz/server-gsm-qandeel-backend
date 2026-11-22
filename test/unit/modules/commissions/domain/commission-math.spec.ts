// Unit tests of the commission arithmetic (feature 11): the amount of an accrual, its period and the audit text of an amount.
import { describe, expect, it } from 'bun:test';
import { Money } from '@src/common/money';
import {
  accrualAmount,
  cappedAccruals,
  commissionRoom,
  moneyText,
  periodOf,
} from '@src/modules/commissions/domain/commission-math';

describe('accrualAmount', () => {
  it('is revenue times the rate, with the demo numbers (16.26 at 3 percent is 0.4878)', () => {
    expect(accrualAmount(Money.of('16.26'), '3.0000').toWire()).toBe('0.4878');
    expect(accrualAmount(Money.of('20.99'), '5.0000').toWire()).toBe('1.0495');
  });

  it('rounds half up at the fourth decimal', () => {
    // 0.0150 x 0.5 / 100 = 0.000075 -> 0.0001
    expect(accrualAmount(Money.of('0.015'), '0.5000').toWire()).toBe('0.0001');
    expect(accrualAmount(Money.of('0.001'), '0.5000').toWire()).toBe('0.0000');
  });

  it('keeps a fractional percent exactly (3.55 percent of 100)', () => {
    expect(accrualAmount(Money.of('100'), '3.5500').toWire()).toBe('3.5500');
  });
});

describe('periodOf', () => {
  it('is the completion month in UTC', () => {
    expect(periodOf(new Date('2026-11-07T08:00:00.000Z'))).toBe('2026-11');
  });

  it('puts the last millisecond of a month in that month and the next one in the next', () => {
    expect(periodOf(new Date('2026-10-31T23:59:59.999Z'))).toBe('2026-10');
    expect(periodOf(new Date('2026-11-01T00:00:00.000Z'))).toBe('2026-11');
  });
});

describe('moneyText', () => {
  it('writes a dollar sign and at least two decimals, without needless zeros', () => {
    expect(moneyText(Money.of('1.05'))).toBe('$1.05');
    expect(moneyText(Money.of('3'))).toBe('$3.00');
    expect(moneyText(Money.of('0.2166'))).toBe('$0.2166');
    expect(moneyText(Money.of('12.5'))).toBe('$12.50');
  });
});

describe('commissionRoom (decision 049)', () => {
  it('is the margin less what the order holds, never below zero', () => {
    expect(commissionRoom(Money.of('17.28'), Money.of('13.50'), Money.zero()).toWire()).toBe('3.7800');
    expect(commissionRoom(Money.of('10'), Money.of('9.8'), Money.of('0.1')).toWire()).toBe('0.1000');
    expect(commissionRoom(Money.of('10'), Money.of('12'), Money.zero()).toWire()).toBe('0.0000');
  });
});

describe('cappedAccruals (decision 049)', () => {
  const plan = (planId: number, kind: 'rebate' | 'referral', percent: string) => ({
    beneficiaryId: planId * 10,
    planId,
    kind,
    percent,
    isActive: true,
  });

  it('pays the rebate first and never more than the room', () => {
    const thin = cappedAccruals(Money.of('10'), Money.of('0.2'), [
      plan(1, 'rebate', '15.0000'),
      plan(2, 'referral', '3.0000'),
    ]);
    expect(thin.accruals.map((row) => [row.plan.planId, row.amount.toWire(), row.capped])).toEqual([
      [1, '0.2000', true],
    ]);
    expect(thin.outOfBounds).toEqual([]);

    const wide = cappedAccruals(Money.of('17.28'), Money.of('3.78'), [
      plan(1, 'rebate', '1.5000'),
      plan(2, 'referral', '3.0000'),
    ]);
    expect(wide.accruals.map((row) => [row.plan.planId, row.amount.toWire(), row.capped])).toEqual([
      [1, '0.2592', false],
      [2, '0.5184', false],
    ]);
  });

  it('gives nothing to a plan stored outside 0.5 to 15 percent, nor when there is no room', () => {
    const odd = cappedAccruals(Money.of('17.28'), Money.of('3.78'), [
      plan(1, 'rebate', '20.0000'),
      plan(2, 'referral', '0.0000'),
    ]);
    expect(odd.accruals).toEqual([]);
    expect(odd.outOfBounds.map((row) => row.planId)).toEqual([1, 2]);
    expect(cappedAccruals(Money.of('10'), Money.zero(), [plan(1, 'rebate', '3.0000')]).accruals).toEqual([]);
  });
});
