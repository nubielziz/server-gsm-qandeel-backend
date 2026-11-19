// Unit tests of the cleaned category name of an import (feature 31, plan 31 section 3.5). Arabic script and invisible characters are
// written with escapes only (decision 039): `english:check` reads no Arabic in any file.
import { describe, expect, it } from 'bun:test';
import { IMPORTED_CATEGORY_NAME, cleanGroupName } from '@src/modules/catalog/domain/category-name';

/** Arabic letters for "Apple" (U+0622 U+0628 U+0644). */
const ARABIC_APPLE = '\u{0622}\u{0628}\u{0644}';

describe('cleanGroupName', () => {
  it('returns a clean name as it is, case and inner punctuation included', () => {
    for (const name of [
      'Apple iPhone',
      'AT&T USA',
      'Samsung - Galaxy S24',
      'iPhone 15 (Pro) / Max',
      'Apple Inc.',
      'iPhone 15+',
      'FRP / Google Account',
      'T-Mobile USA [Clean]',
    ]) {
      expect(cleanGroupName(name)).toBe(name);
    }
  });

  it('decodes the entities of the supplier group', () => {
    expect(cleanGroupName('AT&amp;T USA')).toBe('AT&T USA');
    expect(cleanGroupName('Apple &amp; Samsung &quot;Clean&quot;')).toBe('Apple & Samsung "Clean"');
    expect(cleanGroupName('Dhru&#39;s tools')).toBe("Dhru's tools");
  });

  it('removes emoji, with their joiners and selectors, and decoration', () => {
    expect(cleanGroupName('\u{1F34E} Apple iPhone')).toBe('Apple iPhone');
    expect(cleanGroupName('Apple\u{FE0F} iPhone \u{1F525}\u{1F525}')).toBe('Apple iPhone');
    expect(cleanGroupName('\u{2705} Samsung \u{2728} Unlock')).toBe('Samsung Unlock');
    expect(cleanGroupName('\u{1F468}\u{200D}\u{1F4BB} Dev tools')).toBe('Dev tools');
  });

  it('removes direction marks and other invisible characters', () => {
    expect(cleanGroupName('\u{200F}Apple\u{200E} iPhone')).toBe('Apple iPhone');
    expect(cleanGroupName('Apple\u{200B} iPhone\u{FEFF}')).toBe('Apple iPhone');
    expect(cleanGroupName('\u{202B}Apple iPhone\u{202C}')).toBe('Apple iPhone');
    expect(cleanGroupName('Apple\u{00A0}iPhone')).toBe('Apple iPhone');
    expect(cleanGroupName('Apple\tiPhone\u{0000}')).toBe('Apple iPhone');
  });

  it('removes Arabic script runs, and the brackets and separators they leave', () => {
    expect(cleanGroupName(`${ARABIC_APPLE} Apple iPhone`)).toBe('Apple iPhone');
    expect(cleanGroupName(`Apple iPhone - ${ARABIC_APPLE}`)).toBe('Apple iPhone');
    expect(cleanGroupName(`Apple iPhone (${ARABIC_APPLE})`)).toBe('Apple iPhone');
    expect(cleanGroupName(`Apple [${ARABIC_APPLE}] iPhone`)).toBe('Apple iPhone');
  });

  it('collapses spaces and drops separators at either end', () => {
    expect(cleanGroupName('  Apple    iPhone  ')).toBe('Apple iPhone');
    expect(cleanGroupName('- Apple iPhone -')).toBe('Apple iPhone');
    expect(cleanGroupName('/ Apple | iPhone ::')).toBe('Apple | iPhone');
    expect(cleanGroupName('** Apple iPhone **')).toBe('Apple iPhone');
    expect(cleanGroupName('Tools &amp;')).toBe('Tools');
  });

  it('gives Imported for an empty group or one that is only decoration', () => {
    expect(cleanGroupName('')).toBe(IMPORTED_CATEGORY_NAME);
    expect(cleanGroupName('   ')).toBe(IMPORTED_CATEGORY_NAME);
    expect(cleanGroupName('\u{1F34E}')).toBe(IMPORTED_CATEGORY_NAME);
    expect(cleanGroupName(ARABIC_APPLE)).toBe(IMPORTED_CATEGORY_NAME);
    expect(cleanGroupName('&amp;')).toBe(IMPORTED_CATEGORY_NAME);
    expect(cleanGroupName(' - \u{200F} - ')).toBe(IMPORTED_CATEGORY_NAME);
    expect(IMPORTED_CATEGORY_NAME).toBe('Imported');
  });

  it('makes one name of the spellings of a group that differ only by decoration', () => {
    const spellings = [
      'Apple &amp; Samsung',
      '\u{1F34E} Apple & Samsung',
      '\u{200F}Apple &amp; Samsung\u{200E}',
      `Apple & Samsung ${ARABIC_APPLE}`,
      '  Apple   &amp;   Samsung  ',
    ];
    expect(new Set(spellings.map(cleanGroupName))).toEqual(new Set(['Apple & Samsung']));
  });

  it('changes nothing when it cleans its own answer', () => {
    for (const raw of [
      'Apple &amp; Samsung',
      '\u{1F34E} Apple iPhone - \u{200F}',
      `${ARABIC_APPLE} (${ARABIC_APPLE})`,
      '&amp;',
      '--',
      'iPhone 15+',
    ]) {
      const once = cleanGroupName(raw);
      expect(cleanGroupName(once)).toBe(once);
    }
  });
});
