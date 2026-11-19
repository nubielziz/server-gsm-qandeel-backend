// Unit tests of the PDF renderer: it makes a valid PDF with the caller's time, wraps and paginates, survives text the fonts cannot
// draw, keeps Latin documents byte-identical (golden hash) and draws Arabic data with the embedded font (feature 24E).
import { describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import fontkit from '@pdf-lib/fontkit';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, StandardFonts, decodePDFRawStream } from 'pdf-lib';
import { ArabicFonts } from '@src/modules/platform/pdf/pdf-fonts';
import { type PdfDocument, PdfRenderer } from '@src/modules/platform/pdf/pdf-renderer';

/**
 * The golden Latin document: title, subtitle, every block kind, a right-aligned column, a truncated cell, an empty cell, a
 * character Helvetica cannot draw (printed as `?`), a wrapped paragraph long enough to start a second page, and a footer.
 *
 * Why: feature 24E keeps Latin documents byte-identical; the golden test compares this document's SHA-256 with the hash recorded
 * from the renderer before the change.
 */
const LATIN_GOLDEN: PdfDocument = {
  title: 'Invoice INV-2026-0001',
  subtitle: 'Issued 2026-11-10   Due 2026-11-24',
  createdAt: new Date('2026-11-10T09:30:00.000Z'),
  footer: 'GSM Unlock Services  -  support@example.com',
  blocks: [
    { kind: 'heading', text: 'Bill to' },
    {
      kind: 'facts',
      rows: [
        ['Merchant', 'Zain Mobile Hub (ZMH-0042)'],
        ['Address', 'Building 12, King Abdullah II Street, Amman 11181, Jordan, with a long line that wraps once'],
        ['Contact', 'owner@example.com \u{1F600}'],
      ],
    },
    { kind: 'space', size: 8 },
    {
      kind: 'table',
      columns: [
        { title: 'Service', width: 4 },
        { title: 'Qty', width: 1, align: 'right' },
        { title: 'Unit price', width: 2, align: 'right' },
        { title: 'Amount', width: 2, align: 'right' },
      ],
      rows: [
        [
          'iPhone 15 Pro Max - Clean IMEI check with a very long service title that must be truncated',
          '2',
          '12.5000',
          '25.0000',
        ],
        ['Samsung FRP unlock', '1', '7.0000', '7.0000'],
        ['', '', '', '0.0000'],
        ...Array.from({ length: 40 }, (_, index) => [`Order ORD-${1000 + index}`, '1', '1.2500', '1.2500']),
      ],
    },
    { kind: 'heading', text: 'Notes' },
    { kind: 'text', text: 'Payment is due within 14 days.   Thank you\tfor your business. '.repeat(30) },
    { kind: 'text', text: 'Muted line: prices exclude VAT where the law allows.', muted: true },
  ],
};

const createdAt = new Date('2026-11-01T10:00:00.000Z');
const render = (document: Partial<PdfDocument>) =>
  new PdfRenderer().render({ title: 'Invoice', createdAt, blocks: [], ...document });

describe('PdfRenderer', () => {
  it('writes a PDF whose properties carry the given time and title', async () => {
    const bytes = await render({
      subtitle: 'INV-2026-0001',
      footer: 'GSM',
      blocks: [{ kind: 'heading', text: 'Bill' }],
    });
    expect(Buffer.from(bytes.subarray(0, 5)).toString()).toBe('%PDF-');
    const pdf = await PDFDocument.load(bytes);
    expect(pdf.getTitle()).toBe('Invoice');
    expect(pdf.getCreationDate()?.toISOString()).toBe('2026-11-01T10:00:00.000Z');
    expect(pdf.getPageCount()).toBe(1);
  });

  it('starts a new page when a table or a text runs past the end of one', async () => {
    const rows = Array.from({ length: 120 }, (_, index) => [`Line ${index}`, `${index}.0000`]);
    const bytes = await render({
      blocks: [
        {
          kind: 'table',
          columns: [
            { title: 'Item', width: 3 },
            { title: 'Amount', width: 1, align: 'right' },
          ],
          rows,
        },
        { kind: 'text', text: 'word '.repeat(2000) },
      ],
    });
    expect((await PDFDocument.load(bytes)).getPageCount()).toBeGreaterThan(2);
  });

  it('prints a character neither font can draw (emoji, CJK) as ? instead of failing', async () => {
    const bytes = await render({
      title: 'Faktura \u{1F600}',
      blocks: [
        { kind: 'facts', rows: [['Name', 'Zain 中 hub']] },
        { kind: 'table', columns: [{ title: 'A', width: 1 }], rows: [['\u{1F600} smile']] },
        { kind: 'text', text: 'x'.repeat(300) },
      ],
    });
    const pdf = await PDFDocument.load(bytes);
    expect(pdf.getTitle()).toBe('Faktura ?');
    const { shows, baseFonts } = await textShows(bytes);
    expect(shows.some((show) => show.font === 'Helvetica-Bold' && latinText(show.hex) === 'Zain ? hub')).toBe(true);
    expect([...baseFonts].some((name) => name.startsWith('GSMArabic'))).toBe(false);
  });

  it('keeps a Latin document byte-identical to the renderer before Arabic support (golden)', async () => {
    // Recorded from the unchanged renderer (main @ a05882e) before feature 24E touched it.
    const bytes = await new PdfRenderer().render(LATIN_GOLDEN);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(
      '142bbd8985aa71846febea0978c307573da081ad4daae1e6a3c893df3bdaf71f',
    );
    const { baseFonts, pages } = await textShows(bytes);
    expect(pages).toBeGreaterThan(1);
    expect([...baseFonts].sort()).toEqual(['Helvetica', 'Helvetica-Bold']);
  });
});

describe('PdfRenderer with Arabic', () => {
  const arabicDocument: Partial<PdfDocument> = {
    title: 'فاتورة ضريبية',
    subtitle: 'INV-2026-0001 بتاريخ ٢٠٢٦/١١/١٠',
    footer: 'شركة جي إس إم، عمّان؛ هل من سؤال؟',
    blocks: [
      { kind: 'heading', text: 'الفاتورة إلى' },
      {
        kind: 'facts',
        rows: [
          ['Merchant', 'محمد علي (VIP)'],
          ['محفظة', 'USD'],
        ],
      },
      {
        kind: 'table',
        columns: [
          { title: 'الخدمة', width: 3 },
          { title: 'Amount', width: 1, align: 'right' },
        ],
        rows: [['فك قفل آيفون ١٥ برو', '25.0000']],
      },
      { kind: 'text', text: 'ملاحظة: دفعة للفاتورة INV-2026-0001 بمبلغ 100.00 دولار.' },
    ],
  };

  it('embeds the two Arabic subsets as Type0 fonts and keeps the Arabic title in the properties', async () => {
    const bytes = await render(arabicDocument);
    const pdf = await PDFDocument.load(bytes);
    expect(pdf.getTitle()).toBe('فاتورة ضريبية');
    const type0 = [...pdf.context.enumerateIndirectObjects()]
      .map(([, object]) => object)
      .filter(
        (object): object is PDFDict =>
          object instanceof PDFDict && object.get(PDFName.of('Subtype'))?.toString() === '/Type0',
      )
      .map((font) => font.get(PDFName.of('BaseFont'))?.toString());
    expect(type0.sort()).toEqual(['/GSMArabic-Bold', '/GSMArabic-Regular']);
  });

  it('draws every Arabic letter, digit and punctuation mark with the Arabic font, never as ?', async () => {
    const { shows } = await textShows(await render(arabicDocument));
    const latin = shows.filter((show) => show.font.startsWith('Helvetica')).map((show) => latinText(show.hex));
    expect(latin.join('|')).not.toContain('?');
    expect(latin).toContain('INV-2026-0001');
    expect(latin).toContain('100.00');
    expect(latin).toContain('25.0000');
    for (const weight of ['GSMArabic-Regular', 'GSMArabic-Bold']) {
      const arabic = shows.filter((show) => show.font === weight);
      expect(arabic.length).toBeGreaterThan(0);
      // Identity-H: four hex digits per glyph.
      for (const show of arabic) expect(show.hex.length % 4).toBe(0);
    }
  });

  it('shapes: لا is one glyph, سلام three (seen, lam-alef, meem)', async () => {
    const { shows } = await textShows(
      await render({
        title: 'Shaping',
        blocks: [
          { kind: 'heading', text: 'لا' },
          { kind: 'text', text: 'سلام' },
        ],
      }),
    );
    expect(shows.filter((show) => show.font === 'GSMArabic-Bold').map((show) => show.hex.length / 4)).toEqual([1]);
    expect(shows.filter((show) => show.font === 'GSMArabic-Regular').map((show) => show.hex.length / 4)).toEqual([3]);
  });

  it('embeds only the weight a document uses', async () => {
    const { baseFonts } = await textShows(
      await render({ title: 'Receipt', blocks: [{ kind: 'text', text: 'شكرا لكم' }] }),
    );
    expect([...baseFonts].sort()).toEqual(['GSMArabic-Regular', 'Helvetica', 'Helvetica-Bold']);
  });

  it('ends a right-aligned mixed cell exactly at the column edge (measured width = drawn width)', async () => {
    const { shows } = await textShows(
      await render({
        title: 'Edge',
        blocks: [{ kind: 'table', columns: [{ title: 'Name', width: 1, align: 'right' }], rows: [['Ali محمد']] }],
      }),
    );
    const edge = 595.28 - 48 - 4;
    const [latin, arabic] = shows.filter((show) => show.size === 9 && show.font !== 'Helvetica-Bold');
    expect(latin?.font).toBe('Helvetica');
    expect(arabic?.font).toBe('GSMArabic-Regular');
    const helvetica = await (await PDFDocument.create()).embedFont(StandardFonts.Helvetica);
    expect(latin!.x + helvetica.widthOfTextAtSize('Ali ', 9)).toBeCloseTo(arabic!.x, 6);
    expect(arabic!.x + arabicWidth('محمد', 9)).toBeCloseTo(edge, 6);
  });

  it('truncates a long Arabic cell within its column, ellipsis included', async () => {
    const { shows } = await textShows(
      await render({
        title: 'Fit',
        blocks: [
          {
            kind: 'table',
            columns: [
              { title: 'Service', width: 1 },
              { title: 'Amount', width: 3, align: 'right' },
            ],
            rows: [['خدمة فك القفل الكاملة لهاتف سامسونج جالاكسي مع فحص الرقم التسلسلي', '1.0000']],
          },
        ],
      }),
    );
    const cell = shows.filter((show) => show.font === 'GSMArabic-Regular');
    expect(cell).toHaveLength(1);
    const columnEnd = 48 + (595.28 - 96) / 4 - 4;
    expect(cell[0]!.x).toBeCloseTo(52, 6);
    // The drawn glyphs are fewer than the whole text's, and they end inside the column.
    expect(cell[0]!.hex.length / 4).toBeLessThan(40);
    expect(cell[0]!.x + cell[0]!.width).toBeLessThanOrEqual(columnEnd + 1e-6);
  });

  it('truncates a 500-character Arabic cell in a narrow column quickly (log-many measures), inside the column', async () => {
    // Free-text cells (invoice descriptions, statement memos) allow 500 characters; the pre-fix loop took about 1.3 s here.
    // The bound is 400 ms, not the plan's 100 ms target, so a loaded machine (parallel suites) cannot make it flaky.
    const long = 'خدمة فك القفل الكاملة مع فحص الرقم ١٥ '.repeat(20).slice(0, 500);
    const document: Partial<PdfDocument> = {
      title: 'Fit',
      blocks: [
        {
          kind: 'table',
          columns: [
            { title: 'Memo', width: 1 },
            { title: 'Amount', width: 5, align: 'right' },
          ],
          rows: [[long, '1.0000']],
        },
      ],
    };
    await render(document); // Parses the Arabic fonts once, as the first Arabic document of a process does.
    const started = performance.now();
    const bytes = await render(document);
    expect(performance.now() - started).toBeLessThan(400);
    const columnEnd = 48 + (595.28 - 96) / 6 - 4;
    const cell = (await textShows(bytes)).shows.filter((show) => show.size === 9 && show.x < columnEnd);
    const arabic = cell.filter((show) => show.font === 'GSMArabic-Regular');
    expect(arabic).toHaveLength(1);
    // The cut keeps a useful part of the column (not a one-letter fallback) and every show of the cell ends inside it.
    expect(arabic[0]!.width).toBeGreaterThan((columnEnd - 52) / 2);
    for (const show of cell) expect(show.x + show.width).toBeLessThanOrEqual(columnEnd + 1e-6);
  });

  it('wraps and paginates a long mixed paragraph', async () => {
    const bytes = await render({
      title: 'Notes',
      blocks: [{ kind: 'text', text: 'دفعة محمد علي للفاتورة INV-2026-0001 '.repeat(300) }],
    });
    const { pages, shows } = await textShows(bytes);
    expect(pages).toBeGreaterThan(1);
    expect(shows.filter((show) => show.page === 1 && show.font === 'GSMArabic-Regular').length).toBeGreaterThan(0);
    // No line runs past the right margin.
    for (const show of shows.filter((one) => one.size === 10))
      expect(show.x + show.width).toBeLessThanOrEqual(595.28 - 48 + 1e-6);
  });

  it('renders the same Arabic document to the same bytes', async () => {
    expect(Buffer.from(await render(arabicDocument)).equals(Buffer.from(await render(arabicDocument)))).toBe(true);
  });
});

interface TextShow {
  readonly page: number;
  /** The BaseFont of the font the text is shown in. */
  readonly font: string;
  readonly hex: string;
  readonly x: number;
  readonly size: number;
  /** The advance width of the show in points (Helvetica from pdf-lib's metrics, Arabic from the subset's /W widths). */
  readonly width: number;
}

const regularShaper = fontkit.create(new ArabicFonts().bytes('regular'));

/** The width pdf-lib gives a string in the regular Arabic font: the sum of the laid-out glyphs' advance widths. */
function arabicWidth(text: string, size: number): number {
  return (regularShaper.layout(text).glyphs.reduce((sum, glyph) => sum + glyph.advanceWidth, 0) * size) / 1000;
}

/** Decodes a WinAnsi hex string of a Helvetica show (two hex digits per character). */
function latinText(hex: string): string {
  return String.fromCharCode(...(hex.match(/../g) ?? []).map((pair) => Number.parseInt(pair, 16)));
}

/** Every text show of a PDF made by the renderer: its page, font, hex string, x position, size and width. */
async function textShows(bytes: Uint8Array): Promise<{ pages: number; baseFonts: Set<string>; shows: TextShow[] }> {
  const pdf = await PDFDocument.load(bytes);
  const helvetica = await (await PDFDocument.create()).embedFont(StandardFonts.Helvetica);
  const helveticaBold = await (await PDFDocument.create()).embedFont(StandardFonts.HelveticaBold);
  const shows: TextShow[] = [];
  const baseFonts = new Set<string>();
  pdf.getPages().forEach((page, index) => {
    const names = new Map<string, string>();
    const resources = page.node.Resources()?.lookup(PDFName.of('Font'), PDFDict);
    for (const [key, ref] of resources?.entries() ?? []) {
      const base = (pdf.context.lookup(ref) as PDFDict).get(PDFName.of('BaseFont'))!.toString().slice(1);
      names.set(key.toString().slice(1), base);
      baseFonts.add(base);
    }
    const contents = page.node.Contents()!;
    const streams =
      contents instanceof PDFArray
        ? contents.asArray().map((ref) => pdf.context.lookup(ref) as PDFRawStream)
        : [contents as PDFRawStream];
    const text = streams.map((stream) => new TextDecoder().decode(decodePDFRawStream(stream).decode())).join('\n');
    let font = '';
    let size = 0;
    let x = 0;
    for (const match of text.matchAll(/\/(\S+) (\S+) Tf|1 0 0 1 (\S+) \S+ Tm|<([0-9A-F]*)> Tj/g)) {
      if (match[1] !== undefined) {
        font = names.get(match[1])!;
        size = Number(match[2]);
      } else if (match[3] !== undefined) {
        x = Number(match[3]);
      } else {
        const hex = match[4]!;
        let width: number;
        if (font.startsWith('GSMArabic')) {
          // The subset renumbers glyphs, so the width comes from the subset font embedded in the file.
          width = subsetWidth(pdf, page.node.Resources()!, font, hex, size);
        } else {
          width = (font === 'Helvetica-Bold' ? helveticaBold : helvetica).widthOfTextAtSize(latinText(hex), size);
        }
        shows.push({ page: index, font, hex, x, size, width });
      }
    }
  });
  return { pages: pdf.getPageCount(), baseFonts, shows };
}

/** The width of a show in an embedded Arabic subset, from the font's /W array (CID → width in thousandths). */
function subsetWidth(pdf: PDFDocument, resources: PDFDict, baseFont: string, hex: string, size: number): number {
  const fonts = resources.lookup(PDFName.of('Font'), PDFDict);
  const font = [...fonts.entries()]
    .map(([, ref]) => pdf.context.lookup(ref) as PDFDict)
    .find((dict) => dict.get(PDFName.of('BaseFont'))?.toString() === `/${baseFont}`)!;
  const descendant = pdf.context.lookup(font.lookup(PDFName.of('DescendantFonts'), PDFArray).get(0)) as PDFDict;
  const w = descendant
    .lookup(PDFName.of('W'), PDFArray)
    .asArray()
    .map((item) => pdf.context.lookup(item) ?? item);
  const widths = new Map<number, number>();
  for (let index = 0; index < w.length; index += 2) {
    const first = Number(w[index]!.toString());
    (w[index + 1] as PDFArray)
      .asArray()
      .forEach((value, offset) => widths.set(first + offset, Number(value.toString())));
  }
  const glyphs = (hex.match(/.{4}/g) ?? []).map((code) => Number.parseInt(code, 16));
  return (glyphs.reduce((sum, glyph) => sum + (widths.get(glyph) ?? 0), 0) * size) / 1000;
}
