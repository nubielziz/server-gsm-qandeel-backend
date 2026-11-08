// Tests of the slug rules (ANSWERS storefront Q9): the demo's slugOf, validation of typed slugs, and the choice between them.
import { describe, expect, it } from 'bun:test';
import { SLUG_MAX_LENGTH, chooseSlug, isSlug, slugOf } from './slug';

describe('slugOf', () => {
  it('lower-cases, turns & into "and" and joins the rest with single hyphens', () => {
    expect(slugOf('Unlock iPhone on AT&T')).toBe('unlock-iphone-on-atandt');
    expect(slugOf('Apple Warranty & Activation Date')).toBe('apple-warranty-and-activation-date');
    expect(slugOf('  Samsung Info (KG / FRP / Region) ')).toBe('samsung-info-kg-frp-region');
  });

  it('gives an empty slug when the title has no Latin letter or digit', () => {
    expect(slugOf('!!! ???')).toBe('');
    expect(slugOf('خدمة فتح')).toBe('');
  });

  it('cuts a long title and never ends on a hyphen', () => {
    const slug = slugOf(`${'word '.repeat(60)}end`);
    expect(slug.length).toBeLessThanOrEqual(SLUG_MAX_LENGTH);
    expect(slug.endsWith('-')).toBe(false);
  });
});

describe('isSlug', () => {
  it('accepts lower-case words joined by single hyphens', () => {
    expect(isSlug('about')).toBe(true);
    expect(isSlug('how-it-works-2')).toBe(true);
  });

  it.each(['About', 'about us', '-about', 'about-', 'about--us', 'about_us', '', 'a'.repeat(SLUG_MAX_LENGTH + 1)])(
    'refuses %p',
    (value) => {
      expect(isSlug(value)).toBe(false);
    },
  );
});

describe('chooseSlug', () => {
  it('uses the typed slug when it is valid', () => {
    expect(chooseSlug('my-page', 'Another title')).toEqual({ ok: true, slug: 'my-page' });
  });

  it('refuses a typed slug that is not valid instead of changing it', () => {
    const choice = chooseSlug('My Page', 'My Page');
    expect(choice.ok).toBe(false);
  });

  it('makes one from the title when none is typed', () => {
    expect(chooseSlug(undefined, 'About us')).toEqual({ ok: true, slug: 'about-us' });
    expect(chooseSlug('', 'About us')).toEqual({ ok: true, slug: 'about-us' });
  });

  it('asks for a slug when the title cannot make one', () => {
    expect(chooseSlug(undefined, 'صفحة')).toMatchObject({ ok: false });
  });
});
