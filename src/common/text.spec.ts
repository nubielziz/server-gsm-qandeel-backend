// Unit tests of the text helpers shared by modules that cannot import each other (feature 31, plan 31 section 3.5). Characters that are
// invisible or not Latin are written with escapes only (decision 039).
import { describe, expect, it } from 'bun:test';
import { CONTROL_CHARACTERS, EMOJI, decodeEntities } from './text';

describe('decodeEntities', () => {
  it('decodes the named, decimal and hexadecimal entities supplier names carry, once', () => {
    expect(decodeEntities('AT&amp;T &quot;USA&quot; &apos;x&apos; &lt;b&gt;')).toBe('AT&T "USA" \'x\' <b>');
    expect(decodeEntities('a&nbsp;b')).toBe('a b');
    expect(decodeEntities('&#39;s &#x41;&#X42;')).toBe("'s AB");
    expect(decodeEntities('&amp;amp;')).toBe('&amp;');
  });

  it('leaves unknown, malformed and out-of-range entities as written', () => {
    expect(decodeEntities('&unknown; &#; &#x; &#99999999; &amp')).toBe('&unknown; &#; &#x; &#99999999; &amp');
  });
});

describe('the character classes', () => {
  it('EMOJI takes emoji with their joiner and variation selectors, and nothing of the text around them', () => {
    expect('Apple \u{1F34E}\u{FE0F} iPhone'.replace(EMOJI, '')).toBe('Apple  iPhone');
    expect('\u{1F468}\u{200D}\u{1F4BB} Dev'.replace(EMOJI, '')).toBe(' Dev');
    expect('Plain text 123 & symbols'.replace(EMOJI, '')).toBe('Plain text 123 & symbols');
  });

  it('CONTROL_CHARACTERS takes the C0 controls and delete, and keeps every printable character', () => {
    expect('a\u{0000}b\tc\nd\u{001f}e\u{007f}f'.replace(CONTROL_CHARACTERS, '|')).toBe('a|b|c|d|e|f');
    expect('Apple iPhone \u{00E9}'.replace(CONTROL_CHARACTERS, '|')).toBe('Apple iPhone \u{00E9}');
  });
});
