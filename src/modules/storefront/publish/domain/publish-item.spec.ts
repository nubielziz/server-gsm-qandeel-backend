// Unit tests of the publish row rules (feature 31, plan 31 section 8.1): the price table of apply (`decidePrice`, every row, with
// the floor moved, and each row priced by the rule against the publish limit and the order of its checks), the price mode
// (`normalisePriceMode`), the state, flags and tick (`evaluateItem`), the flags after an edit (`reflag`), the stall rule, the run view
// and the failure reason.
import { describe, expect, it } from 'bun:test';
import { Money } from '../../../../common/money';
import { type RetailRuleFigures, evaluateRetailRule } from '../../../catalog';
import { type ListingPublishRun, PUBLISH_BLOCK_REASONS } from '../../db/schema';
import { NAMING_FLAGS } from './naming';
import {
  MAX_RESULT_DETAIL_LENGTH,
  PREPARE_STALLED_ERROR,
  PUBLISH_FLAGS,
  PUBLISH_RESULT_REASONS,
  PUBLISH_STALE_MS,
  type PriceDecision,
  type PriceNow,
  type PriceRow,
  type PublishFacts,
  type PublishRunCounts,
  STALLED_ERROR,
  SWITCH_STALLED_ERROR,
  TYPED_SINCE_DETAIL,
  decidePrice,
  evaluateItem,
  failureReason,
  isStalled,
  isSwitchStalled,
  itemState,
  normalisePriceMode,
  reflag,
  resultDetail,
  runView,
} from './publish-item';

const m = (value: string) => Money.of(value);
const wire = (value: Money | null) => value?.toWire() ?? null;

/** IMEI +30 %, ends in .99 from $5, the default limit of 25 %. */
const RULE: RetailRuleFigures = { percent: '30.0000', fixed: m('0'), rounding: 'ends_99', roundFrom: m('5') };
const RULE_REF = { id: 7, autoFollowPercent: 25 };

/** The service now: cost and floor, the stored price, and the rule (or none). */
function now(options: {
  cost: string;
  floor: string;
  stored?: string | null;
  following?: boolean;
  rule?: { id: number; autoFollowPercent: number } | null;
}): PriceNow {
  const rule = options.rule === undefined ? RULE_REF : options.rule;
  const quote = { cost: m(options.cost), floor: m(options.floor) };
  return {
    cost: quote.cost,
    floor: quote.floor,
    stored: { price: options.stored == null ? null : m(options.stored), following: options.following ?? false },
    rule,
    rulePrice: rule === null ? null : evaluateRetailRule(RULE, quote),
  };
}

/** A row prepared at cost 10.0000 (floor 11.66: the rule price 13.99). */
function row(overrides: Partial<PriceRow> = {}): PriceRow {
  return {
    mode: 'rule',
    override: null,
    replacesPrice: null,
    cost: m('10'),
    rulePrice: m('13.99'),
    existingPrice: null,
    ...overrides,
  };
}

describe('decidePrice: manual (staff typed P in the row)', () => {
  it('writes P as typed whatever is stored, at or above the floor of now', () => {
    for (const stored of [null, '20.0000']) {
      for (const following of [false, true]) {
        const decision = decidePrice(
          row({ mode: 'manual', override: m('15') }),
          now({ cost: '10', floor: '11.66', stored, following }),
        );
        expect(decision).toMatchObject({ kind: 'write', origin: 'manual' });
        expect(wire((decision as { price: Money }).price)).toBe('15.0000');
      }
    }
    // Exactly the floor is written.
    const atFloor = decidePrice(row({ mode: 'manual', override: m('11.66') }), now({ cost: '10', floor: '11.66' }));
    expect(atFloor.kind).toBe('write');
  });

  it('refuses below_floor when the floor rose over P since the preview, and never raises P', () => {
    const decision = decidePrice(row({ mode: 'manual', override: m('12') }), now({ cost: '11', floor: '12.83' }));
    expect(decision).toMatchObject({
      kind: 'refuse',
      reason: 'below_floor',
      detail: 'Below the storefront floor of $12.83.',
    });
    expect(wire((decision as { floor: Money }).floor)).toBe('12.8300');
    // One cent under the floor is refused too.
    expect(decidePrice(row({ mode: 'manual', override: m('11.65') }), now({ cost: '10', floor: '11.66' })).kind).toBe(
      'refuse',
    );
  });

  it('throws for a manual row without a price above zero (the row CHECK forbids it)', () => {
    expect(() => decidePrice(row({ mode: 'manual', override: null }), now({ cost: '10', floor: '11.66' }))).toThrow(
      RangeError,
    );
  });
});

describe('decidePrice: keep', () => {
  it('writes nothing when the service has a price, typed or following, even under a risen floor', () => {
    for (const following of [false, true]) {
      const decision = decidePrice(
        row({ mode: 'keep', existingPrice: m('20') }),
        now({ cost: '10', floor: '25', stored: '20', following }),
      );
      expect(decision).toMatchObject({ kind: 'keep', why: 'kept', detail: null });
      expect(wire((decision as { price: Money }).price)).toBe('20.0000');
    }
  });

  it('says when the kept price is not the one the preview showed', () => {
    const decision = decidePrice(
      row({ mode: 'keep', existingPrice: m('20') }),
      now({ cost: '10', floor: '11.66', stored: '21' }),
    );
    expect(decision).toMatchObject({ kind: 'keep', detail: 'The price is $21.00, not the $20.00 of the preview.' });
  });

  it('prices by the rule when the price is gone, with the publish limit', () => {
    const gone = decidePrice(row({ mode: 'keep', existingPrice: m('20') }), now({ cost: '10', floor: '11.66' }));
    expect(gone).toMatchObject({ kind: 'write', origin: 'rule', ruleId: 7, atFloor: false });
    expect(wire((gone as { price: Money }).price)).toBe('13.9900');
    expect((gone as { detail: string }).detail).toBe('The price is $13.99, not the $20.00 of the preview.');
    const jumped = decidePrice(row({ mode: 'keep', existingPrice: m('20') }), now({ cost: '100', floor: '116.60' }));
    expect(jumped).toMatchObject({ kind: 'refuse', reason: 'cost_moved' });
  });
});

describe('decidePrice: rule', () => {
  it('prices by the rule of now when the service has no price: the cost unchanged gives the preview figure', () => {
    const decision = decidePrice(row(), now({ cost: '10', floor: '11.66' }));
    expect(decision).toMatchObject({ kind: 'write', origin: 'rule', ruleId: 7, atFloor: false, detail: null });
    expect(wire((decision as { price: Money }).price)).toBe('13.9900');
    expect(wire((decision as { cost: Money }).cost)).toBe('10.0000');
  });

  it('moved inside the limit: the rule price of the new cost and floor, never the preview figure, said in the detail', () => {
    // +10 %: 11 x 1.30 = 14.30, then 14.99.
    const up = decidePrice(row(), now({ cost: '11', floor: '12.83' }));
    expect(wire((up as { price: Money }).price)).toBe('14.9900');
    expect(wire((up as { cost: Money }).cost)).toBe('11.0000');
    expect((up as { detail: string }).detail).toBe('The price is $14.99, not the $13.99 of the preview.');
    // Exactly the limit (+25 %) is still followed.
    expect(decidePrice(row(), now({ cost: '12.5', floor: '14.58' })).kind).toBe('write');
    // A floor that rose over the rule's raw figure lifts it (price_at_floor) and stays a whole cent at or above the floor.
    const lifted = decidePrice(row(), now({ cost: '10', floor: '13.50' }));
    expect(lifted).toMatchObject({ kind: 'write', atFloor: true });
    expect(wire((lifted as { price: Money }).price)).toBe('13.9900');
  });

  it('refuses cost_moved with both costs for a cost 10 times higher, one unit over the limit, or fallen by more than it', () => {
    const ten = decidePrice(row(), now({ cost: '100', floor: '116.60' }));
    expect(ten).toEqual({
      kind: 'refuse',
      reason: 'cost_moved',
      from: m('10'),
      to: m('100'),
      detail: 'The cost moved from $10.00 to $100.00 since the preview. Check the preview again.',
    });
    expect(decidePrice(row(), now({ cost: '12.5001', floor: '14.58' }))).toMatchObject({ reason: 'cost_moved' });
    expect(decidePrice(row(), now({ cost: '5', floor: '5.83' }))).toMatchObject({ reason: 'cost_moved' });
  });

  it('a limit of 0 refuses any move and accepts none at all', () => {
    const strict = { id: 7, autoFollowPercent: 0 };
    expect(decidePrice(row(), now({ cost: '10.0001', floor: '11.66', rule: strict }))).toMatchObject({
      reason: 'cost_moved',
    });
    expect(decidePrice(row(), now({ cost: '10', floor: '11.66', rule: strict })).kind).toBe('write');
  });

  it('refuses price_missing without a rule (no_rule) and at a cost of 0 (no_cost)', () => {
    expect(decidePrice(row(), now({ cost: '10', floor: '11.66', rule: null }))).toEqual({
      kind: 'refuse',
      reason: 'price_missing',
      missing: 'no_rule',
      detail: null,
    });
    expect(decidePrice(row({ cost: m('0') }), now({ cost: '0', floor: '0.02' }))).toEqual({
      kind: 'refuse',
      reason: 'price_missing',
      missing: 'no_cost',
      detail: null,
    });
  });

  it('a following price now: no write (it is the rule price, or a proposal waits), even with replacesPrice', () => {
    for (const replacesPrice of [null, m('20')]) {
      const decision = decidePrice(
        row({ replacesPrice }),
        now({ cost: '10', floor: '11.66', stored: '20', following: true }),
      );
      expect(decision).toMatchObject({ kind: 'keep', why: 'following' });
      expect(wire((decision as { price: Money }).price)).toBe('20.0000');
    }
  });

  it('replacesPrice equal to the stored typed price: the rule price', () => {
    const decision = decidePrice(row({ replacesPrice: m('20') }), now({ cost: '10', floor: '11.66', stored: '20' }));
    expect(decision).toMatchObject({ kind: 'write', origin: 'rule', ruleId: 7 });
    expect(wire((decision as { price: Money }).price)).toBe('13.9900');
    // ... with the publish limit still in force.
    expect(
      decidePrice(row({ replacesPrice: m('20') }), now({ cost: '100', floor: '116.60', stored: '20' })),
    ).toMatchObject({ reason: 'cost_moved' });
  });

  it('a typed price and no replacesPrice, or another one: no write, and the detail says a typed price was kept', () => {
    for (const replacesPrice of [null, m('20')]) {
      const decision = decidePrice(row({ replacesPrice }), now({ cost: '10', floor: '11.66', stored: '21' }));
      expect(decision).toEqual({ kind: 'keep', price: m('21'), why: 'typed_since', detail: TYPED_SINCE_DETAIL });
    }
    // Under a risen floor too: the typed price is kept (the sale-time floor covers it).
    expect(decidePrice(row(), now({ cost: '10', floor: '30', stored: '21' }))).toMatchObject({ why: 'typed_since' });
  });

  it('a following price stays when the floor moved since the preview, over the price too: no write', () => {
    expect(decidePrice(row(), now({ cost: '10', floor: '30', stored: '13.99', following: true }))).toEqual({
      kind: 'keep',
      price: m('13.99'),
      why: 'following',
      detail: null,
    });
    expect(decidePrice(row(), now({ cost: '10', floor: '5', stored: '14.50', following: true }))).toEqual({
      kind: 'keep',
      price: m('14.50'),
      why: 'following',
      detail: 'The price is $14.50, not the $13.99 of the preview.',
    });
  });
});

/**
 * The three rows of the price table that are priced "by the rule" (plan 31 section 6.2): each one's choice, the stored price it
 * meets, and the figure its preview showed (the one a different price is compared with in the detail).
 */
const BY_THE_RULE: ReadonlyArray<{
  readonly name: string;
  readonly choice: Partial<PriceRow>;
  readonly stored: string | null;
  readonly shown: string;
}> = [
  { name: 'rule with no price', choice: {}, stored: null, shown: '$13.99' },
  { name: 'keep with the price gone', choice: { mode: 'keep', existingPrice: m('20') }, stored: null, shown: '$20.00' },
  {
    name: 'rule with replacesPrice equal to the stored typed price',
    choice: { replacesPrice: m('20') },
    stored: '20',
    shown: '$13.99',
  },
];

for (const { name, choice, stored, shown } of BY_THE_RULE) {
  describe(`decidePrice by the rule: ${name}`, () => {
    const strict = { id: 7, autoFollowPercent: 0 };
    const decide = (
      service: { cost: string; floor: string; rule?: { id: number; autoFollowPercent: number } | null },
      overrides: Partial<PriceRow> = {},
    ) => decidePrice(row({ ...choice, ...overrides }), now({ ...service, stored }));
    const differs = (price: string) => `The price is ${price}, not the ${shown} of the preview.`;
    const costMovedTo = (cost: string, to: string, from = '$10.00'): PriceDecision => ({
      kind: 'refuse',
      reason: 'cost_moved',
      from: m(from.slice(1)),
      to: m(cost),
      detail: `The cost moved from ${from} to ${to} since the preview. Check the preview again.`,
    });
    const missing = (half: 'no_rule' | 'no_cost'): PriceDecision => ({
      kind: 'refuse',
      reason: 'price_missing',
      missing: half,
      detail: null,
    });

    it('the cost unchanged: the rule price, with the cost of now', () => {
      expect(decide({ cost: '10', floor: '11.66' })).toEqual({
        kind: 'write',
        origin: 'rule',
        price: m('13.99'),
        ruleId: 7,
        cost: m('10'),
        atFloor: false,
        detail: shown === '$13.99' ? null : differs('$13.99'),
      });
    });

    it('moved inside the limit, either way, or by exactly the limit: the rule price of the new cost, said in the detail', () => {
      // +10 %: 14.30 gives 14.99; -10 %: 11.70 gives 11.99; +25 %: 16.25 gives 16.99; -25 %: 9.75 gives 9.99.
      for (const [cost, floor, price] of [
        ['11', '12.83', '14.99'],
        ['9', '10.49', '11.99'],
        ['12.5', '14.58', '16.99'],
        ['7.5', '8.75', '9.99'],
      ] as const) {
        expect(decide({ cost, floor }), cost).toEqual({
          kind: 'write',
          origin: 'rule',
          price: m(price),
          ruleId: 7,
          cost: m(cost),
          atFloor: false,
          detail: differs(`$${price}`),
        });
      }
    });

    it('one unit over the limit, either way: cost_moved with both costs', () => {
      expect(decide({ cost: '12.5001', floor: '14.58' })).toEqual(costMovedTo('12.5001', '$12.5001'));
      expect(decide({ cost: '7.4999', floor: '8.75' })).toEqual(costMovedTo('7.4999', '$7.4999'));
    });

    it('moved 10 times, or fallen by more than the limit: cost_moved, nothing to write', () => {
      expect(decide({ cost: '100', floor: '116.60' })).toEqual(costMovedTo('100', '$100.00'));
      expect(decide({ cost: '5', floor: '5.83' })).toEqual(costMovedTo('5', '$5.00'));
    });

    it('a limit of 0 refuses any move, either way, and prices an unchanged cost', () => {
      expect(decide({ cost: '10.0001', floor: '11.66', rule: strict })).toEqual(costMovedTo('10.0001', '$10.0001'));
      expect(decide({ cost: '9.9999', floor: '11.66', rule: strict })).toEqual(costMovedTo('9.9999', '$9.9999'));
      expect(decide({ cost: '10', floor: '11.66', rule: strict })).toMatchObject({ kind: 'write', origin: 'rule' });
    });

    it('no active rule: price_missing (no_rule), whatever the cost did', () => {
      for (const cost of ['10', '100', '5', '0']) {
        expect(decide({ cost, floor: '11.66', rule: null }), cost).toEqual(missing('no_rule'));
      }
    });

    it('a cost of 0 now: price_missing (no_cost), not cost_moved, though the preview had a cost', () => {
      expect(decide({ cost: '0', floor: '0.02' })).toEqual(missing('no_cost'));
      expect(decide({ cost: '0', floor: '11.66', rule: strict })).toEqual(missing('no_cost'));
      expect(decide({ cost: '0', floor: '0.02' }, { cost: m('0') })).toEqual(missing('no_cost'));
    });

    it('a cost that appeared since a preview at 0 is a move over any limit', () => {
      expect(decide({ cost: '10', floor: '11.66' }, { cost: m('0') })).toEqual(costMovedTo('10', '$10.00', '$0.00'));
    });

    it('the floor moved since the preview: the rule price of the floor of now, never under it', () => {
      // Over the raw 13.00 the floor is the base (atFloor): 13.50 rounds to 13.99, 15 to 15.99. Under it nothing changes.
      for (const [floor, price, atFloor] of [
        ['13.50', '13.99', true],
        ['15', '15.99', true],
        ['5', '13.99', false],
      ] as const) {
        const decision = decide({ cost: '10', floor });
        expect(decision, floor).toEqual({
          kind: 'write',
          origin: 'rule',
          price: m(price),
          ruleId: 7,
          cost: m('10'),
          atFloor,
          detail: `$${price}` === shown ? null : differs(`$${price}`),
        });
        expect((decision as { price: Money }).price.cmp(m(floor))).toBeGreaterThanOrEqual(0);
      }
    });
  });
}

describe('normalisePriceMode', () => {
  const none = { price: null, following: false };
  const typed = { price: m('20'), following: false };
  const following = { price: m('20'), following: true };

  it('gives the default at prepare: keep with a retail price, else rule', () => {
    expect(normalisePriceMode(null, none)).toEqual({ mode: 'rule', override: null, replacesPrice: null });
    expect(normalisePriceMode(null, typed)).toEqual({ mode: 'keep', override: null, replacesPrice: null });
    expect(normalisePriceMode(null, following)).toEqual({ mode: 'keep', override: null, replacesPrice: null });
  });

  it('turns a rule row without replacesPrice into keep when a price appeared', () => {
    const rule = { mode: 'rule' as const, override: null, replacesPrice: null };
    expect(normalisePriceMode(rule, typed)).toEqual({ mode: 'keep', override: null, replacesPrice: null });
    expect(normalisePriceMode(rule, none)).toEqual(rule);
  });

  it('drops replacesPrice when the stored price is not it (another price, a following one, none)', () => {
    const chosen = { mode: 'rule' as const, override: null, replacesPrice: m('20') };
    expect(normalisePriceMode(chosen, typed)).toEqual(chosen);
    expect(normalisePriceMode(chosen, { price: m('21'), following: false })).toEqual({
      mode: 'keep',
      override: null,
      replacesPrice: null,
    });
    expect(normalisePriceMode(chosen, following)).toEqual({ mode: 'keep', override: null, replacesPrice: null });
    expect(normalisePriceMode(chosen, none)).toEqual({ mode: 'rule', override: null, replacesPrice: null });
  });

  it('turns keep into rule when the price is gone, and keeps manual', () => {
    expect(normalisePriceMode({ mode: 'keep', override: null, replacesPrice: null }, none)).toEqual({
      mode: 'rule',
      override: null,
      replacesPrice: null,
    });
    const manual = { mode: 'manual' as const, override: m('15'), replacesPrice: null };
    for (const stored of [none, typed, following]) expect(normalisePriceMode(manual, stored)).toEqual(manual);
  });

  it('applies the price keys: a typed price, the rule over a typed price only, keep, reset; each clears the others', () => {
    const manual = { mode: 'manual' as const, override: m('15'), replacesPrice: null };
    expect(normalisePriceMode(null, typed, { kind: 'typed', price: m('16') })).toEqual({
      mode: 'manual',
      override: m('16'),
      replacesPrice: null,
    });
    expect(normalisePriceMode(manual, typed, { kind: 'rule' })).toEqual({
      mode: 'rule',
      override: null,
      replacesPrice: m('20'),
    });
    // No typed price to replace: the rule, without replacesPrice (and keep when the price follows already).
    expect(normalisePriceMode(manual, none, { kind: 'rule' })).toEqual({
      mode: 'rule',
      override: null,
      replacesPrice: null,
    });
    expect(normalisePriceMode(manual, following, { kind: 'rule' })).toEqual({
      mode: 'keep',
      override: null,
      replacesPrice: null,
    });
    expect(normalisePriceMode(manual, typed, { kind: 'keep' })).toEqual({
      mode: 'keep',
      override: null,
      replacesPrice: null,
    });
    expect(normalisePriceMode(manual, none, { kind: 'reset' })).toEqual({
      mode: 'rule',
      override: null,
      replacesPrice: null,
    });
    expect(normalisePriceMode(manual, typed, { kind: 'reset' })).toEqual({
      mode: 'keep',
      override: null,
      replacesPrice: null,
    });
    expect(() => normalisePriceMode(null, none, { kind: 'typed', price: m('0') })).toThrow(RangeError);
  });
});

/** Facts of a publishable service: active, open category, IMEI, automatic with a usable supplier, not listed. */
function facts(overrides: Partial<PublishFacts> = {}): PublishFacts {
  return {
    listed: false,
    serviceStatus: 'active',
    serviceType: 'imei',
    fulfillment: 'auto',
    categoryActive: true,
    categoryName: 'Carrier unlock',
    categoryAllowedGroupIds: [],
    retailGroupId: 4,
    supply: 'ok',
    ...overrides,
  };
}

const ruleWrite = decidePrice(row(), now({ cost: '10', floor: '11.66' }));

describe('evaluateItem', () => {
  it('judges every blocking reason in its order, the first that applies winning', () => {
    const cases: Array<[Partial<PublishFacts>, string, Parameters<typeof evaluateItem>[0]['price'], boolean, string]> =
      [
        [{ listed: true, serviceStatus: 'disabled' }, '', undefined, true, 'already_listed'],
        [{ serviceStatus: 'disabled', categoryActive: false }, '', undefined, true, 'service_disabled'],
        [{ categoryActive: false, categoryAllowedGroupIds: [1] }, '', undefined, true, 'category_inactive'],
        [{ categoryAllowedGroupIds: [1], serviceType: 'file' }, '', undefined, true, 'b2b_only'],
        [{ serviceType: 'file', supply: 'no_link' }, '', undefined, true, 'not_orderable'],
        [{ supply: 'supplier_unavailable' }, '', undefined, true, 'supplier_unavailable'],
        [{ supply: 'no_link' }, '', undefined, true, 'supplier_unavailable'],
        [{}, '   ', undefined, true, 'title_missing'],
        [{}, 'x'.repeat(201), undefined, true, 'title_too_long'],
        [
          {},
          'Title',
          { kind: 'refuse', reason: 'price_missing', missing: 'no_rule', detail: null },
          true,
          'price_missing',
        ],
        [
          {},
          'Title',
          decidePrice(row({ mode: 'manual', override: m('1') }), now({ cost: '10', floor: '11.66' })),
          true,
          'below_floor',
        ],
        [{}, 'Title', ruleWrite, true, 'slug_taken'],
      ];
    for (const [overrides, title, price, staffSlugTaken, reason] of cases) {
      const result = evaluateItem({
        facts: facts(overrides),
        title,
        flags: [],
        ...(price === undefined ? {} : { price }),
        staffSlugTaken,
      });
      expect(result.blockedReason, reason).toBe(reason as never);
      expect(result.state).toBe('blocked');
      expect(result.included).toBe(false);
    }
  });

  it('lets a manual service without a supplier through, a 200 character title, and a B2B category that names the retail group', () => {
    expect(
      evaluateItem({ facts: facts({ fulfillment: 'manual', supply: 'no_link' }), title: 'T', flags: [] }).blockedReason,
    ).toBe(null);
    expect(evaluateItem({ facts: facts(), title: 'x'.repeat(200), flags: [] }).blockedReason).toBe(null);
    expect(
      evaluateItem({ facts: facts({ categoryAllowedGroupIds: [1, 4] }), title: 'T', flags: [] }).blockedReason,
    ).toBe(null);
    expect(
      evaluateItem({ facts: facts({ retailGroupId: null, categoryAllowedGroupIds: [1] }), title: 'T', flags: [] })
        .blockedReason,
    ).toBe('b2b_only');
  });

  it('puts a row with a hard flag in review and keeps a soft flag ready', () => {
    for (const flag of ['title_long', 'duplicate_name', 'title_taken', 'quantity_text', 'multi_country']) {
      expect(evaluateItem({ facts: facts(), title: 'T', flags: [flag], price: ruleWrite }).state, flag).toBe('review');
    }
    for (const flag of [
      'title_81_100',
      'title_lacks_brand',
      'brackets_repaired',
      'marketing_kept',
      'slug_suffixed',
      'no_brand',
      'country_from_group',
      'carrier_no_country',
    ]) {
      expect(evaluateItem({ facts: facts(), title: 'T', flags: [flag], price: ruleWrite }).state, flag).toBe('ready');
    }
  });

  it('sets the price flags from the decision and drops stale ones, and leaves them alone without a decision', () => {
    const lifted = decidePrice(row(), now({ cost: '10', floor: '13.50' }));
    expect(evaluateItem({ facts: facts(), title: 'T', flags: ['no_brand', 'no_rule'], price: lifted }).flags).toEqual([
      'price_at_floor',
      'no_brand',
    ]);
    const kept = decidePrice(row({ mode: 'keep' }), now({ cost: '10', floor: '11.66', stored: '20' }));
    expect(evaluateItem({ facts: facts(), title: 'T', flags: ['price_at_floor'], price: kept })).toMatchObject({
      state: 'ready',
      flags: ['price_kept'],
    });
    const noCost = decidePrice(row({ cost: m('0') }), now({ cost: '0', floor: '0.02' }));
    expect(evaluateItem({ facts: facts(), title: 'T', flags: [], price: noCost })).toMatchObject({
      blockedReason: 'price_missing',
      flags: ['no_cost'],
    });
    expect(evaluateItem({ facts: facts(), title: 'T', flags: ['price_kept', 'bogus'] }).flags).toEqual(['price_kept']);
  });

  it('applies the tick rule: blocked loses it, leaving blocked gets the default of the new state, otherwise it stays', () => {
    const missing = { kind: 'refuse', reason: 'price_missing', missing: 'no_rule', detail: null } as const;
    const ready = { facts: facts(), title: 'T', flags: [] as string[], price: ruleWrite };
    const review = { ...ready, flags: ['title_long'] };
    // A new row gets the default of its state.
    expect(evaluateItem(ready).included).toBe(true);
    expect(evaluateItem(review).included).toBe(false);
    // Becoming blocked clears a tick.
    expect(evaluateItem({ ...ready, price: missing, previous: { state: 'ready', included: true } }).included).toBe(
      false,
    );
    // Leaving blocked: the default of the new state.
    expect(evaluateItem({ ...ready, previous: { state: 'blocked', included: false } }).included).toBe(true);
    expect(evaluateItem({ ...review, previous: { state: 'blocked', included: false } }).included).toBe(false);
    // Otherwise the tick stays as staff left it.
    expect(evaluateItem({ ...ready, previous: { state: 'ready', included: false } }).included).toBe(false);
    expect(evaluateItem({ ...review, previous: { state: 'ready', included: true } }).included).toBe(true);
    expect(evaluateItem({ ...ready, previous: { state: 'review', included: false } }).included).toBe(false);
  });

  it('refuses a cost_moved decision: a draft is evaluated with its own cost', () => {
    const moved = decidePrice(row(), now({ cost: '100', floor: '116.60' }));
    expect(() => evaluateItem({ facts: facts(), title: 'T', flags: [], price: moved })).toThrow(RangeError);
  });

  it('itemState follows the reason and the hard flags', () => {
    expect(itemState('slug_taken', [])).toBe('blocked');
    expect(itemState(null, ['multi_country'])).toBe('review');
    expect(itemState(null, ['no_brand', 'price_kept'])).toBe('ready');
  });
});

describe('reflag', () => {
  const detected = {
    title: 'Chimera Tool Activation 12 Months',
    slug: 'chimera-tool-activation-12-months',
    brand: 'Chimera',
    brandKind: 'tool' as const,
    carrier: '',
    country: '',
  };
  const base = { flags: [] as string[], ...detected, detected };

  it('recomputes the title flags from the edited title and brand', () => {
    expect(reflag({ ...base, title: 'x'.repeat(101) })).toEqual(['title_long', 'title_lacks_brand']);
    expect(reflag({ ...base, title: 'Chimera '.padEnd(90, 'x') })).toEqual(['title_81_100']);
    expect(reflag({ ...base, flags: ['title_long'], title: 'Chimera short' })).toEqual([]);
    // A tool brand the title does not hold, then a brand staff typed (no kind: never lacking), then none.
    expect(reflag({ ...base, title: 'Activation 12 Months' })).toEqual(['title_lacks_brand']);
    expect(reflag({ ...base, title: 'Activation 12 Months', brand: 'Octoplus' })).toEqual([]);
    expect(reflag({ ...base, brand: '' })).toEqual(['no_brand']);
    expect(reflag({ ...base, flags: ['no_brand'], brand: 'Apple' })).toEqual([]);
  });

  it('sets carrier_no_country from the carrier and the country, and keeps multi_country only while the country is empty', () => {
    expect(reflag({ ...base, carrier: 'AT&T' })).toEqual(['carrier_no_country']);
    expect(reflag({ ...base, flags: ['carrier_no_country'], carrier: 'AT&T', country: 'US' })).toEqual([]);
    expect(reflag({ ...base, flags: ['multi_country'] })).toEqual(['multi_country']);
    expect(reflag({ ...base, flags: ['multi_country'], country: 'US' })).toEqual([]);
    // Never added by an edit.
    expect(reflag({ ...base, country: '' })).toEqual([]);
  });

  it('keeps a detection flag only while its field holds the detected value', () => {
    const withCountry = { ...base, country: 'US', detected: { ...detected, country: 'US' } };
    expect(reflag({ ...withCountry, flags: ['country_from_group'] })).toEqual(['country_from_group']);
    expect(reflag({ ...withCountry, flags: ['country_from_group'], country: 'GB' })).toEqual([]);
    for (const flag of ['brackets_repaired', 'marketing_kept']) {
      expect(reflag({ ...base, flags: [flag] })).toEqual([flag as never]);
      expect(reflag({ ...base, flags: [flag], title: 'Chimera Tool 12 Months' })).toEqual([]);
    }
    expect(reflag({ ...base, flags: ['slug_suffixed'] })).toEqual(['slug_suffixed']);
    expect(reflag({ ...base, flags: ['slug_suffixed'], slug: 'chimera' })).toEqual([]);
  });

  it('takes title_taken from the caller, and keeps the flags of the supplier name and of the price', () => {
    expect(reflag({ ...base, flags: ['title_taken'] })).toEqual(['title_taken']);
    expect(reflag({ ...base, flags: ['title_taken'], titleTaken: false })).toEqual([]);
    expect(reflag({ ...base, titleTaken: true })).toEqual(['title_taken']);
    expect(reflag({ ...base, flags: ['duplicate_name', 'quantity_text', 'price_kept', 'no_rule'] })).toEqual([
      'duplicate_name',
      'quantity_text',
      'price_kept',
      'no_rule',
    ]);
  });
});

describe('the closed lists', () => {
  it('PUBLISH_FLAGS holds every naming flag and the four price flags, once each', () => {
    expect(new Set(PUBLISH_FLAGS).size).toBe(PUBLISH_FLAGS.length);
    for (const flag of NAMING_FLAGS) expect(PUBLISH_FLAGS as readonly string[]).toContain(flag);
    expect(PUBLISH_FLAGS.filter((flag) => !(NAMING_FLAGS as readonly string[]).includes(flag))).toEqual([
      'price_at_floor',
      'price_kept',
      'no_rule',
      'no_cost',
    ]);
  });

  it('PUBLISH_RESULT_REASONS holds left_out, every blocking reason, service_gone, cost_moved and failed, once each', () => {
    expect(new Set(PUBLISH_RESULT_REASONS).size).toBe(PUBLISH_RESULT_REASONS.length);
    for (const reason of PUBLISH_BLOCK_REASONS) expect(PUBLISH_RESULT_REASONS as readonly string[]).toContain(reason);
    for (const reason of ['left_out', 'service_gone', 'cost_moved', 'failed']) {
      expect(PUBLISH_RESULT_REASONS as readonly string[]).toContain(reason);
    }
  });
});

const T0 = new Date('2026-11-17T09:00:00.000Z');
const COUNTS: PublishRunCounts = {
  ready: 1,
  review: 0,
  blocked: 0,
  included: 1,
  noRule: 0,
  published: 0,
  skipped: 0,
  refused: 0,
  pending: 1,
};

function runRow(overrides: Partial<ListingPublishRun> = {}): ListingPublishRun {
  return {
    id: 3,
    status: 'running',
    source: 'console',
    sourceRunId: null,
    scope: { kind: 'all' },
    replacedByRunId: null,
    listed: true,
    auto: false,
    rulesVersion: 1,
    total: 1,
    publishedCount: 0,
    skippedCount: 0,
    refusedCount: 0,
    error: null,
    requestedBy: 2,
    attempt: 1,
    prepareClaimedAt: T0,
    preparedAt: T0,
    startedAt: T0,
    finishedAt: null,
    heartbeatAt: T0,
    switchStatus: null,
    switchListed: null,
    switchedCount: 0,
    switchSkippedCount: 0,
    switchError: null,
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

describe('the stall rule and the run view', () => {
  it('reads a live run stalled after five minutes without a heartbeat, never a finished one', () => {
    const at = T0.getTime();
    for (const status of ['preparing', 'queued', 'running'] as const) {
      expect(isStalled({ status, heartbeatAt: T0 }, at + PUBLISH_STALE_MS)).toBe(false);
      expect(isStalled({ status, heartbeatAt: T0 }, at + PUBLISH_STALE_MS + 1)).toBe(true);
    }
    for (const status of ['draft', 'succeeded', 'failed', 'cancelled'] as const) {
      expect(isStalled({ status, heartbeatAt: T0 }, at + 10 * PUBLISH_STALE_MS)).toBe(false);
    }
    expect(isSwitchStalled({ switchStatus: 'running', heartbeatAt: T0 }, at + PUBLISH_STALE_MS + 1)).toBe(true);
    expect(isSwitchStalled({ switchStatus: 'done', heartbeatAt: T0 }, at + 10 * PUBLISH_STALE_MS)).toBe(false);
    expect(isSwitchStalled({ switchStatus: null, heartbeatAt: T0 }, at + 10 * PUBLISH_STALE_MS)).toBe(false);
  });

  it('shows a run as the console reads it, and a stalled one as failed with its message (a read never writes)', () => {
    const at = T0.getTime();
    const view = runView(runRow({ sourceRunId: 9, replacedByRunId: 4 }), COUNTS, 'Rami K.', at);
    expect(view).toEqual({
      id: 3,
      status: 'running',
      source: 'console',
      quickAddRunId: 9,
      scope: { kind: 'all' },
      listed: true,
      auto: false,
      total: 1,
      counts: COUNTS,
      switch: { status: null, listed: null, switched: 0, skipped: 0, error: null },
      replacedBy: 4,
      error: null,
      requestedBy: 2,
      requestedByName: 'Rami K.',
      createdAt: T0.toISOString(),
      preparedAt: T0.toISOString(),
      startedAt: T0.toISOString(),
      finishedAt: null,
    });
    const late = at + PUBLISH_STALE_MS + 1;
    expect(runView(runRow(), COUNTS, null, late)).toMatchObject({ status: 'failed', error: STALLED_ERROR });
    expect(runView(runRow({ status: 'preparing' }), COUNTS, null, late)).toMatchObject({
      status: 'failed',
      error: PREPARE_STALLED_ERROR,
    });
    expect(
      runView(runRow({ status: 'succeeded', switchStatus: 'running', switchListed: false }), COUNTS, null, late),
    ).toMatchObject({
      status: 'succeeded',
      switch: { status: 'failed', listed: false, error: SWITCH_STALLED_ERROR },
    });
  });
});

describe('failureReason and resultDetail', () => {
  it('names the violated constraint, else says unexpected error', () => {
    const pg = Object.assign(new Error('duplicate key'), { code: '23505', constraint: 'service_listings_slug_uq' });
    expect(failureReason(new Error('wrapped', { cause: pg }))).toBe('service_listings_slug_uq');
    expect(failureReason(new Error('boom'))).toBe('unexpected error');
    expect(failureReason('not an error')).toBe('unexpected error');
  });

  it('joins the sentences and cuts them to 300 characters', () => {
    expect(resultDetail([null, 'One.', '', undefined, 'Two.'])).toBe('One. Two.');
    expect(resultDetail([null])).toBe(null);
    expect(resultDetail(['x'.repeat(400)])).toHaveLength(MAX_RESULT_DETAIL_LENGTH);
  });
});
