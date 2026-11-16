import { describe, expect, it } from 'bun:test';
import {
  completionsOf,
  escapeHtml,
  ghostOf,
  highlightTitle,
  mergeCandidates,
  pickFilters,
  typedPrefix,
} from './suggest-assembly';

const term = (q: string, kind: 'title' | 'brand' | 'synonym' = 'title') => ({ q, kind });
const hit = (id: number, ...tokens: string[]) => ({
  document: { id: String(id) },
  highlights: [{ field: 'title', matched_tokens: tokens }],
});
const result = (...hits: ReturnType<typeof hit>[]) => ({ found: hits.length, hits });

describe('typedPrefix', () => {
  it('normalises and keeps one trailing space', () => {
    expect(typedPrefix('  SAMSUNG   FRP  ')).toBe('samsung frp ');
    expect(typedPrefix('Samsung')).toBe('samsung');
    expect(typedPrefix('   ')).toBe('');
    expect(typedPrefix('AT&T iphone')).toBe('att iphone');
  });
});

describe('ghostOf', () => {
  it('completes the word being typed, one word at a time', () => {
    expect(ghostOf('icl', [term('icloud'), term('icloud removal')])).toBe('oud');
    expect(ghostOf('iphone 15 p', [term('iphone 15 pro max')])).toBe('ro');
    expect(ghostOf('iphone 15 pro m', [term('iphone 15 pro max')])).toBe('ax');
  });

  it('draws the next word without a double space when the input ends with a space', () => {
    expect(ghostOf('samsung ', [term('samsung', 'brand'), term('samsung frp bypass'), term('samsung frp')])).toBe(
      'frp',
    );
  });

  it('keeps the leading space when the typed text ends at a word boundary', () => {
    expect(ghostOf('samsung', [term('samsung', 'brand'), term('samsung frp')])).toBe(' frp');
  });

  it('skips phrases that do not start with the typed text and is null when none does', () => {
    expect(ghostOf('sams', [term('sansung frp'), term('samsung frp')])).toBe('ung');
    expect(ghostOf('zzz', [term('samsung')])).toBeNull();
    expect(ghostOf('', [term('samsung')])).toBeNull();
    expect(ghostOf('samsung', [term('samsung')])).toBeNull();
  });
});

describe('completionsOf', () => {
  it('leaves out the typed text itself and repeats, at most six', () => {
    const terms = ['samsung', 'samsung frp', 'samsung frp', 'samsung galaxy', 'a', 'b', 'c', 'd', 'e'].map((q) =>
      term(q),
    );
    expect(completionsOf('samsung', terms).map((c) => c.text)).toEqual([
      'samsung frp',
      'samsung galaxy',
      'a',
      'b',
      'c',
      'd',
    ]);
    expect(completionsOf('samsung ', terms).map((c) => c.text)).not.toContain('samsung');
  });
});

describe('mergeCandidates', () => {
  it('lists the services first, then the nearby ones that are not among them', () => {
    const merged = mergeCandidates(result(hit(1, 'samsung'), hit(2)), result(hit(2), hit(3, 'galaxy'), hit(1)));
    expect(merged.map((c) => c.id)).toEqual([1, 2, 3]);
    expect(merged[0]!.tokens).toEqual(['samsung']);
    expect(merged[2]!.tokens).toEqual(['galaxy']);
  });
});

describe('pickFilters', () => {
  const labels = {
    brands: new Map([['samsung', 'Samsung']]),
    networks: new Map([
      ['vodafone', 'Vodafone'],
      ['t-mobile', 'T-Mobile'],
    ]),
    categories: new Map([[3, 'Samsung Services']]),
  };
  const facets = [
    {
      field_name: 'brand_key',
      counts: [
        { value: 'samsung', count: 9 },
        { value: 'apple', count: 4 },
      ],
    },
    {
      field_name: 'carrier_key',
      counts: [
        { value: 'vodafone', count: 2 },
        { value: 't-mobile', count: 5 },
      ],
    },
    {
      field_name: 'country',
      counts: [
        { value: 'GB', count: 3 },
        { value: 'US', count: 8 },
      ],
    },
    { field_name: 'category_id', counts: [{ value: '3', count: 9 }] },
  ];

  it('offers the network whose name starts with the typed word', () => {
    expect(pickFilters('vod', facets, labels)).toEqual([
      { kind: 'network', value: 'Vodafone', label: 'Network: Vodafone', count: 2 },
    ]);
  });

  it('orders by kind, then count, and keeps at most four', () => {
    const picked = pickFilters('samsung tmobile uk', facets, labels);
    expect(picked.map((filter) => filter.label)).toEqual([
      'Brand: Samsung',
      'Network: T-Mobile',
      'Country: United Kingdom',
      'Category: Samsung Services',
    ]);
    expect(pickFilters('samsung tmobile uk vod', facets, labels).length).toBeLessThanOrEqual(4);
  });

  it('matches a country by its aliases and gives the code as the value', () => {
    expect(pickFilters('uk', facets, labels)).toEqual([
      { kind: 'country', value: 'GB', label: 'Country: United Kingdom', count: 3 },
    ]);
    expect(pickFilters('usa', facets, labels)[0]).toMatchObject({ kind: 'country', value: 'US' });
  });

  it('offers nothing for a one-letter word or an empty query', () => {
    expect(pickFilters('s', facets, labels)).toEqual([]);
    expect(pickFilters('', facets, labels)).toEqual([]);
  });
});

describe('highlightTitle', () => {
  it('marks matched words and keeps punctuation outside', () => {
    expect(highlightTitle('Samsung Galaxy A52 Unlock (SM-A525F)', ['samsung', 'sma525f'])).toBe(
      '<mark>Samsung</mark> Galaxy A52 Unlock (<mark>SM-A525F</mark>)',
    );
    expect(highlightTitle('AT&T iPhone Unlock', ['att'])).toBe('<mark>AT&amp;T</mark> iPhone Unlock');
  });

  it('marks a word that starts with a matched prefix', () => {
    expect(highlightTitle('Samsung Galaxy A52s', ['a52'])).toBe('Samsung Galaxy <mark>A52s</mark>');
  });

  it('never lets a title inject markup', () => {
    expect(highlightTitle('<script>alert(1)</script> Unlock', ['unlock'])).toBe(
      '&lt;script&gt;alert(1)&lt;/script&gt; <mark>Unlock</mark>',
    );
    expect(escapeHtml(`"'<>&`)).toBe('&quot;&#39;&lt;&gt;&amp;');
  });

  it('keeps the spacing of the title', () => {
    expect(highlightTitle('A  B', [])).toBe('A  B');
  });
});
