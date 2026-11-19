// Unit tests of the quantity rule of a service (feature 25).
import { describe, expect, it } from 'bun:test';
import {
  type QuantityRule,
  quantityRuleProblems,
  resolveQuantityRule,
} from '@src/modules/catalog/domain/quantity-rule';

const NEW: QuantityRule = { minQty: 1, maxQty: 1, qtyOptions: [] };

const errorsOf = (current: QuantityRule, change: Parameters<typeof resolveQuantityRule>[1]) => {
  const outcome = resolveQuantityRule(current, change);
  if (outcome.ok) throw new Error('expected a refusal');
  return outcome.errors;
};
const ruleOf = (current: QuantityRule, change: Parameters<typeof resolveQuantityRule>[1]) => {
  const outcome = resolveQuantityRule(current, change);
  if (!outcome.ok) throw new Error(`expected a rule: ${JSON.stringify(outcome.errors)}`);
  return outcome.rule;
};

describe('resolveQuantityRule: ranges', () => {
  it('keeps the current rule when nothing is sent', () => {
    expect(ruleOf({ minQty: 2, maxQty: 9, qtyOptions: [] }, {})).toEqual({ minQty: 2, maxQty: 9, qtyOptions: [] });
  });
  it('accepts a range and changes only the keys sent', () => {
    expect(ruleOf(NEW, { minQty: 1, maxQty: 50 })).toEqual({ minQty: 1, maxQty: 50, qtyOptions: [] });
    expect(ruleOf({ minQty: 2, maxQty: 9, qtyOptions: [] }, { maxQty: 20 })).toEqual({
      minQty: 2,
      maxQty: 20,
      qtyOptions: [],
    });
  });
  it('rule 1: a largest below the smallest is below_min on maxQty', () => {
    expect(errorsOf({ minQty: 5, maxQty: 9, qtyOptions: [] }, { maxQty: 3 })).toEqual([
      { field: 'maxQty', code: 'below_min', message: 'The largest quantity cannot be below the smallest (5).' },
    ]);
    expect(errorsOf(NEW, { minQty: 8, maxQty: 3 })[0]).toMatchObject({ field: 'maxQty', code: 'below_min' });
  });
  it('rule 2: a smallest above the stored largest is above_max on minQty (create with minQty alone)', () => {
    expect(errorsOf(NEW, { minQty: 5 })).toEqual([
      { field: 'minQty', code: 'above_max', message: 'The smallest quantity cannot be above the largest (1).' },
    ]);
  });
});

describe('resolveQuantityRule: packs', () => {
  it('sorts the packs and derives the smallest and largest', () => {
    expect(ruleOf(NEW, { qtyOptions: [25, 5, 10] })).toEqual({ minQty: 5, maxQty: 25, qtyOptions: [5, 10, 25] });
  });
  it('accepts a sent minQty and maxQty equal to the derived ones', () => {
    expect(ruleOf(NEW, { minQty: 5, maxQty: 25, qtyOptions: [25, 5] })).toEqual({
      minQty: 5,
      maxQty: 25,
      qtyOptions: [5, 25],
    });
  });
  it('rule 6: a minQty or maxQty that disagrees with the packs is packs_set', () => {
    expect(errorsOf(NEW, { minQty: 1, qtyOptions: [5, 10] })).toEqual([
      {
        field: 'minQty',
        code: 'packs_set',
        message:
          'This service sells fixed packs, so its smallest quantity is the smallest pack (5). Clear the packs to set a range.',
      },
    ]);
    expect(errorsOf(NEW, { maxQty: 99, qtyOptions: [5, 10] })).toEqual([
      {
        field: 'maxQty',
        code: 'packs_set',
        message:
          'This service sells fixed packs, so its largest quantity is the largest pack (10). Clear the packs to set a range.',
      },
    ]);
  });
  it('rule 6 also applies to the stored packs when only a bound is sent', () => {
    const current = { minQty: 5, maxQty: 10, qtyOptions: [5, 10] };
    expect(errorsOf(current, { maxQty: 20 })[0]).toMatchObject({ field: 'maxQty', code: 'packs_set' });
  });
  it('returns both packs_set problems together', () => {
    expect(errorsOf(NEW, { minQty: 1, maxQty: 99, qtyOptions: [5, 10] }).map((e) => e.field)).toEqual([
      'minQty',
      'maxQty',
    ]);
  });
  it('rule 3: a pack that is not a whole number from 1 to 100000 is invalid_pack (the first bad one)', () => {
    for (const bad of [0, -3, 1.5, 100_001, Number.NaN]) {
      expect(errorsOf(NEW, { qtyOptions: [5, bad, 7] })).toEqual([
        {
          field: 'qtyOptions',
          code: 'invalid_pack',
          message: `Pack sizes are whole numbers from 1 to 100000; ${bad} is not.`,
        },
      ]);
    }
  });
  it('rule 4: a repeated pack is duplicate_pack (the first repeat)', () => {
    expect(errorsOf(NEW, { qtyOptions: [5, 10, 10, 5] })).toEqual([
      { field: 'qtyOptions', code: 'duplicate_pack', message: 'The pack size 10 is repeated.' },
    ]);
  });
  it('an empty list clears the packs and keeps the stored smallest and largest', () => {
    const current = { minQty: 5, maxQty: 25, qtyOptions: [5, 10, 25] };
    expect(ruleOf(current, { qtyOptions: [] })).toEqual({ minQty: 5, maxQty: 25, qtyOptions: [] });
    expect(ruleOf(current, { minQty: 1, maxQty: 30, qtyOptions: [] })).toEqual({
      minQty: 1,
      maxQty: 30,
      qtyOptions: [],
    });
  });
  it('clearing the packs with a bad range returns the range problem', () => {
    const current = { minQty: 5, maxQty: 25, qtyOptions: [5, 25] };
    expect(errorsOf(current, { maxQty: 2, qtyOptions: [] })[0]).toMatchObject({ field: 'maxQty', code: 'below_min' });
  });
  it('heals a stored row whose minimum is not a pack the next time a quantity key is sent', () => {
    const stored = { minQty: 1, maxQty: 1, qtyOptions: [10, 20] };
    expect(ruleOf(stored, { qtyOptions: [20, 10] })).toEqual({ minQty: 10, maxQty: 20, qtyOptions: [10, 20] });
    expect(ruleOf(stored, {})).toEqual({ minQty: 10, maxQty: 20, qtyOptions: [10, 20] });
  });
  it('does not change the input arrays', () => {
    const packs = [25, 5];
    ruleOf(NEW, { qtyOptions: packs });
    expect(packs).toEqual([25, 5]);
    const stored = { minQty: 1, maxQty: 1, qtyOptions: [10, 5] };
    ruleOf(stored, { minQty: 5 });
    expect(stored.qtyOptions).toEqual([10, 5]);
  });
});

describe('quantityRuleProblems', () => {
  it('accepts good rules', () => {
    expect(quantityRuleProblems({ minQty: 1, maxQty: 1, qtyOptions: [] })).toEqual([]);
    expect(quantityRuleProblems({ minQty: 2, maxQty: 100_000, qtyOptions: [] })).toEqual([]);
    expect(quantityRuleProblems({ minQty: 5, maxQty: 25, qtyOptions: [5, 10, 25] })).toEqual([]);
  });
  it('names each problem of a bad rule', () => {
    expect(quantityRuleProblems({ minQty: 0, maxQty: 1, qtyOptions: [] })).not.toEqual([]);
    expect(quantityRuleProblems({ minQty: 1, maxQty: 100_001, qtyOptions: [] })).not.toEqual([]);
    expect(quantityRuleProblems({ minQty: 5, maxQty: 2, qtyOptions: [] })).not.toEqual([]);
    expect(quantityRuleProblems({ minQty: 5, maxQty: 25, qtyOptions: [5, 5, 25] })).not.toEqual([]);
    expect(quantityRuleProblems({ minQty: 5, maxQty: 25, qtyOptions: [25, 5] })).not.toEqual([]);
    expect(quantityRuleProblems({ minQty: 1, maxQty: 25, qtyOptions: [5, 25] })).not.toEqual([]);
    expect(quantityRuleProblems({ minQty: 5, maxQty: 25, qtyOptions: [5, 0, 25] })).not.toEqual([]);
    const many = Array.from({ length: 51 }, (_, i) => i + 1);
    expect(quantityRuleProblems({ minQty: 1, maxQty: 51, qtyOptions: many })).not.toEqual([]);
  });
});
