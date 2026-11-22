// Unit tests of the cleaning and bounds of supplier text (decision 051).
import { describe, expect, it } from 'bun:test';
import {
  SUPPLIER_STRING_MAX,
  cleanSupplierJson,
  cleanSupplierText,
  cutText,
  supplierBlock,
  supplierLine,
} from '@src/modules/suppliers/domain/supplier-text';

describe('cleanSupplierText', () => {
  it('removes control characters and lone surrogates, keeps tab, line feed, carriage return, surrogate pairs and right-to-left marks', () => {
    expect(cleanSupplierText('a\u0000b\u0001c\u0008d\u000be\u000cf\u001fg\u007fh\u0085i\u009fj')).toBe('abcdefghij');
    expect(cleanSupplierText('end\ud800')).toBe('end');
    expect(cleanSupplierText('\udc00')).toBe('');
    expect(cleanSupplierText('x\ud800y')).toBe('xy');
    // A high surrogate, a NUL and a low surrogate in a row: none of the three is a valid pair.
    expect(cleanSupplierText('p\ud800\u0000\udc00q')).toBe('pq');
    expect(cleanSupplierText('smile \u{1F600} done')).toBe('smile \u{1F600} done');
    expect(cleanSupplierText('a\tb\nc\rd')).toBe('a\tb\nc\rd');
    // U+200F (right-to-left mark) and Arabic letters written with escapes: supplier text in Arabic is data (decision 039).
    expect(cleanSupplierText('\u200f\u0645\u0631\u062d\u0628\u0627')).toBe('\u200f\u0645\u0631\u062d\u0628\u0627');
  });
});

describe('cutText', () => {
  it('cuts at the cap without leaving half of a surrogate pair', () => {
    expect(cutText('ab\u{1F600}', 3)).toBe('ab');
    expect(cutText('ab\u{1F600}', 4)).toBe('ab\u{1F600}');
    expect(cutText('short', 10)).toBe('short');
    expect(cleanSupplierText('y'.repeat(25_000))).toHaveLength(SUPPLIER_STRING_MAX);
  });
});

describe('cleanSupplierJson', () => {
  it('cleans every string and key of an answer, drops __proto__ and what lies deeper than 32 levels', () => {
    const parsed = JSON.parse(
      '{"SUCC\\u0000ESS":[{"MESSAGE":"hi\\u0000 there","n":5,"t":true,"z":null}],"__proto__":{"SUCCESS":[{"polluted":1}]}}',
    ) as unknown;
    const clean = cleanSupplierJson(parsed) as Record<string, unknown>;
    expect(Object.keys(clean)).toEqual(['SUCCESS']);
    expect(Object.hasOwn(clean, '__proto__')).toBe(false);
    expect((clean as { SUCCESS?: unknown }).SUCCESS).toEqual([{ MESSAGE: 'hi there', n: 5, t: true, z: null }]);
    expect(Object.getPrototypeOf(clean)).toBe(Object.prototype);
    expect(({} as { SUCCESS?: unknown }).SUCCESS).toBeUndefined();

    let deep: unknown = 'leaf';
    for (let level = 0; level < 40; level += 1) deep = { next: deep };
    let walk = cleanSupplierJson(deep) as { next?: unknown } | null;
    let level = 0;
    while (walk !== null && typeof walk === 'object' && 'next' in walk) {
      walk = walk.next as { next?: unknown } | null;
      level += 1;
    }
    // The root is level 0: the objects of levels 0 to 32 are kept (33 of them) and the value at level 33 is null.
    expect(level).toBe(33);
    expect(walk).toBeNull();
  });
});

describe('supplierLine', () => {
  it('reads a line: tabs and line breaks become spaces, trimmed, capped; a number becomes text; anything else is empty', () => {
    expect(supplierLine('  one\ttwo\r\n\nthree\u2028four  ', 100)).toBe('one two three four');
    expect(supplierLine('x'.repeat(50), 10)).toBe('x'.repeat(10));
    expect(supplierLine(42, 10)).toBe('42');
    expect(supplierLine(Number.NaN, 10)).toBe('');
    expect(supplierLine({ a: 1 }, 10)).toBe('');
    expect(supplierLine(undefined, 10)).toBe('');
    expect(supplierLine('a\u0000b', 10)).toBe('ab');
  });
});

describe('supplierBlock', () => {
  it('reads a block: CRLF, CR, U+2028 and U+2029 become line feeds, tabs stay, trimmed, capped', () => {
    expect(supplierBlock('  one\r\ntwo\rthree\u2028four\u2029five\tsix  ', 100)).toBe(
      'one\ntwo\nthree\nfour\nfive\tsix',
    );
    expect(supplierBlock('z'.repeat(30), 10)).toBe('z'.repeat(10));
    expect(supplierBlock(null, 10)).toBe('');
  });
});
