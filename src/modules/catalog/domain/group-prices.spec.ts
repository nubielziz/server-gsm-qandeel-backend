// Unit tests of the group price set check: unknown and repeated groups, the floor of a merchant group row and the storefront
// floor of the retail row, reported together with their dotted paths.
import { describe, expect, it } from 'bun:test';
import { Money } from '../../../common/money';
import { type GroupFloor, groupPriceProblems } from './group-prices';

const m = (text: string) => Money.of(text);
const floor = (cost: string, minProfit: string): GroupFloor => ({
  cost: m(cost),
  minProfit: m(minProfit),
  floor: m(cost).add(m(minProfit)),
});

const GROUPS = new Map([
  [1, { isRetail: false }],
  [2, { isRetail: false }],
  [9, { isRetail: true }],
]);
const FLOORS = new Map([
  [1, floor('13.5', '0.81')],
  [2, floor('13.5', '1.00')],
  [9, floor('13.5', '0.81')],
]);
const BASE = m('17.28');
const check = (rows: Array<[number, string]>) =>
  groupPriceProblems(
    rows.map(([groupId, price]) => ({ groupId, price: m(price) })),
    GROUPS,
    FLOORS,
    BASE,
  );

describe('groupPriceProblems', () => {
  it('accepts a set at or above every floor, the retail row at the storefront floor', () => {
    // storefront floor: max(round(17.28 x 1.10, 2) = 19.01, 14.31) = 19.01
    expect(
      check([
        [1, '14.31'],
        [2, '15'],
        [9, '19.01'],
      ]),
    ).toEqual([]);
    expect(check([])).toEqual([]);
  });

  it('refuses a merchant group row under its own floor, with the demo wording', () => {
    expect(
      check([
        [1, '14.30'],
        [2, '14.49'],
      ]),
    ).toEqual([
      { field: 'prices.0.price', message: 'Below the floor of $14.31 (cost $13.50 plus $0.81 minimum profit).' },
      { field: 'prices.1.price', message: 'Below the floor of $14.50 (cost $13.50 plus $1.00 minimum profit).' },
    ]);
  });

  it('refuses the retail row under the storefront floor', () => {
    expect(check([[9, '19.00']])).toEqual([
      { field: 'prices.0.price', message: 'Below the storefront floor of $19.01.' },
    ]);
  });

  it('names the later occurrence of a repeated group, and an unknown group', () => {
    expect(
      check([
        [1, '15'],
        [2, '15'],
        [1, '16'],
        [404, '5'],
      ]),
    ).toEqual([
      { field: 'prices.2.groupId', message: 'Listed twice' },
      { field: 'prices.3.groupId', message: 'This group does not exist.' },
    ]);
  });

  it('reports every problem together', () => {
    const problems = check([
      [1, '1'],
      [1, '1'],
      [9, '1'],
      [77, '1'],
    ]);
    expect(problems.map((problem) => problem.field)).toEqual([
      'prices.0.price',
      'prices.1.groupId',
      'prices.1.price',
      'prices.2.price',
      'prices.3.groupId',
    ]);
  });
});
