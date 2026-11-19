// Unit tests of the pure side of editing a row of a publish draft (feature 31, plan 31 section 5.2): every key of the row's `PATCH`, the
// refusals with their field and code, the flags and the tick after an edit, a reset, and a bulk change of the facts.
import { describe, expect, it } from 'bun:test';
import { Money } from '@src/common/money';
import { evaluateRetailRule } from '@src/modules/catalog';
import {
  BLOCK_SENTENCES,
  type EditWorld,
  type EditableRow,
  type RowEdit,
  editRow,
  editsPrice,
  resetDropsPriceChoice,
  withFacts,
} from '@src/modules/storefront/publish/domain/publish-edit';
import type { DraftDetected } from '@src/modules/storefront/publish/domain/publish-draft';
import { PUBLISH_BLOCK_REASONS } from '@src/modules/storefront/db/schema';
import type { PriceNow, PublishFacts } from '@src/modules/storefront/publish/domain/publish-item';

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

const DETECTED: DraftDetected = {
  title: 'AT&T USA Premier Unlock',
  slug: 'att-usa-premier-unlock',
  brand: '',
  brandKind: null,
  carrier: 'AT&T',
  country: 'US',
};

function row(overrides: Partial<EditableRow> = {}): EditableRow {
  return {
    serviceId: 5,
    detected: DETECTED,
    title: DETECTED.title,
    slug: DETECTED.slug,
    slugSource: 'auto',
    brand: '',
    carrier: 'AT&T',
    country: 'US',
    priceMode: 'rule',
    priceOverride: null,
    replacesPrice: null,
    flags: ['no_brand'],
    state: 'ready',
    included: true,
    edited: false,
    ...overrides,
  };
}

function world(overrides: Partial<EditWorld> = {}): EditWorld {
  return {
    facts: FACTS,
    price: price(),
    naming: { name: 'AT&T USA Premier Unlock', type: 'imei', group: 'Carrier unlock' },
    listingSlugs: new Set(),
    otherSlugs: new Set(),
    titleTaken: () => false,
    ...overrides,
  };
}

/** Edits and expects a stored row. */
function stored(current: EditableRow, edit: RowEdit, w: EditWorld = world()) {
  const result = editRow(current, edit, w);
  if (!result.ok) throw new Error(`refused: ${JSON.stringify(result.problems)}`);
  return result.row;
}

/** Edits and expects the refusals. */
function refused(current: EditableRow, edit: RowEdit, w: EditWorld = world()) {
  const result = editRow(current, edit, w);
  if (result.ok) throw new Error('expected a refusal');
  return result.problems;
}

describe('editsPrice', () => {
  it('is true for the two price keys only', () => {
    expect(editsPrice({ retailPrice: '13.9900' })).toBe(true);
    expect(editsPrice({ pricing: 'keep' })).toBe(true);
    expect(editsPrice({})).toBe(false);
  });
});

describe('resetDropsPriceChoice', () => {
  it('is true for a typed price and for a rule chosen over one, false for a row on the default price', () => {
    expect(resetDropsPriceChoice({ priceMode: 'manual', replacesPrice: null })).toBe(true);
    expect(resetDropsPriceChoice({ priceMode: 'rule', replacesPrice: '13.9900' })).toBe(true);
    expect(resetDropsPriceChoice({ priceMode: 'rule', replacesPrice: null })).toBe(false);
    expect(resetDropsPriceChoice({ priceMode: 'keep', replacesPrice: null })).toBe(false);
  });
});

describe('BLOCK_SENTENCES', () => {
  it('has a sentence for every blocking reason', () => {
    for (const reason of PUBLISH_BLOCK_REASONS) expect(BLOCK_SENTENCES[reason]).toMatch(/\.$/);
  });
});

describe('editRow: the title, the facts and the address', () => {
  it('sets the title, marks the row edited and makes an address that is not typed follow it', () => {
    const out = stored(row(), { title: 'AT&T USA Premier Unlock Clean' });
    expect(out).toMatchObject({
      title: 'AT&T USA Premier Unlock Clean',
      slug: 'att-usa-premier-unlock-clean',
      slugSource: 'auto',
      edited: true,
      state: 'ready',
      included: true,
    });
    expect(out.detected).toEqual(DETECTED);
  });

  it('gives a followed address the next free suffix and says so, against the listings and the other rows', () => {
    const out = stored(
      row(),
      { title: 'Samsung Unlock' },
      world({ listingSlugs: new Set(['samsung-unlock']), otherSlugs: new Set(['samsung-unlock-2']) }),
    );
    expect(out.slug).toBe('samsung-unlock-3');
    expect(out.flags).toContain('slug_suffixed');
  });

  it('keeps a typed address when the title changes, and the address a title with no letters cannot replace', () => {
    expect(stored(row({ slug: 'my-address', slugSource: 'staff' }), { title: 'Something else' }).slug).toBe(
      'my-address',
    );
    expect(stored(row(), { title: '12345' }).slug).toBe('12345');
    expect(stored(row(), { title: '!!!' }).slug).toBe(DETECTED.slug);
    expect(refused(row({ slug: '' }), { title: '!!!' })).toEqual([
      expect.objectContaining({ field: 'title', code: 'invalid' }),
    ]);
  });

  it('does not call an address a suffix when a title with no letters or digits leaves it as it was', () => {
    const out = stored(row(), { title: '!!!' });
    expect(out.slug).toBe(DETECTED.slug);
    expect(out.flags).not.toContain('slug_suffixed');
    // Nor at a later edit of the same row.
    const later = stored(row({ title: '!!!' }), { brand: 'Apple' });
    expect(later.flags).not.toContain('slug_suffixed');
  });

  it('stores a typed address as staff, and refuses a form that is not an address or one that is held', () => {
    expect(stored(row(), { slug: 'my-own-address' })).toMatchObject({
      slug: 'my-own-address',
      slugSource: 'staff',
      edited: true,
    });
    expect(refused(row(), { slug: 'Not An Address' })).toEqual([
      expect.objectContaining({ field: 'slug', code: 'invalid' }),
    ]);
    expect(refused(row(), { slug: 'taken' }, world({ listingSlugs: new Set(['taken']) }))).toEqual([
      expect.objectContaining({ field: 'slug', code: 'duplicate' }),
    ]);
    expect(refused(row(), { slug: 'taken' }, world({ otherSlugs: new Set(['taken']) }))).toEqual([
      expect.objectContaining({ field: 'slug', code: 'duplicate' }),
    ]);
  });

  it("does not hold the row's own address against itself", () => {
    expect(stored(row(), { slug: DETECTED.slug }, world({ otherSlugs: new Set(['other']) })).slugSource).toBe('staff');
  });

  it('makes the address from the title again for an empty one, and refuses a title with nothing to make it from', () => {
    const out = stored(row({ slug: 'my-address', slugSource: 'staff', title: 'New title' }), { slug: '' });
    expect(out).toMatchObject({ slug: 'new-title', slugSource: 'auto' });
    expect(refused(row({ title: '???' }), { slug: '' })).toEqual([
      expect.objectContaining({ field: 'slug', code: 'invalid' }),
    ]);
  });

  it('sets the facts and works out the flags that derive from them', () => {
    const out = stored(row({ flags: ['no_brand', 'carrier_no_country'], country: '' }), {
      brand: 'Apple',
      country: 'US',
    });
    expect(out).toMatchObject({ brand: 'Apple', country: 'US', edited: true });
    expect(out.flags).not.toContain('no_brand');
    expect(out.flags).not.toContain('carrier_no_country');
  });

  it('flags a long title (soft from 81, hard from 101) and a hard flag puts the row in review, keeping the tick', () => {
    const soft = stored(row(), { title: `Unlock ${'x'.repeat(80)}` });
    expect(soft.flags).toContain('title_81_100');
    expect(soft.state).toBe('ready');
    const hard = stored(row(), { title: `Unlock ${'x'.repeat(100)}` });
    expect(hard.flags).toContain('title_long');
    expect(hard).toMatchObject({ state: 'review', included: true });
  });

  it('asks whether a changed title is taken, and only a changed one', () => {
    let asked = 0;
    const w = world({
      titleTaken: (title) => {
        asked += 1;
        return title === 'Twin';
      },
    });
    expect(stored(row(), { title: 'Twin' }, w).flags).toContain('title_taken');
    expect(stored(row(), { title: 'Twin' }, w).state).toBe('review');
    expect(stored(row({ flags: ['title_taken'] }), { brand: 'Apple' }, w).flags).toContain('title_taken');
    expect(asked).toBe(2);
  });

  it('blocks a title that is empty after the change', () => {
    expect(stored(row({ title: '' }), { brand: 'Apple' })).toMatchObject({
      state: 'blocked',
      blockedReason: 'title_missing',
      included: false,
    });
  });
});

describe('editRow: the price keys', () => {
  it('stores a typed price as manual and clears what the others set', () => {
    const out = stored(
      row({ priceMode: 'rule', replacesPrice: '20.0000' }),
      { retailPrice: '25.0000' },
      world({
        price: price({ stored: { price: m('20'), following: false } }),
      }),
    );
    expect(out).toMatchObject({
      priceMode: 'manual',
      priceOverride: '25.0000',
      replacesPrice: null,
      existingPrice: '20.0000',
    });
    expect(out.state).toBe('ready');
  });

  it("refuses a typed price of zero or less, and one under the floor of now, on the field with the listing route's words", () => {
    expect(refused(row(), { retailPrice: '0.0000' })).toEqual([
      { field: 'retailPrice', code: 'invalid', message: 'Enter a price greater than zero.' },
    ]);
    expect(refused(row(), { retailPrice: '-1.0000' })[0]).toMatchObject({ code: 'invalid' });
    expect(refused(row(), { retailPrice: '11.0000' })).toEqual([
      { field: 'retailPrice', code: 'below_floor', message: 'Below the storefront floor of $11.66.' },
    ]);
    expect(stored(row(), { retailPrice: '11.6600' }).priceMode).toBe('manual');
  });

  it('stores the rule over the typed price the service has now as the price to replace, and none when there is no typed price', () => {
    const typed = world({ price: price({ stored: { price: m('20'), following: false } }) });
    expect(stored(row({ priceMode: 'keep' }), { pricing: 'rule' }, typed)).toMatchObject({
      priceMode: 'rule',
      replacesPrice: '20.0000',
    });
    expect(stored(row({ priceMode: 'keep' }), { pricing: 'rule' }, world())).toMatchObject({
      priceMode: 'rule',
      replacesPrice: null,
    });
    // A price that follows a rule is not a typed price: nothing to replace, and the row keeps it.
    const following = world({ price: price({ stored: { price: m('13.99'), following: true } }) });
    expect(stored(row({ priceMode: 'keep' }), { pricing: 'rule' }, following)).toMatchObject({
      priceMode: 'keep',
      replacesPrice: null,
    });
  });

  it('keeps the price the service has, and refuses to keep one it does not have', () => {
    const typed = world({ price: price({ stored: { price: m('20'), following: false } }) });
    expect(stored(row({ priceMode: 'manual', priceOverride: '25.0000' }), { pricing: 'keep' }, typed)).toMatchObject({
      priceMode: 'keep',
      priceOverride: null,
      flags: expect.arrayContaining(['price_kept']),
    });
    expect(refused(row(), { pricing: 'keep' })).toEqual([
      { field: 'pricing', code: 'invalid', message: 'This service has no retail price to keep.' },
    ]);
  });

  it('judges the row again on the facts of now: the price of now, the flags of the price, a blocked row loses its tick', () => {
    expect(stored(row({ flags: ['no_rule'] }), { brand: 'Apple' })).toMatchObject({
      rulePrice: '13.9900',
      state: 'ready',
    });
    const noRule = world({ price: price({ rule: null, rulePrice: null }) });
    expect(stored(row(), { brand: 'Apple' }, noRule)).toMatchObject({
      state: 'blocked',
      blockedReason: 'price_missing',
      included: false,
      flags: expect.arrayContaining(['no_rule']),
    });
  });

  it('blocks a typed price that fell under a floor that rose, and says nothing is changed for staff', () => {
    const risen = world({ price: price({ floor: m('15') }) });
    const out = stored(row({ priceMode: 'manual', priceOverride: '12.0000' }), { brand: 'Apple' }, risen);
    expect(out).toMatchObject({
      state: 'blocked',
      blockedReason: 'below_floor',
      priceMode: 'manual',
      priceOverride: '12.0000',
    });
  });

  it('answers a service that was disabled since with a blocked row, not an error', () => {
    const out = stored(row(), { brand: 'Apple' }, world({ facts: { ...FACTS, serviceStatus: 'disabled' } }));
    expect(out).toMatchObject({ state: 'blocked', blockedReason: 'service_disabled', included: false });
  });

  it('blocks a typed address that a listing holds now', () => {
    const out = stored(
      row({ slug: 'taken', slugSource: 'staff' }),
      { brand: 'Apple' },
      world({ listingSlugs: new Set(['taken']) }),
    );
    expect(out).toMatchObject({ state: 'blocked', blockedReason: 'slug_taken', slug: 'taken' });
  });
});

describe('editRow: the tick', () => {
  it('sets the tick the body sends, and leaves it alone otherwise', () => {
    expect(stored(row(), { included: false }).included).toBe(false);
    expect(
      stored(row({ state: 'review', included: false, flags: ['duplicate_name'] }), { included: true }).included,
    ).toBe(true);
    expect(stored(row({ included: false }), { brand: 'Apple' }).included).toBe(false);
  });

  it('refuses to tick a row that is blocked after the change, with the sentence of the reason', () => {
    const noRule = world({ price: price({ rule: null, rulePrice: null }) });
    expect(refused(row(), { included: true }, noRule)).toEqual([
      { field: 'included', code: 'blocked', message: BLOCK_SENTENCES.price_missing },
    ]);
    // Unticking a blocked row is allowed.
    expect(stored(row(), { included: false }, noRule)).toMatchObject({ state: 'blocked', included: false });
  });

  it('ticks a row that leaves blocked, by the default of its new state', () => {
    const blocked = row({ state: 'blocked', included: false, flags: ['no_rule'] });
    expect(stored(blocked, { brand: 'Apple' })).toMatchObject({ state: 'ready', included: true });
    expect(stored(blocked, { brand: 'Apple', included: false })).toMatchObject({ state: 'ready', included: false });
    const review = row({ state: 'blocked', included: false, flags: ['duplicate_name'] });
    expect(stored(review, { brand: 'Apple' })).toMatchObject({ state: 'review', included: false });
  });
});

describe('editRow: reset and the conflicts', () => {
  it('gives back what was detected and clears edited', () => {
    const edited = row({
      title: 'My title',
      slug: 'my-address',
      slugSource: 'staff',
      brand: 'Samsung',
      carrier: 'Orange',
      country: 'FR',
      priceMode: 'manual',
      priceOverride: '25.0000',
      edited: true,
    });
    const out = stored(edited, { reset: true });
    expect(out).toMatchObject({
      title: DETECTED.title,
      slug: DETECTED.slug,
      slugSource: 'auto',
      brand: DETECTED.brand,
      carrier: DETECTED.carrier,
      country: DETECTED.country,
      priceMode: 'rule',
      priceOverride: null,
      edited: false,
    });
    expect(out.flags).toContain('no_brand');
  });

  it('gives the default price mode: keep when the service has a price', () => {
    const typed = world({ price: price({ stored: { price: m('20'), following: false } }) });
    expect(stored(row({ priceMode: 'manual', priceOverride: '25.0000' }), { reset: true }, typed).priceMode).toBe(
      'keep',
    );
  });

  it('gives back the flags of the supplier name that an earlier edit dropped', () => {
    const w = world({ naming: { name: 'Foo (Bar Unlock', type: 'imei', group: 'Carrier unlock' } });
    const detected = { ...DETECTED, title: 'Foo Bar Unlock', slug: 'foo-bar-unlock', carrier: '', country: '' };
    const edited = row({
      detected,
      title: 'My title',
      slug: 'my-title',
      carrier: '',
      country: '',
      flags: ['no_brand'],
      edited: true,
    });
    expect(stored(edited, { reset: true }, w).flags).toContain('brackets_repaired');
  });

  it('gives the next free address when the detected one is taken since', () => {
    const out = stored(
      row({ slug: 'mine', slugSource: 'staff', edited: true }),
      { reset: true },
      world({
        listingSlugs: new Set([DETECTED.slug]),
      }),
    );
    expect(out.slug).toBe(`${DETECTED.slug}-2`);
    expect(out.flags).toContain('slug_suffixed');
  });

  it('refuses reset beside any other key, and a price beside a price key', () => {
    expect(refused(row(), { reset: true, title: 'x' })).toEqual([
      expect.objectContaining({ field: 'reset', code: 'conflict' }),
    ]);
    expect(refused(row(), { reset: true, included: false })).toEqual([expect.objectContaining({ code: 'conflict' })]);
    expect(refused(row(), { retailPrice: '20.0000', pricing: 'rule' })).toEqual([
      expect.objectContaining({ field: 'retailPrice', code: 'conflict' }),
    ]);
  });

  it('reports every refusal of a body together', () => {
    const problems = refused(row(), { slug: 'Bad Slug', retailPrice: '1.0000' });
    expect(problems.map((p) => p.field)).toEqual(['slug', 'retailPrice']);
  });
});

describe('withFacts: a bulk change of the facts', () => {
  const base = {
    title: DETECTED.title,
    slug: DETECTED.slug,
    brand: '',
    carrier: 'AT&T',
    country: '',
    detected: { ...DETECTED, country: '' },
    flags: ['no_brand', 'carrier_no_country'],
    blockedReason: null,
  };

  it('is null when no fact differs', () => {
    expect(withFacts(base, {})).toBeNull();
    expect(withFacts(base, { brand: '', carrier: 'AT&T' })).toBeNull();
  });

  it('works out the flags and the state again: a brand and a country remove their badges', () => {
    expect(withFacts(base, { brand: 'Apple', country: 'US' })).toEqual({
      brand: 'Apple',
      carrier: 'AT&T',
      country: 'US',
      flags: [],
      state: 'ready',
    });
  });

  it('lets a country that was chosen end multi_country, and the row leaves review', () => {
    const multi = { ...base, flags: ['multi_country', 'no_brand'] };
    expect(withFacts(multi, { country: 'GB' })).toMatchObject({ flags: ['no_brand'], state: 'ready' });
  });

  it('clears a fact with an empty text, and never unblocks a blocked row', () => {
    expect(withFacts({ ...base, brand: 'Apple', flags: [] }, { brand: '' })).toMatchObject({
      flags: expect.arrayContaining(['no_brand']),
    });
    expect(withFacts({ ...base, blockedReason: 'price_missing' }, { brand: 'Apple' })).toMatchObject({
      state: 'blocked',
    });
  });
});
