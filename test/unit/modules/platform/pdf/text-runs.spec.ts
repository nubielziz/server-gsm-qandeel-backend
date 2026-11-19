// Unit tests of the bidi runs of the PDF renderer (feature 24E): cleaning, run splitting, visual order, mirroring, digits, and that
// bidi controls cannot reorder text. The oracle draws each run through fontkit as pdf-lib would, so it checks what lands on the page.
import { beforeAll, describe, expect, it } from 'bun:test';
import fontkit, { type Font } from '@pdf-lib/fontkit';
import { PDFDocument, type PDFFont, StandardFonts } from 'pdf-lib';
import { ArabicFonts } from '@src/modules/platform/pdf/pdf-fonts';
import {
  type BaseDirection,
  type RunFonts,
  type VisualRun,
  classify,
  paragraphDirection,
  visualRuns,
} from '@src/modules/platform/pdf/text-runs';

let fonts: RunFonts;
let shaper: Font;

beforeAll(async () => {
  const arabic = new ArabicFonts();
  const helvetica: PDFFont = await (await PDFDocument.create()).embedFont(StandardFonts.Helvetica);
  shaper = fontkit.create(arabic.bytes('regular'));
  fonts = {
    canLatin: (codePoint) => {
      try {
        helvetica.encodeText(String.fromCodePoint(codePoint));
        return true;
      } catch {
        return false;
      }
    },
    canArabic: (codePoint) => arabic.covers(codePoint),
    scriptDirection: (codePoint) => arabic.scriptDirection(codePoint),
  };
});

const clean = (text: string) => classify(text, fonts.canLatin, fonts.canArabic);
const runs = (text: string, direction?: BaseDirection) => visualRuns(clean(text), fonts, direction);
/**
 * The characters as they land on the page, left to right: Arabic-font runs go through fontkit's layout (which may reverse). A
 * ligature glyph (lam-alef) lists its letters in logical order; in a right-to-left run they sit right to left.
 */
const onPage = (list: readonly VisualRun[]) =>
  list
    .map((run) => {
      if (run.font === 'latin') return run.drawn;
      const layout = shaper.layout(run.drawn);
      return layout.glyphs
        .map((glyph) => {
          const points = layout.direction === 'rtl' ? [...glyph.codePoints].reverse() : glyph.codePoints;
          return String.fromCodePoint(...points);
        })
        .join('');
    })
    .join('');
const reversed = (text: string) => Array.from(text).reverse().join('');

describe('classify', () => {
  it('collapses whitespace as before', () => {
    expect(clean('a \t\n  b')).toBe('a b');
  });

  it('turns emoji and CJK into ? and keeps Arabic letters, digits and punctuation', () => {
    expect(clean('a\u{1F600}b中')).toBe('a?b?');
    expect(clean('مرحبا، كيف؟ ٢٠٢٦')).toBe('مرحبا، كيف؟ ٢٠٢٦');
  });

  it('removes bidi controls and invisible format characters', () => {
    expect(clean('a\u202Eb\u200Fc\u2066d\u2069\u200De\u061C')).toBe('abcde');
  });
});

describe('visualRuns', () => {
  it('draws pure Arabic as one Arabic run at level 1', () => {
    const list = runs('سلام');
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ text: 'سلام', font: 'arabic', level: 1 });
    expect(onPage(list)).toBe(reversed('سلام'));
  });

  it('draws pure Latin as one Helvetica run at level 0', () => {
    expect(runs('Invoice INV-2026-0001 (paid)')).toEqual([
      { text: 'Invoice INV-2026-0001 (paid)', drawn: 'Invoice INV-2026-0001 (paid)', font: 'latin', level: 0 },
    ]);
  });

  it('keeps an Arabic name inside a Latin line as one run, space inside, between the Latin runs', () => {
    const list = runs('Order 123 for محمد علي (VIP)');
    expect(list.map((run) => [run.text, run.font])).toEqual([
      ['Order 123 for ', 'latin'],
      ['محمد علي', 'arabic'],
      [' (VIP)', 'latin'],
    ]);
    expect(onPage(list)).toBe(`Order 123 for ${reversed('محمد علي')} (VIP)`);
  });

  it('puts the Arabic words of a right-to-left line on the right and reads numbers left to right (UAX #9)', () => {
    const line = 'فاتورة INV-2026-0001 بتاريخ 2026-11-10';
    expect(paragraphDirection(clean(line))).toBe('rtl');
    const list = runs(line);
    // Read right to left: فاتورة, the invoice number, بتاريخ, then the date. After an Arabic word the ISO date's digits are
    // Arabic numbers (rule W2), so its three groups follow the line's direction, as a browser shows the same string.
    expect(list.map((run) => run.text)).toEqual(['10', '-', '11', '-', '2026', ' بتاريخ ', 'INV-2026-0001', 'فاتورة ']);
    expect(onPage(list)).toBe(`10-11-2026${reversed(' بتاريخ ')}INV-2026-0001${reversed('فاتورة ')}`);
    expect(list.find((run) => run.text === 'INV-2026-0001')).toMatchObject({ font: 'latin', level: 2 });
  });

  it('keeps an amount with a decimal point together inside Arabic text', () => {
    expect(onPage(runs('المبلغ 1,250.75 دولار'))).toBe(`${reversed(' دولار')}1,250.75${reversed('المبلغ ')}`);
  });

  it('keeps Arabic-Indic and Persian digits in logical order, alone and inside Latin', () => {
    const alone = runs('٢٠٢٦');
    expect(alone).toEqual([{ text: '٢٠٢٦', drawn: '٦٢٠٢', font: 'arabic', level: 2 }]);
    expect(onPage(alone)).toBe('٢٠٢٦');
    expect(onPage(runs('Code ۱۲۳ ok'))).toBe('Code ۱۲۳ ok');
    expect(onPage(runs('رقم ٢٠٢٦'))).toBe(`٢٠٢٦${reversed('رقم ')}`);
  });

  it('mirrors brackets around Arabic so they face the right way', () => {
    // Logical "فاتورة (رقم)" reads right to left; on the page the leftmost glyph is the closing bracket of the reader, drawn "(".
    expect(onPage(runs('فاتورة (رقم)'))).toBe('(مقر) ةروتاف');
    expect(onPage(runs('Name (محمد)'))).toBe(`Name (${reversed('محمد')})`);
  });

  it('draws an odd run without any Arabic letter in reading order', () => {
    expect(onPage(runs('مرحبا ...!'))).toBe(`!...${reversed('مرحبا ')}`);
  });

  it('lets a forced base direction govern a wrapped continuation line', () => {
    expect(onPage(runs('(VIP) plan', 'rtl'))).toBe('plan (VIP)');
    expect(onPage(runs('(VIP) plan', 'ltr'))).toBe('(VIP) plan');
  });

  it('cannot be reordered by a bidi override hidden in user input', () => {
    // Without the cleaning, U+202E would draw 100.00 as 00.001.
    expect(onPage(runs('Total \u202E100.00'))).toBe('Total 100.00');
    expect(onPage(runs('المبلغ \u202D100.00'))).toBe(`100.00${reversed('المبلغ ')}`);
  });

  it('returns no run for an empty line', () => {
    expect(visualRuns('', fonts)).toEqual([]);
  });
});
