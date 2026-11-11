// Tests of the derived category slug: the id leads, the words are Latin only, an Arabic-only or empty name gives the bare id.
import { describe, expect, it } from 'bun:test';
import { categorySlug } from './category-slug';

describe('categorySlug', () => {
  it('puts the id before the words of the name', () => {
    expect(categorySlug({ id: 4, name: 'Carrier unlock' })).toBe('4-carrier-unlock');
    expect(categorySlug({ id: 12, name: 'AT&T / Verizon' })).toBe('12-atandt-verizon');
  });

  it('is just the id when the name has no Latin letter or digit', () => {
    expect(categorySlug({ id: 7, name: 'فك الشبكات' })).toBe('7');
    expect(categorySlug({ id: 8, name: '' })).toBe('8');
  });

  it('keeps the words short and never ends on a hyphen', () => {
    const slug = categorySlug({ id: 3, name: 'word '.repeat(40) });
    expect(slug.length).toBeLessThanOrEqual(70);
    expect(slug.endsWith('-')).toBe(false);
  });
});
