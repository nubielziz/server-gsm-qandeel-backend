// Unit tests of the bundled Arabic font (feature 24E): the files match their recorded hashes, fontkit shapes Arabic with them
// (contextual forms, lam-alef) and they cover the Arabic letters, punctuation and digits.
import { describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import fontkit, { type Glyph } from '@pdf-lib/fontkit';
import { ARABIC_FONT_FILES, ArabicFonts, type FontWeight } from './pdf-fonts';

const fonts = new ArabicFonts();
const weights: readonly FontWeight[] = ['regular', 'bold'];

describe('ArabicFonts', () => {
  it('loads both files, which match their recorded SHA-256 (fonts/README.md)', () => {
    for (const weight of weights) {
      const onDisk = readFileSync(new URL(`./fonts/${ARABIC_FONT_FILES[weight].file}`, import.meta.url));
      expect(createHash('sha256').update(onDisk).digest('hex')).toBe(ARABIC_FONT_FILES[weight].sha256);
      expect(Buffer.from(fonts.bytes(weight)).equals(onDisk)).toBe(true);
    }
    expect(readFileSync(new URL('./fonts/OFL.txt', import.meta.url), 'utf8')).toContain(
      'SIL Open Font License, Version 1.1',
    );
  });

  it('shapes سلام with contextual forms and lays it out right to left', () => {
    const font = fontkit.create(fonts.bytes('regular'));
    const run = font.layout('سلام');
    // fontkit's types omit the glyph's PostScript name, which the font carries.
    const nominal = Array.from('سلام', (letter) => font.glyphForCodePoint(letter.codePointAt(0)!).id);
    expect(run.direction).toBe('rtl');
    expect(fonts.laysOutRightToLeft('سلام')).toBe(true);
    // Seen initial, lam-alef final (one glyph for two letters), meem isolated: three glyphs, none of them the nominal ones in order.
    expect(run.glyphs.map((glyph) => (glyph as Glyph & { readonly name: string }).name)).toEqual([
      'uni0645',
      'uniFEFC',
      'uniFEB3',
    ]);
    expect(run.glyphs.map((glyph) => glyph.id)).not.toEqual([...nominal].reverse());
  });

  it('draws lam-alef as one glyph in both weights', () => {
    for (const weight of weights) expect(fontkit.create(fonts.bytes(weight)).layout('لا').glyphs).toHaveLength(1);
  });

  it('covers the Arabic letters, Arabic punctuation and Arabic-Indic digits in both weights', () => {
    const wanted = [
      ...Array.from({ length: 0x064a - 0x0621 + 1 }, (_, index) => 0x0621 + index),
      ...Array.from({ length: 10 }, (_, index) => 0x0660 + index),
      ...Array.from({ length: 10 }, (_, index) => 0x06f0 + index),
      0x060c, // ،
      0x061b, // ؛
      0x061f, // ؟
      0x066b, // ٫
      0x0640, // tatweel
    ].filter((codePoint) => codePoint < 0x063b || codePoint > 0x063f); // U+063B..U+063F: rare letters outside the Arabic alphabet
    for (const weight of weights) {
      expect(
        wanted.filter((codePoint) => !fonts.covers(codePoint, weight)).map((codePoint) => codePoint.toString(16)),
      ).toEqual([]);
    }
  });

  it('tells the script direction fontkit gives a run, and null for neutrals', () => {
    expect(fonts.scriptDirection('ب'.codePointAt(0)!)).toBe('rtl');
    expect(fonts.scriptDirection('٢'.codePointAt(0)!)).toBe('rtl');
    expect(fonts.scriptDirection('a'.codePointAt(0)!)).toBe('ltr');
    for (const neutral of [' ', '(', '1', 'ـ', 'َ']) expect(fonts.scriptDirection(neutral.codePointAt(0)!)).toBeNull();
    expect(fonts.laysOutRightToLeft('(123)')).toBe(false);
  });
});
