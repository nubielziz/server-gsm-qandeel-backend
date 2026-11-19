// Unit tests of the search normalisation (feature 29, plan section 4.3 and step 0): entities, AT&T, emoji, NUL, display cleaning,
// model codes, word windows and the typo-safe rule.
import { describe, expect, it } from 'bun:test';
import {
  MAX_CODES,
  MAX_QUERY_LENGTH,
  cleanDisplay,
  decodeEntities,
  extractCodes,
  hasDigit,
  normaliseQuery,
  normaliseText,
  typoSafe,
  wordWindows,
} from '@src/modules/storefront/search/domain/normalise';

describe('normaliseText', () => {
  it('decodes entities, folds case and removes & so AT&T and AT&amp;T both give att', () => {
    expect(normaliseText('AT&amp;T USA')).toBe('att usa');
    expect(normaliseText('AT&T')).toBe('att');
    expect(normaliseText('Rock &#39;n&#x27; Roll &quot;x&quot;')).toBe('rock \'n\' roll "x"');
  });

  it('removes emoji, control characters and NUL, turns brackets and |,;: into spaces and collapses them', () => {
    expect(normaliseText('🔥 Samsung\u0000 FRP (1-24 hours) | fast; cheap: now')).toBe(
      'samsung frp 1-24 hours fast cheap now',
    );
    expect(normaliseText('  SAMSUNG \t  FRP  ')).toBe('samsung frp');
    expect(normaliseText('ｓａｍｓｕｎｇ')).toBe('samsung');
  });

  it('keeps the separators of model codes', () => {
    expect(normaliseText('SM-A525F/DS v1.2_b')).toBe('sm-a525f/ds v1.2_b');
  });

  it('cuts a query to 100 characters', () => {
    expect(normaliseQuery('a'.repeat(300))).toHaveLength(MAX_QUERY_LENGTH);
    expect(normaliseQuery('\u0000')).toBe('');
  });
});

describe('cleanDisplay', () => {
  it('keeps case and & but drops entities, emoji and control characters', () => {
    expect(cleanDisplay('AT&amp;T  iPhone ✅ Unlock\u0007')).toBe('AT&T iPhone Unlock');
    expect(decodeEntities('&unknown; &amp;')).toBe('&unknown; &');
  });
});

describe('typoSafe', () => {
  it('drops every token that holds a digit (step 0: typo-searched fields never hold one)', () => {
    expect(typoSafe('samsung sm-a525f network unlock 24h')).toBe('samsung network unlock');
    expect(typoSafe('iphone 15 pro max')).toBe('iphone pro max');
    expect(typoSafe('15 16')).toBe('');
    expect(hasDigit('a525f')).toBe(true);
    expect(hasDigit('frp')).toBe(false);
  });
});

describe('extractCodes', () => {
  it('gives the joined form, the parts and the form without a separated short prefix', () => {
    expect(extractCodes(['Galaxy A52 Unlock SM-A525F'])).toEqual(['a52', 'sma525f', 'sm', 'a525f']);
  });

  it('reads every source and ignores tokens without a letter and a digit, or outside 3-24 characters', () => {
    const codes = extractCodes(['Samsung FRP (1-24 hours) 5G', 'internal SM-G991B name', 'Vodafone UK', 'X1']);
    expect(codes).toEqual(['smg991b', 'sm', 'g991b']);
  });

  it('stops at 100 codes', () => {
    const many = Array.from({ length: 200 }, (_, i) => `abc${i}`).join(' ');
    expect(extractCodes([many])).toHaveLength(MAX_CODES);
  });
});

describe('wordWindows', () => {
  it('concatenates every window of 2-4 words of at most 24 characters', () => {
    expect(wordWindows('iPhone 15 Pro Max')).toEqual([
      'iphone15',
      'iphone15pro',
      'iphone15promax',
      '15pro',
      '15promax',
      'promax',
    ]);
    expect(wordWindows('Supercalifragilistic expialidocious')).toEqual([]);
    expect(wordWindows('one')).toEqual([]);
  });
});
