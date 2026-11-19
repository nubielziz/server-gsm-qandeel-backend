// Unit tests of the pure side of preparing a draft (feature 31, plan 31 sections 3.2, 3.5, 5.2 and 6.1): which naming rules a service
// gets (correction 1 after the merge), the tick a copied row keeps, the price of a draft row, and the row a draft stores for a new row,
// for an edited copy and for a row blocked by the facts of now.
import { describe, expect, it } from 'bun:test';
import { Money } from '../../../../common/money';
import { evaluateRetailRule } from '../../../catalog';
import { nameAll } from './naming';
import {
  type CopiedRow,
  type DraftDetected,
  type DraftRowInput,
  buildDraftRow,
  copiedTick,
  draftPrice,
  namingTypeOf,
} from './publish-draft';
import type { PriceNow, PublishFacts } from './publish-item';

const m = (value: string) => Money.of(value);

/** The service now: cost 10.0000, floor 11.66, no retail price, an IMEI +30 % rule (13.99). */
function price(overrides: Partial<PriceNow> = {}): PriceNow {
  const quote = { cost: m('10'), floor: m('11.66') };
  return {
    ...quote,
    stored: { price: null, following: false },
    rule: { id: 7, autoFollowPercent: 25 },
    rulePrice: evaluateRetailRule({ percent: '30.0000', fixed: m('0'), rounding: 'ends_99', roundFrom: m('5') }, quote),
    ...overrides,
  };
}

const FACTS: PublishFacts = {
  listed: false,
  serviceStatus: 'active',
  serviceType: 'imei',
  fulfillment: 'auto',
  categoryActive: true,
  categoryName: 'Carrier unlock',
  categoryAllowedGroupIds: [],
  retailGroupId: 4,
  supply: 'ok',
};

/** Names one row alone, as the preparer does for a batch of one. */
function naming(name: string, fixedTitle?: string) {
  const [named] = nameAll([
    { name, type: 'imei', group: 'Carrier unlock', ...(fixedTitle === undefined ? {} : { fixedTitle }) },
  ]);
  return named!;
}

function input(overrides: Partial<DraftRowInput> = {}): DraftRowInput {
  return {
    serviceId: 5,
    named: naming('AT&T USA Premier Unlock'),
    assigned: { slug: 'att-usa-premier-unlock', suffixed: false },
    facts: FACTS,
    price: price(),
    listingSlugs: new Set(),
    ...overrides,
  };
}

const DETECTED: DraftDetected = {
  title: 'AT&T USA Premier Unlock',
  slug: 'att-usa-premier-unlock',
  brand: '',
  brandKind: null,
  carrier: 'AT&T',
  country: 'US',
};

function copy(overrides: Partial<CopiedRow> = {}): CopiedRow {
  return {
    title: 'AT&T USA Premier Unlock',
    slug: 'att-usa-premier-unlock',
    slugSource: 'auto',
    brand: '',
    carrier: 'AT&T',
    country: 'US',
    detected: DETECTED,
    priceMode: 'rule',
    priceOverride: null,
    edited: false,
    state: 'ready',
    included: true,
    ...overrides,
  };
}

describe('namingTypeOf: which naming rules a service gets', () => {
  it('names an imei service, and a server service with a main-box field, by the IMEI rules', () => {
    expect(namingTypeOf('imei', false)).toBe('imei');
    expect(namingTypeOf('server', true)).toBe('imei');
    expect(namingTypeOf('remote', true)).toBe('imei');
  });

  it('names the others by their own type, and an unknown type as a server', () => {
    expect(namingTypeOf('server', false)).toBe('server');
    expect(namingTypeOf('remote', false)).toBe('remote');
    expect(namingTypeOf('file', false)).toBe('file');
    expect(namingTypeOf('other', false)).toBe('server');
  });

  it('keeps the carrier and the device brand of a server service that has a main box (the plan correction)', () => {
    const name = 'Unlock AT&T USA Apple iPhone Clean';
    const asServer = nameAll([{ name, type: namingTypeOf('server', false), group: 'Carrier unlock' }])[0]!;
    const asBoxed = nameAll([{ name, type: namingTypeOf('server', true), group: 'Carrier unlock' }])[0]!;
    expect(asServer).toMatchObject({ carrier: '', brand: 'Carrier unlock', brandKind: 'tool' });
    expect(asBoxed).toMatchObject({ carrier: 'AT&T', brand: 'Apple', brandKind: 'device' });
  });
});

describe('copiedTick: the tick a copied row hands on', () => {
  it('has none for a row at the default of its state (ticked ready, unticked review and blocked)', () => {
    expect(copiedTick({ state: 'ready', included: true })).toBeUndefined();
    expect(copiedTick({ state: 'review', included: false })).toBeUndefined();
    expect(copiedTick({ state: 'blocked', included: false })).toBeUndefined();
  });

  it('keeps the tick staff changed', () => {
    expect(copiedTick({ state: 'ready', included: false })).toEqual({ state: 'ready', included: false });
    expect(copiedTick({ state: 'review', included: true })).toEqual({ state: 'review', included: true });
  });
});

describe('draftPrice: the choice, the decision and the rule price of a draft row', () => {
  it('prices a service with no retail price by the rule and shows the rule price', () => {
    const out = draftPrice(null, price());
    expect(out.choice).toEqual({ mode: 'rule', override: null, replacesPrice: null });
    expect(out.decision).toMatchObject({ kind: 'write', origin: 'rule', ruleId: 7 });
    expect(out.rulePrice?.toWire()).toBe('13.9900');
  });

  it('keeps a price the service has, never promising to replace it', () => {
    const out = draftPrice(
      { mode: 'rule', override: null, replacesPrice: m('20') },
      price({ stored: { price: m('20'), following: false } }),
    );
    expect(out.choice).toEqual({ mode: 'rule', override: null, replacesPrice: m('20') });
    // A choice to replace is only kept while the price is still that typed price (the stored choice here carries it).
    expect(draftPrice(null, price({ stored: { price: m('20'), following: false } })).choice.mode).toBe('keep');
  });

  it('judges with the cost of now as the row cost, so a draft is never cost_moved', () => {
    const out = draftPrice(null, price({ cost: m('100'), floor: m('120') }));
    expect(out.decision.kind).not.toBe('refuse');
  });

  it('reports the missing half of a price: no rule, then no cost', () => {
    expect(draftPrice(null, price({ rule: null, rulePrice: null })).decision).toMatchObject({
      kind: 'refuse',
      reason: 'price_missing',
      missing: 'no_rule',
    });
    const free = price({ cost: m('0'), floor: m('0.03') });
    expect(draftPrice(null, { ...free, rulePrice: { kind: 'no_cost' } }).decision).toMatchObject({
      kind: 'refuse',
      reason: 'price_missing',
      missing: 'no_cost',
    });
  });
});

describe('buildDraftRow: a new row', () => {
  it('stores what the naming found, as detected and as the row, priced by the rule, ready and ticked', () => {
    const row = buildDraftRow(input());
    expect(row).toMatchObject({
      serviceId: 5,
      title: 'AT&T USA Premier Unlock',
      slug: 'att-usa-premier-unlock',
      slugSource: 'auto',
      carrier: 'AT&T',
      country: 'US',
      detected: DETECTED,
      priceMode: 'rule',
      priceOverride: null,
      replacesPrice: null,
      existingPrice: null,
      cost: '10.0000',
      floorPrice: '11.6600',
      ruleId: 7,
      rulePrice: '13.9900',
      state: 'ready',
      blockedReason: null,
      flags: ['no_brand'],
      included: true,
      edited: false,
    });
  });

  it('adds slug_suffixed to a slug that got a suffix', () => {
    const row = buildDraftRow(input({ assigned: { slug: 'att-usa-premier-unlock-2', suffixed: true } }));
    expect(row.slug).toBe('att-usa-premier-unlock-2');
    expect(row.detected.slug).toBe('att-usa-premier-unlock-2');
    expect(row.flags).toEqual(['slug_suffixed', 'no_brand']);
    expect(row.state).toBe('ready');
  });

  it('waits in review, unticked, when a hard flag is set, and keeps the price it has', () => {
    const row = buildDraftRow(
      input({
        named: { ...naming('AT&T USA Premier Unlock'), flags: ['duplicate_name'] },
        price: price({ stored: { price: m('20'), following: false } }),
      }),
    );
    expect(row).toMatchObject({ state: 'review', included: false, priceMode: 'keep', existingPrice: '20.0000' });
    expect(row.flags).toEqual(['duplicate_name', 'price_kept']);
  });

  it('is blocked and unticked by the facts of now', () => {
    const row = buildDraftRow(input({ facts: { ...FACTS, categoryActive: false } }));
    expect(row).toMatchObject({ state: 'blocked', blockedReason: 'category_inactive', included: false });
  });

  it('is blocked price_missing with the detail flag when no rule covers it', () => {
    const row = buildDraftRow(input({ price: price({ rule: null, rulePrice: null }) }));
    expect(row).toMatchObject({ state: 'blocked', blockedReason: 'price_missing', ruleId: null, rulePrice: null });
    expect(row.flags).toContain('no_rule');
  });

  it('has no title for a name with no Latin word: blocked title_missing', () => {
    const named = naming('\u0627\u0644\u062e\u062f\u0645\u0629');
    const row = buildDraftRow(input({ named, assigned: { slug: '', suffixed: false } }));
    expect(row).toMatchObject({ title: '', slug: '', state: 'blocked', blockedReason: 'title_missing' });
  });
});

describe('buildDraftRow: a copied row', () => {
  it('keeps nothing of an unedited copy but its price choice, and re-detects the rest', () => {
    const row = buildDraftRow(
      input({
        copy: copy({ title: 'Old title', brand: 'Old brand', priceMode: 'manual', priceOverride: m('25') }),
      }),
    );
    expect(row).toMatchObject({
      title: 'AT&T USA Premier Unlock',
      brand: '',
      priceMode: 'manual',
      priceOverride: '25.0000',
      replacesPrice: null,
      edited: false,
      state: 'ready',
      included: true,
    });
  });

  it('keeps the title, the facts and the detection of an edited copy, and recomputes the flags that derive from them', () => {
    const named = naming('AT&T USA Premier Unlock', 'My own title');
    expect(named.title).toBe('My own title');
    const row = buildDraftRow(
      input({
        named,
        assigned: { slug: 'my-own-title', suffixed: false },
        copy: copy({ title: 'My own title', brand: 'Samsung', carrier: 'Orange', country: 'FR', edited: true }),
      }),
    );
    expect(row).toMatchObject({
      title: 'My own title',
      slug: 'my-own-title',
      brand: 'Samsung',
      carrier: 'Orange',
      country: 'FR',
      detected: DETECTED,
      edited: true,
      state: 'ready',
    });
    // `no_brand` came from the name; the brand staff typed settles it, and a typed brand has no known kind, so it never lacks.
    expect(row.flags).toEqual([]);
  });

  it('keeps a typed address, and blocks the row slug_taken when a listing holds it now', () => {
    const typed = copy({ slug: 'my-address', slugSource: 'staff', edited: true });
    const free = buildDraftRow(input({ copy: typed }));
    expect(free).toMatchObject({ slug: 'my-address', slugSource: 'staff', state: 'ready' });
    const taken = buildDraftRow(input({ copy: typed, listingSlugs: new Set(['my-address']) }));
    expect(taken).toMatchObject({ slug: 'my-address', state: 'blocked', blockedReason: 'slug_taken', included: false });
  });

  it('keeps the tick staff changed, and ticks a row whose obstacle is gone', () => {
    expect(buildDraftRow(input({ copy: copy({ included: false }) }))).toMatchObject({
      state: 'ready',
      included: false,
    });
    const review = { named: { ...naming('AT&T USA Premier Unlock'), flags: ['duplicate_name' as const] } };
    expect(buildDraftRow(input({ ...review, copy: copy({ state: 'review', included: true }) }))).toMatchObject({
      state: 'review',
      included: true,
    });
    // It was blocked (never ticked) and nothing blocks it now: the default of ready, ticked.
    expect(buildDraftRow(input({ copy: copy({ state: 'blocked', included: false }) }))).toMatchObject({
      state: 'ready',
      included: true,
    });
  });

  it('blocks a typed price that is under the floor of now (below_floor) and keeps the typed price', () => {
    const row = buildDraftRow(input({ copy: copy({ priceMode: 'manual', priceOverride: m('11') }) }));
    expect(row).toMatchObject({
      state: 'blocked',
      blockedReason: 'below_floor',
      priceMode: 'manual',
      priceOverride: '11.0000',
      included: false,
    });
  });
});
