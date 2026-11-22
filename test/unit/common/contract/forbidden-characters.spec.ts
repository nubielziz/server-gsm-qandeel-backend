// Unit tests of the finder of U+0000 and unpaired surrogates (decision 053): where it looks, what it names and what it skips.
import { describe, expect, it } from 'bun:test';
import { forbiddenTextPathOf, withoutForbiddenText } from '@src/common/contract/forbidden-characters';
import { UploadedFile } from '@src/common/multipart';

const NUL = '\u0000';
/** A high surrogate with no low one after it, and a low one with no high one before it: neither is well-formed text. */
const LONE_HIGH = '\ud800';
const LONE_LOW = '\udc00';
/** A valid pair: the emoji U+1F600. */
const EMOJI = '\ud83d\ude00';

describe('forbiddenTextPathOf', () => {
  it('finds U+0000 in a string, an array item, a nested value and an object key, and names its path', () => {
    expect(forbiddenTextPathOf(`a${NUL}b`)).toEqual([]);
    expect(forbiddenTextPathOf({ name: `a${NUL}b` })).toEqual(['name']);
    expect(forbiddenTextPathOf({ lines: [{ imei: '1' }, { imei: `2${NUL}` }] })).toEqual(['lines', 1, 'imei']);
    expect(forbiddenTextPathOf(['ok', `x${NUL}`])).toEqual([1]);
    // An offending key is reported at the object that holds it.
    expect(forbiddenTextPathOf({ outer: { [`k${NUL}`]: 'fine' } })).toEqual(['outer']);
    expect(forbiddenTextPathOf({ [`k${NUL}`]: 'fine' })).toEqual([]);
  });

  it('finds a lone high surrogate and a lone low one, in a string, a nested value, an array item and a key', () => {
    for (const lone of [LONE_HIGH, LONE_LOW]) {
      expect(forbiddenTextPathOf(`a${lone}b`), lone).toEqual([]);
      expect(forbiddenTextPathOf(lone), lone).toEqual([]);
      expect(forbiddenTextPathOf({ name: `a${lone}` }), lone).toEqual(['name']);
      expect(forbiddenTextPathOf({ lines: [{ imei: '1' }, { imei: `${lone}2` }] }), lone).toEqual(['lines', 1, 'imei']);
      expect(forbiddenTextPathOf(['ok', `x${lone}`]), lone).toEqual([1]);
      expect(forbiddenTextPathOf({ outer: { [`k${lone}`]: 'fine' } }), lone).toEqual(['outer']);
    }
  });

  it('finds an unpaired surrogate that sits next to a valid pair or next to another half', () => {
    expect(forbiddenTextPathOf(`${EMOJI}${LONE_HIGH}`)).toEqual([]);
    expect(forbiddenTextPathOf(`${LONE_LOW}${EMOJI}`)).toEqual([]);
    // Two highs in a row: the first has no low after it. Low then high: both are unpaired.
    expect(forbiddenTextPathOf(`${LONE_HIGH}${LONE_HIGH}\udc00`)).toEqual([]);
    expect(forbiddenTextPathOf(`${LONE_LOW}${LONE_HIGH}`)).toEqual([]);
  });

  it('accepts a valid surrogate pair (an emoji) and other text that is not ASCII', () => {
    expect(forbiddenTextPathOf(EMOJI)).toBeUndefined();
    expect(forbiddenTextPathOf(`Order ${EMOJI} done`)).toBeUndefined();
    expect(forbiddenTextPathOf({ [`key${EMOJI}`]: [`${EMOJI}${EMOJI}`] })).toBeUndefined();
    // Arabic text that people type is data (decision 039).
    expect(forbiddenTextPathOf({ name: '\u0645\u062d\u0645\u062f', note: '\u202eabc' })).toBeUndefined();
  });

  it('answers the first offending string in document order', () => {
    expect(forbiddenTextPathOf({ first: { deep: `a${NUL}` }, second: `b${NUL}` })).toEqual(['first', 'deep']);
    expect(forbiddenTextPathOf({ list: [`a${NUL}`, `b${NUL}`] })).toEqual(['list', 0]);
  });

  it('looks at the names of a file part, never at its bytes', () => {
    const clean = new UploadedFile('file', 'a.pdf', 'application/pdf', Buffer.from([0, 1, 2, 0]));
    expect(forbiddenTextPathOf({ file: clean })).toBeUndefined();
    expect(
      forbiddenTextPathOf({ file: new UploadedFile('file', `a${NUL}.pdf`, 'application/pdf', Buffer.from('x')) }),
    ).toEqual(['file']);
    expect(forbiddenTextPathOf({ file: new UploadedFile('file', 'a.pdf', `text/${NUL}`, Buffer.from('x')) })).toEqual([
      'file',
    ]);
    expect(forbiddenTextPathOf({ file: new UploadedFile(`f${NUL}`, 'a.pdf', 'text/plain', Buffer.from('x')) })).toEqual(
      ['file'],
    );
  });

  it('judges the file names of a part for an unpaired surrogate too, and accepts a valid pair in them', () => {
    const part = (fieldName: string, filename: string, mime: string) =>
      new UploadedFile(fieldName, filename, mime, Buffer.from('x'));
    expect(forbiddenTextPathOf({ file: part('file', `a${LONE_HIGH}.pdf`, 'application/pdf') })).toEqual(['file']);
    expect(forbiddenTextPathOf({ file: part('file', `a${LONE_LOW}.pdf`, 'application/pdf') })).toEqual(['file']);
    expect(forbiddenTextPathOf({ file: part(`f${LONE_HIGH}`, 'a.pdf', 'application/pdf') })).toEqual(['file']);
    expect(forbiddenTextPathOf({ file: part('file', 'a.pdf', `text/${LONE_LOW}`) })).toEqual(['file']);
    expect(forbiddenTextPathOf({ file: part('file', `scan ${EMOJI}.pdf`, 'application/pdf') })).toBeUndefined();
    // The bytes are never looked at: a buffer that is not valid UTF-8 is not a text.
    expect(
      forbiddenTextPathOf({
        file: new UploadedFile('file', 'a.bin', 'application/octet-stream', Buffer.from([0xed, 0xa0, 0x80])),
      }),
    ).toBeUndefined();
  });

  it('answers undefined for clean values, numbers, null, buffers and class instances', () => {
    expect(forbiddenTextPathOf(undefined)).toBeUndefined();
    expect(forbiddenTextPathOf(null)).toBeUndefined();
    expect(forbiddenTextPathOf(42)).toBeUndefined();
    expect(forbiddenTextPathOf(true)).toBeUndefined();
    expect(forbiddenTextPathOf('plain text')).toBeUndefined();
    expect(forbiddenTextPathOf({ a: 1, b: null, c: [true, 'x'] })).toBeUndefined();
    expect(forbiddenTextPathOf(Buffer.from(`a${NUL}`))).toBeUndefined();
    expect(forbiddenTextPathOf(new Date(0))).toBeUndefined();
    class Holder {
      readonly text = `a${NUL}`;
    }
    expect(forbiddenTextPathOf(new Holder())).toBeUndefined();
    expect(
      forbiddenTextPathOf(Object.assign(Object.create(null) as Record<string, unknown>, { text: `a${NUL}` })),
    ).toEqual(['text']);
  });

  it('scans the records Fastify builds for a query and for path parameters (a prototype that has no prototype)', () => {
    // fast-querystring and find-my-way make objects of a constructor function whose prototype is `Object.create(null)`.
    function Empty(this: Record<string, unknown>) {}
    Empty.prototype = Object.create(null) as object;
    const query = new (Empty as unknown as new () => Record<string, unknown>)();
    query['brand'] = `x${NUL}`;
    expect(forbiddenTextPathOf(query)).toEqual(['brand']);
    expect(forbiddenTextPathOf({ list: [query] })).toEqual(['list', 0, 'brand']);
    const clean = new (Empty as unknown as new () => Record<string, unknown>)();
    clean['brand'] = 'x';
    expect(forbiddenTextPathOf(clean)).toBeUndefined();
    const copy = withoutForbiddenText(query);
    expect(copy['brand']).toBe('x');
    expect(forbiddenTextPathOf(copy)).toBeUndefined();
  });

  it('walks a value nested 10 000 levels deep', () => {
    let deep: unknown = `end${NUL}`;
    for (let level = 0; level < 10_000; level += 1) deep = { next: deep };
    const path = forbiddenTextPathOf(deep);
    expect(path?.length).toBe(10_000);
    let clean: unknown = 'end';
    for (let level = 0; level < 10_000; level += 1) clean = [clean];
    expect(forbiddenTextPathOf(clean)).toBeUndefined();
  });
});

describe('withoutForbiddenText', () => {
  it('returns a value that holds nothing to remove as it is', () => {
    const value = { a: ['x', { b: 'y' }] };
    expect(withoutForbiddenText(value)).toBe(value);
  });

  it('removes U+0000 from every string and key, keeping the order and the other values', () => {
    const copy = withoutForbiddenText<Record<string, unknown>>({
      [`ke${NUL}y`]: `va${NUL}lue`,
      list: [`a${NUL}`, 2, null, { inner: `b${NUL}c` }],
      n: 1,
    });
    expect(copy).toEqual({ key: 'value', list: ['a', 2, null, { inner: 'bc' }], n: 1 });
    expect(Object.keys(copy)).toEqual(['key', 'list', 'n']);
    expect(forbiddenTextPathOf(copy)).toBeUndefined();
  });

  it('replaces an unpaired surrogate with U+FFFD in every string and key, and keeps a valid pair', () => {
    const copy = withoutForbiddenText<Record<string, unknown>>({
      [`ke${LONE_HIGH}y`]: `va${LONE_LOW}lue`,
      list: [`a${LONE_HIGH}`, 2, null, { inner: `b${EMOJI}c${LONE_LOW}` }],
      both: `x${NUL}${LONE_HIGH}y`,
    });
    expect(copy).toEqual({
      'ke\ufffdy': 'va\ufffdlue',
      list: ['a\ufffd', 2, null, { inner: `b${EMOJI}c\ufffd` }],
      both: 'x\ufffdy',
    });
    expect(forbiddenTextPathOf(copy)).toBeUndefined();
    // Well-formed text is returned as it is, emoji included.
    const fine = { a: `${EMOJI}` };
    expect(withoutForbiddenText(fine)).toBe(fine);
  });

  it('keeps an own "__proto__" key as a key, never as a prototype', () => {
    const source = JSON.parse(String.raw`{"__proto__": {"x": "a\u0000"}}`) as Record<string, unknown>;
    const copy = withoutForbiddenText(source);
    expect(Object.getPrototypeOf(copy)).toBe(Object.prototype);
    expect(Object.keys(copy)).toEqual(['__proto__']);
    expect((copy as { x?: unknown }).x).toBeUndefined();
  });

  it('copies a value nested 10 000 levels deep', () => {
    let deep: unknown = `end${NUL}`;
    for (let level = 0; level < 10_000; level += 1) deep = { next: deep };
    expect(forbiddenTextPathOf(withoutForbiddenText(deep))).toBeUndefined();
  });
});
