import { describe, expect, it } from 'bun:test';
import {
  damerauLevenshtein,
  didYouMean,
  fold,
  matchedTokensOf,
} from '@src/modules/storefront/search/domain/did-you-mean';

const hit = (...tokens: string[]) => ({ highlights: [{ field: 'title_words', matched_tokens: tokens }] });
const base = { synonymWords: new Set<string>(), lastWordComplete: true } as const;

describe('damerauLevenshtein', () => {
  it('counts insertions, deletions, substitutions and neighbour swaps as one edit each', () => {
    expect(damerauLevenshtein('samsung', 'samsung')).toBe(0);
    expect(damerauLevenshtein('samsng', 'samsung')).toBe(1);
    expect(damerauLevenshtein('iclod', 'icloud')).toBe(1);
    expect(damerauLevenshtein('icloud', 'iclodu')).toBe(1);
    expect(damerauLevenshtein('abc', 'xyz')).toBe(3);
    expect(damerauLevenshtein('', 'abc')).toBe(3);
  });
});

describe('fold and matchedTokensOf', () => {
  it('folds like the engine tokenises', () => {
    expect(fold('AT&T')).toBe('att');
    expect(fold('T-Mobile')).toBe('tmobile');
    expect(fold('(SM-A525F)')).toBe('sma525f');
  });

  it('reads string and list highlights of every field', () => {
    const tokens = matchedTokensOf({
      highlights: [
        { field: 'title', matched_tokens: ['Samsung', 'FRP'] },
        { field: 'codes', matched_tokens: [['a525f'], []] },
      ],
    });
    expect([...tokens].sort()).toEqual(['a525f', 'frp', 'samsung']);
  });
});

describe('didYouMean', () => {
  it('replaces a word no hit explains with the token all top hits share', () => {
    const hits = [hit('samsung', 'frp'), hit('samsung', 'frp'), hit('samsung')];
    expect(didYouMean({ ...base, query: 'samsng frp', hits, found: 3 })).toBe('samsung frp');
  });

  it('leaves a word alone that a hit holds exactly or as a prefix', () => {
    const hits = [hit('bypass'), hit('bypass'), hit('bypass')];
    expect(didYouMean({ ...base, query: 'frp bypas', hits, found: 3 })).toBeNull();
    expect(didYouMean({ ...base, query: 'bypass', hits, found: 3 })).toBeNull();
  });

  it('never corrects a word with a digit', () => {
    const hits = [hit('sma525f'), hit('sma525f'), hit('sma525f')];
    expect(didYouMean({ ...base, query: 'sma526f', hits, found: 3 })).toBeNull();
  });

  it('never flags a word that sits inside a synonym term', () => {
    const hits = [hit('samsung'), hit('samsung'), hit('samsung')];
    expect(
      didYouMean({ ...base, query: 'frp samsung', hits, found: 3, synonymWords: new Set(['frp', 'google']) }),
    ).toBeNull();
  });

  it('needs every one of the top min(3, found) hits to hold the replacement', () => {
    const split = [hit('icloud'), hit('icloud'), hit('cloud')];
    expect(didYouMean({ ...base, query: 'iclod', hits: split, found: 3 })).toBeNull();
    // Fewer than three hits: the ones there are decide.
    expect(didYouMean({ ...base, query: 'iclod', hits: [hit('icloud')], found: 1 })).toBe('icloud');
    expect(didYouMean({ ...base, query: 'iclod', hits: [hit('icloud'), hit('icloud'), hit('cloud')], found: 2 })).toBe(
      'icloud',
    );
  });

  it('leaves a synonym phrase typed with a slip alone, but still corrects a single word', () => {
    const hits = [hit('blacklist', 'check'), hit('blacklist', 'check'), hit('blacklist', 'check')];
    const synonymPhrases = [
      ['blacklist', 'check'],
      ['imei', 'check'],
    ];
    expect(didYouMean({ ...base, query: 'blaclist check', hits, found: 3, synonymPhrases })).toBeNull();
    expect(didYouMean({ ...base, query: 'blaclist check', hits, found: 3 })).toBe('blacklist check');
    // A one-word synonym is not a phrase: its slip is corrected.
    const icloud = [hit('icloud'), hit('icloud'), hit('icloud')];
    expect(didYouMean({ ...base, query: 'iclod', hits: icloud, found: 3, synonymPhrases })).toBe('icloud');
  });

  it('does not count a hit without highlighted tokens among those that must agree', () => {
    const hits = [hit('samsung', 'frp'), { highlights: [] }];
    expect(didYouMean({ ...base, query: 'samsng frp', hits, found: 2 })).toBe('samsung frp');
  });

  it('allows two edits for a word of seven letters or more', () => {
    const hits = [hit('network'), hit('network'), hit('network')];
    expect(didYouMean({ ...base, query: 'netwroks', hits, found: 3 })).toBe('network');
    // Six letters and two edits away: too far.
    expect(damerauLevenshtein('nwtork', 'network')).toBe(2);
    expect(didYouMean({ ...base, query: 'nwtork', hits, found: 3 })).toBeNull();
  });

  it('does not check the last word while it is still being typed', () => {
    const hits = [hit('samsung'), hit('samsung'), hit('samsung')];
    expect(didYouMean({ ...base, query: 'samsung samsng', hits, found: 3, lastWordComplete: false })).toBeNull();
    expect(didYouMean({ ...base, query: 'samsung samsng', hits, found: 3 })).toBe('samsung samsung');
  });

  it('is null without hits and ignores pinned hits', () => {
    expect(didYouMean({ ...base, query: 'samsng', hits: [], found: 0 })).toBeNull();
    expect(didYouMean({ ...base, query: 'samsng', hits: [{ ...hit('samsung'), curated: true }], found: 1 })).toBeNull();
  });
});
