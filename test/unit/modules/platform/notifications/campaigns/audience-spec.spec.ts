// Unit tests of the audience spec (feature 23, plan section 5.1; decision 064): the documented shapes parse, empty or unknown parts are
// refused (a person is `staff` or `account`, never `client` or `customer`), the cross-field rules hold, and a spec splits into one selection per
// targeted group (staff, merchant ranks, retail) in the fan-out's order.
import { describe, expect, it } from 'bun:test';
import {
  AUDIENCE_KIND_ORDER,
  MAX_PEOPLE,
  MAX_SEGMENT_IDS,
  audienceProblems,
  kindOfAudience,
  parseStoredAudience,
  recipientTypeOfKind,
  selectionsOf,
  zAudienceSpec,
} from '@src/modules/platform/notifications/campaigns/audience-spec';

describe('zAudienceSpec', () => {
  it('accepts the documented shapes', () => {
    for (const spec of [
      { staff: {}, merchants: {}, customers: { hasAccount: true } },
      { staff: { roleIds: [1, 2] } },
      { merchants: { statuses: ['active', 'pending'], groupIds: [3], countries: ['JO', 'GB'] } },
      { customers: { hasAccount: false, countries: ['JO'] } },
      { include: [{ type: 'account', id: 4 }], exclude: [{ type: 'staff', id: 9 }] },
    ]) {
      expect(zAudienceSpec.safeParse(spec).success, JSON.stringify(spec)).toBe(true);
    }
  });

  it('refuses unknown keys (the removed language filter included), empty lists, too many ids and bad codes', () => {
    for (const spec of [
      { everyone: true },
      { staff: { roles: [1] } },
      { merchants: { statuses: [] } },
      { merchants: { statuses: ['suspended'] } },
      { merchants: { countries: ['jo'] } },
      { customers: { locales: ['en'] } },
      { staff: { roleIds: Array.from({ length: MAX_SEGMENT_IDS + 1 }, (_, i) => i + 1) } },
      { include: Array.from({ length: MAX_PEOPLE + 1 }, (_, i) => ({ type: 'staff', id: i + 1 })) },
      { include: [{ type: 'admin', id: 1 }] },
      // The old words of the merchant and customer days are refused: a person is a staff member or an account (decision 064).
      { include: [{ type: 'client', id: 4 }] },
      { include: [{ type: 'customer', id: 4 }] },
      { exclude: [{ type: 'client', id: 4 }], staff: {} },
      { exclude: [{ type: 'customer', id: 4 }], staff: {} },
    ]) {
      expect(zAudienceSpec.safeParse(spec).success, JSON.stringify(spec).slice(0, 80)).toBe(false);
    }
  });

  it('reads a stored spec back, or nothing when it no longer parses', () => {
    expect(parseStoredAudience({ staff: {} })).toEqual({ staff: {} });
    expect(parseStoredAudience({ staff: 'all' })).toBeUndefined();
    // The language filter is gone (decision 039): a stored `locales` key no longer parses and stops the fan-out.
    expect(parseStoredAudience({ customers: { locales: ['en'] } })).toBeUndefined();
    expect(parseStoredAudience(null)).toBeUndefined();
  });

  it('reads a stored merchant status filter of pending as active (the status no longer exists)', () => {
    expect(parseStoredAudience({ merchants: { statuses: ['pending'] } })).toEqual({
      merchants: { statuses: ['active'] },
    });
    expect(parseStoredAudience({ merchants: { statuses: ['active', 'pending'], groupIds: [3] } })).toEqual({
      merchants: { statuses: ['active'], groupIds: [3] },
    });
    // A spec with no status filter is left as it is.
    expect(parseStoredAudience({ merchants: { groupIds: [3] } })).toEqual({ merchants: { groupIds: [3] } });
  });
});

describe('audienceProblems', () => {
  it('needs someone to target', () => {
    expect(audienceProblems({})).toEqual([expect.objectContaining({ field: 'audience', code: 'empty' })]);
    expect(audienceProblems({ include: [] })[0]?.field).toBe('audience');
    expect(audienceProblems({ include: [{ type: 'staff', id: 1 }] })).toEqual([]);
  });

  it('refuses a person listed twice', () => {
    const twice = [
      { type: 'account' as const, id: 1 },
      { type: 'account' as const, id: 1 },
    ];
    expect(audienceProblems({ include: twice })[0]).toMatchObject({ field: 'audience.include' });
    expect(audienceProblems({ staff: {}, exclude: twice })[0]).toMatchObject({ field: 'audience.exclude' });
    // The same id of two types is two people: staff member 1 and account 1.
    expect(
      audienceProblems({
        include: [
          { type: 'staff', id: 1 },
          { type: 'account', id: 1 },
        ],
      }),
    ).toEqual([]);
  });

  it('asks nothing about channels: any audience can be reached by email or in the app', () => {
    expect(audienceProblems({ customers: {} })).toEqual([]);
    expect(audienceProblems({ merchants: {} })).toEqual([]);
  });
});

describe('selectionsOf', () => {
  it('splits a spec per group, staff then merchant ranks then retail, with their include and exclude ids', () => {
    expect(
      selectionsOf({
        customers: { hasAccount: true },
        staff: {},
        include: [
          { type: 'account', id: 5 },
          { type: 'account', id: 7 },
        ],
        exclude: [
          { type: 'staff', id: 1 },
          { type: 'account', id: 6 },
        ],
      }),
    ).toEqual([
      { kind: 'staff', type: 'staff', segment: {}, include: [], exclude: [1] },
      // A person added by hand may hold either rank, so its id is asked of both account groups; each keeps only its own rank.
      { kind: 'merchant', type: 'account', segment: undefined, include: [5, 7], exclude: [6] },
      { kind: 'retail', type: 'account', segment: { hasAccount: true }, include: [5, 7], exclude: [6] },
    ]);
  });

  it('stores the rows of both account groups under the one type account', () => {
    expect(AUDIENCE_KIND_ORDER).toEqual(['staff', 'merchant', 'retail']);
    expect(AUDIENCE_KIND_ORDER.map(recipientTypeOfKind)).toEqual(['staff', 'account', 'account']);
  });

  it('targets the merchant group by its segment alone, with no person added', () => {
    expect(selectionsOf({ merchants: { groupIds: [3] } })).toEqual([
      { kind: 'merchant', type: 'account', segment: { groupIds: [3] }, include: [], exclude: [] },
    ]);
  });

  it('leaves out a group that only appears in exclude', () => {
    expect(selectionsOf({ staff: {}, exclude: [{ type: 'account', id: 1 }] }).map((s) => s.kind)).toEqual(['staff']);
  });
});

describe('kindOfAudience', () => {
  it('maps a text family to the group of people it is for', () => {
    expect(kindOfAudience('staff')).toBe('staff');
    expect(kindOfAudience('merchant')).toBe('merchant');
    expect(kindOfAudience('customer')).toBe('retail');
  });
});
