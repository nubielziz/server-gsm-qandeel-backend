// Unit tests of the audience spec (feature 23, plan section 5.1): the documented shapes parse, empty or unknown parts are refused, the
// cross-field rules hold, and a spec splits into one selection per targeted type in the fan-out's order.
import { describe, expect, it } from 'bun:test';
import {
  MAX_PEOPLE,
  MAX_SEGMENT_IDS,
  audienceProblems,
  parseStoredAudience,
  selectionsOf,
  zAudienceSpec,
} from './audience-spec';

describe('zAudienceSpec', () => {
  it('accepts the documented shapes', () => {
    for (const spec of [
      { staff: {}, merchants: {}, customers: { hasAccount: true } },
      { staff: { roleIds: [1, 2] } },
      { merchants: { statuses: ['active', 'pending'], groupIds: [3], countries: ['JO', 'GB'] } },
      { customers: { hasAccount: false, countries: ['JO'] } },
      { include: [{ type: 'client', id: 4 }], exclude: [{ type: 'customer', id: 9 }] },
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
});

describe('audienceProblems', () => {
  it('needs someone to target', () => {
    expect(audienceProblems({}, ['in_app'])).toEqual([expect.objectContaining({ field: 'audience', code: 'empty' })]);
    expect(audienceProblems({ include: [] }, ['in_app'])[0]?.field).toBe('audience');
    expect(audienceProblems({ include: [{ type: 'staff', id: 1 }] }, ['in_app'])).toEqual([]);
  });

  it('refuses a person listed twice', () => {
    const twice = [
      { type: 'client' as const, id: 1 },
      { type: 'client' as const, id: 1 },
    ];
    expect(audienceProblems({ include: twice }, ['email'])[0]).toMatchObject({ field: 'audience.include' });
    expect(audienceProblems({ staff: {}, exclude: twice }, ['email'])[0]).toMatchObject({ field: 'audience.exclude' });
    // The same id of two types is two people.
    expect(
      audienceProblems(
        {
          include: [
            { type: 'client', id: 1 },
            { type: 'customer', id: 1 },
          ],
        },
        ['email'],
      ),
    ).toEqual([]);
  });

  it('allows Telegram only when merchants are targeted', () => {
    expect(audienceProblems({ customers: {} }, ['email', 'telegram'])[0]).toMatchObject({
      field: 'channels',
      code: 'telegram_needs_merchants',
    });
    expect(audienceProblems({ merchants: {} }, ['telegram'])).toEqual([]);
    expect(audienceProblems({ include: [{ type: 'client', id: 2 }] }, ['telegram'])).toEqual([]);
  });
});

describe('selectionsOf', () => {
  it('splits a spec per type, staff then merchants then customers, with their include and exclude ids', () => {
    expect(
      selectionsOf({
        customers: { hasAccount: true },
        staff: {},
        include: [
          { type: 'client', id: 5 },
          { type: 'customer', id: 7 },
        ],
        exclude: [
          { type: 'staff', id: 1 },
          { type: 'client', id: 6 },
        ],
      }),
    ).toEqual([
      { type: 'staff', segment: {}, include: [], exclude: [1] },
      { type: 'client', segment: undefined, include: [5], exclude: [6] },
      { type: 'customer', segment: { hasAccount: true }, include: [7], exclude: [] },
    ]);
  });

  it('leaves out a type that only appears in exclude', () => {
    expect(selectionsOf({ staff: {}, exclude: [{ type: 'customer', id: 1 }] }).map((s) => s.type)).toEqual(['staff']);
  });
});
