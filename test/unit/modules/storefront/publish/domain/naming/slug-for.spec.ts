// Tests of the bulk publish slugs (feature 31, plan sections 3.5 and 8.2): the two substitutions, the cut at a hyphen, the next
// free suffix with the shortened base, and the unique slugs of a batch in service id order.
import { describe, expect, it } from 'bun:test';
import { SLUG_MAX_LENGTH, isSlug } from '@src/modules/storefront/domain/slug';
import { assignSlugs, nextFreeSlug, slugFor } from '@src/modules/storefront/publish/domain/naming/slug-for';

describe('slugFor', () => {
  it('writes a face value as usd, so two gift cards never share a slug', () => {
    expect(slugFor('iTunes Gift Card $10 USA')).toBe('itunes-gift-card-10-usd-usa');
    expect(slugFor('iTunes Gift Card 10 USA')).toBe('itunes-gift-card-10-usa');
    expect(slugFor('Roblox $12.50')).toBe('roblox-12-50-usd');
  });

  it('writes AT&T as att and every other & as and', () => {
    expect(slugFor('AT&T USA iPhone & Generic')).toBe('att-usa-iphone-and-generic');
    expect(slugFor('at&t unlock')).toBe('att-unlock');
    expect(slugFor('No_Longer_Active_On_AT&T_Account')).toBe('no-longer-active-on-att-account');
  });

  it('cuts a slug over 120 characters at the last hyphen that fits', () => {
    const slug = slugFor(`Unlock ${'model '.repeat(30)}end`);
    expect(slug.length).toBeLessThanOrEqual(SLUG_MAX_LENGTH);
    expect(slug.endsWith('-model')).toBe(true);
    expect(isSlug(slug)).toBe(true);
  });

  it('gives an empty base to a title without a Latin letter or digit', () => {
    expect(slugFor('')).toBe('');
    expect(slugFor('!!! ???')).toBe('');
  });
});

describe('nextFreeSlug', () => {
  it('keeps a free base and otherwise takes the first free suffix', () => {
    const taken = new Set(['unlock', 'unlock-2']);
    expect(nextFreeSlug('other', (slug) => taken.has(slug))).toBe('other');
    expect(nextFreeSlug('unlock', (slug) => taken.has(slug))).toBe('unlock-3');
  });

  it('shortens the base so the slug stays within 120 characters, never leaving a double hyphen', () => {
    const base = `${'a'.repeat(118)}-b`;
    const slug = nextFreeSlug(base, (candidate) => candidate === base);
    expect(slug).toBe(`${'a'.repeat(118)}-2`);
    expect(slug.length).toBeLessThanOrEqual(SLUG_MAX_LENGTH);
    const long = 'c'.repeat(120);
    const taken = new Set([long, `${'c'.repeat(118)}-2`]);
    expect(nextFreeSlug(long, (candidate) => taken.has(candidate))).toBe(`${'c'.repeat(118)}-3`);
    const tenth = nextFreeSlug(long, (candidate) => candidate === long || /-[2-9]$/.test(candidate));
    expect(tenth).toBe(`${'c'.repeat(117)}-10`);
  });

  it('leaves an empty base empty', () => {
    expect(nextFreeSlug('', () => true)).toBe('');
  });
});

describe('assignSlugs', () => {
  it('makes the slugs unique in service id order, against the batch and the taken slugs', () => {
    const slugs = assignSlugs(
      [
        { id: 30, slugBase: 'card' },
        { id: 10, slugBase: 'card' },
        { id: 20, slugBase: 'unlock' },
        { id: 40, slugBase: '' },
      ],
      ['unlock'],
    );
    expect(slugs).toEqual([
      { slug: 'card-2', suffixed: true },
      { slug: 'card', suffixed: false },
      { slug: 'unlock-2', suffixed: true },
      { slug: '', suffixed: false },
    ]);
  });

  it('never gives a slug a later row holds as its own base a second time', () => {
    const slugs = assignSlugs(
      [
        { id: 1, slugBase: 'card' },
        { id: 2, slugBase: 'card' },
        { id: 3, slugBase: 'card-2' },
      ],
      [],
    );
    expect(new Set(slugs.map((slug) => slug.slug)).size).toBe(3);
  });
});
