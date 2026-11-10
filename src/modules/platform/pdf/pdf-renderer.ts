// PdfRenderer: draws a small document (headings, facts, tables, text) as a PDF with pdf-lib (decision 030, amended by feature 24E for
// Arabic data). Used by the invoice PDFs, the order receipts, the client statement and the dispute evidence.
import { Injectable } from '@nestjs/common';
import fontkit from '@pdf-lib/fontkit';
import { PDFDocument, type PDFFont, type PDFPage, StandardFonts, rgb } from 'pdf-lib';
import { ArabicFonts, type FontWeight } from './pdf-fonts';
import { type BaseDirection, type RunFont, type RunFonts, classify, paragraphDirection, visualRuns } from './text-runs';

/** One column of a {@link PdfBlock} table: a title, a relative width and the side the text sits on. */
export interface PdfColumn {
  readonly title: string;
  /** Share of the page width; the widths of a table are normalised, so any positive numbers work. */
  readonly width: number;
  readonly align?: 'left' | 'right';
}

/** One block of a document, drawn top to bottom. */
export type PdfBlock =
  | { readonly kind: 'heading'; readonly text: string }
  | { readonly kind: 'text'; readonly text: string; readonly muted?: boolean }
  | { readonly kind: 'facts'; readonly rows: ReadonlyArray<readonly [label: string, value: string]> }
  | { readonly kind: 'table'; readonly columns: readonly PdfColumn[]; readonly rows: ReadonlyArray<readonly string[]> }
  | { readonly kind: 'space'; readonly size?: number };

/** What {@link PdfRenderer.render} draws. */
export interface PdfDocument {
  /** The title in the document properties and at the top of the first page. */
  readonly title: string;
  /** The line under the title (the number and date of an invoice). */
  readonly subtitle?: string;
  /** The creation time written into the properties (the injected clock's time: decision 031). */
  readonly createdAt: Date;
  readonly blocks: readonly PdfBlock[];
  /** A small line at the foot of every page. */
  readonly footer?: string;
}

const PAGE = { width: 595.28, height: 841.89 } as const; // A4 in points
const MARGIN = 48;
const INK = rgb(0.1, 0.12, 0.16);
const MUTED = rgb(0.4, 0.43, 0.5);
const RULE = rgb(0.8, 0.82, 0.86);

type Color = ReturnType<typeof rgb>;

/** Whether a standard font encodes a code point (WinAnsi), as the font itself answers. */
function latinEncoder(font: PDFFont): (codePoint: number) => boolean {
  return (codePoint) => {
    try {
      font.encodeText(String.fromCodePoint(codePoint));
      return true;
    } catch {
      return false;
    }
  };
}

/** Which weights of the Arabic font a document needs, decided before any drawing (embedding is asynchronous, drawing is not). */
type ArabicNeeds = Record<FontWeight, boolean>;

/** The cursor of one render: the page being drawn, the height left on it, and the fonts that measure and draw text. */
class Sheet {
  page: PDFPage;
  y: number;
  readonly pages: PDFPage[] = [];
  private readonly latinCodePoints = new Map<number, boolean>();

  constructor(
    private readonly pdf: PDFDocument,
    readonly font: PDFFont,
    readonly bold: PDFFont,
    private readonly arabic: Partial<Record<FontWeight, PDFFont>> = {},
    private readonly arabicFonts?: ArabicFonts,
  ) {
    this.page = this.pdf.addPage([PAGE.width, PAGE.height]);
    this.pages.push(this.page);
    this.y = PAGE.height - MARGIN;
  }

  /** Makes room for a block of `height` points, starting a new page when the current one is full. */
  need(height: number): void {
    if (this.y - height >= MARGIN + 20) return;
    this.page = this.pdf.addPage([PAGE.width, PAGE.height]);
    this.pages.push(this.page);
    this.y = PAGE.height - MARGIN;
  }

  /** Whether Helvetica encodes a character (WinAnsi; the regular and bold faces share the encoding). */
  canLatin = (codePoint: number): boolean => {
    let can = this.latinCodePoints.get(codePoint);
    if (can === undefined) {
      try {
        this.font.encodeText(String.fromCodePoint(codePoint));
        can = true;
      } catch {
        can = false;
      }
      this.latinCodePoints.set(codePoint, can);
    }
    return can;
  };

  /** The {@link RunFonts} of one weight: the Arabic font answers only when that weight was embedded. */
  private fonts(weight: FontWeight): RunFonts {
    const arabicFonts = this.arabic[weight] ? this.arabicFonts : undefined;
    return {
      canLatin: this.canLatin,
      canArabic: (codePoint) => arabicFonts?.covers(codePoint, weight) ?? false,
      scriptDirection: (codePoint) => arabicFonts?.scriptDirection(codePoint) ?? null,
    };
  }

  /** Cleans text for drawing in a weight: bidi controls removed, whitespace collapsed, undrawable characters as `?`. */
  clean(text: string, weight: FontWeight): string {
    const fonts = this.fonts(weight);
    return classify(text, fonts.canLatin, fonts.canArabic);
  }

  private pdfFont(font: RunFont, weight: FontWeight, latinWeight: FontWeight = weight): PDFFont {
    if (font === 'arabic') return this.arabic[weight]!;
    return latinWeight === 'bold' ? this.bold : this.font;
  }

  /**
   * The width of a cleaned line in points: the sum of its runs, each measured in its own font. `latinWeight` measures the
   * Helvetica runs in another face (the fact values, see {@link PdfRenderer}).
   */
  measure(
    text: string,
    size: number,
    weight: FontWeight,
    direction: BaseDirection = 'auto',
    latinWeight: FontWeight = weight,
  ): number {
    return visualRuns(text, this.fonts(weight), direction).reduce(
      (width, run) => width + this.pdfFont(run.font, weight, latinWeight).widthOfTextAtSize(run.drawn, size),
      0,
    );
  }

  /** Draws a cleaned line from `x`, its runs left to right; the drawn width equals {@link Sheet.measure}. */
  draw(
    text: string,
    x: number,
    y: number,
    size: number,
    color: Color,
    weight: FontWeight,
    direction: BaseDirection = 'auto',
  ): void {
    const runs = visualRuns(text, this.fonts(weight), direction);
    // An empty string is still drawn (an empty text object), exactly as before feature 24E, so Latin documents keep their bytes.
    if (runs.length === 0) runs.push({ text: '', drawn: '', font: 'latin', level: 0 });
    let at = x;
    for (const run of runs) {
      const font = this.pdfFont(run.font, weight);
      this.page.drawText(run.drawn, { x: at, y, size, font, color });
      at += font.widthOfTextAtSize(run.drawn, size);
    }
  }

  /** Cleans text and splits it into lines no wider than `width` points, in logical order, with the paragraph's direction. */
  wrap(
    text: string,
    weight: FontWeight,
    size: number,
    width: number,
    latinWeight: FontWeight = weight,
  ): { lines: string[]; direction: 'ltr' | 'rtl' } {
    const cleaned = this.clean(text, weight);
    const direction = paragraphDirection(cleaned);
    const lines: string[] = [];
    let line = '';
    for (const word of cleaned.split(' ')) {
      const attempt = line === '' ? word : `${line} ${word}`;
      if (line !== '' && this.measure(attempt, size, weight, direction, latinWeight) > width) {
        lines.push(line);
        line = word;
      } else {
        line = attempt;
      }
    }
    if (line !== '' || lines.length === 0) lines.push(line);
    return { lines, direction };
  }

  /**
   * Cleans text and shortens it with an ellipsis (appended in logical order) until it fits `width`: the longest prefix (at
   * least one code point) whose text plus `...` fits.
   *
   * Why the search: an Arabic measure runs bidi and a fontkit layout, so re-measuring the whole string once per dropped code
   * point (the pre-24E loop) grew with the square of the length (a 500-character cell took over a second, inline in the API).
   * The prefix is found by doubling from the short end, then bisecting: O(log n) measures, each about as long as the answer.
   * For Helvetica the width only grows with the prefix, so the result is the one the old loop gave (the golden test holds);
   * shaped Arabic is close to monotonic, and whatever prefix is chosen was measured to fit.
   */
  fit(text: string, weight: FontWeight, size: number, width: number): string {
    const cleaned = this.clean(text, weight);
    if (this.measure(cleaned, size, weight) <= width) return cleaned;
    // Whole code points, never half of a surrogate pair.
    const points = Array.from(cleaned);
    const prefix = (count: number) => points.slice(0, count).join('');
    const fits = (count: number) => this.measure(`${prefix(count)}...`, size, weight) <= width;
    // Invariants: `fitting` is 1 or a count measured to fit; `over` is the whole length or a count measured not to fit.
    let fitting = 1;
    let over = points.length;
    let probe = 2;
    while (probe < over && fits(probe)) {
      fitting = probe;
      probe *= 2;
    }
    if (probe < over) over = probe;
    while (over - fitting > 1) {
      const middle = (fitting + over) >>> 1;
      if (fits(middle)) fitting = middle;
      else over = middle;
    }
    return `${prefix(fitting)}...`;
  }
}

/** Every string of a document with the weight it is drawn in (bold: title, headings, fact values, table headers). */
function* documentStrings(document: PdfDocument): Generator<readonly [string, FontWeight]> {
  yield [document.title, 'bold'];
  if (document.subtitle) yield [document.subtitle, 'regular'];
  for (const block of document.blocks) {
    switch (block.kind) {
      case 'heading':
        yield [block.text, 'bold'];
        break;
      case 'text':
        yield [block.text, 'regular'];
        break;
      case 'facts':
        for (const [label, value] of block.rows) {
          yield [label, 'regular'];
          yield [value, 'bold'];
        }
        break;
      case 'table':
        for (const column of block.columns) yield [column.title, 'bold'];
        for (const row of block.rows) for (const cell of row) yield [cell, 'regular'];
        break;
      case 'space':
        break;
    }
  }
  if (document.footer) yield [document.footer, 'regular'];
}

/**
 * Draws documents as PDF files.
 *
 * Why: decision 030: one small pure-TypeScript renderer behind one service, shared by the invoice documents, the receipts, the
 * client statement and the dispute evidence. The layout is left to right with English labels; since feature 24E the data in it
 * (names, companies, service titles, notes) may be Arabic: a document with Arabic embeds a subset of IBM Plex Sans Arabic
 * (regular and/or bold, only the weights it uses) and draws each line as bidi runs (`text-runs.ts`), shaped by fontkit. A
 * document without Arabic embeds nothing new and comes out byte-identical to before. A character neither font draws (emoji,
 * CJK) prints as `?` instead of failing the whole document. The document properties carry the caller's time, never the clock.
 *
 * Limits (decision 030, amended): combining marks sit at the font's default position (pdf-lib ignores GPOS anchors); copying
 * Arabic text out of the PDF may be imperfect (only glyphs with a cmap entry map back to text); the page layout is not mirrored;
 * scripts other than Latin and Arabic print `?`. Fact values are measured in the regular Helvetica face and drawn bold, as
 * before feature 24E, so a Latin value keeps its line breaks.
 *
 * Side effects: none (pure; returns bytes). The first document with Arabic reads and parses the two font files once per process.
 *
 * @see docs/decisions/030-pdf-rendering.md
 */
@Injectable()
export class PdfRenderer {
  private arabicFonts?: ArabicFonts;

  /**
   * Renders a document.
   *
   * @param document the title, the blocks and the footer
   * @returns the bytes of the PDF file
   */
  async render(document: PdfDocument): Promise<Uint8Array> {
    const pdf = await PDFDocument.create({ updateMetadata: false });
    // Object numbers, and so the bytes of a Latin document, depend on the order of these calls: it is the pre-24E order (one
    // Helvetica that only encodes the title, the properties, then the drawing fonts); the Arabic fonts come last.
    const titleFont = await pdf.embedFont(StandardFonts.Helvetica);
    const needs = this.arabicNeeds(document, titleFont);
    pdf.setTitle(
      classify(document.title, latinEncoder(titleFont), (codePoint) =>
        needs.bold ? this.arabic().covers(codePoint, 'bold') : false,
      ),
    );
    pdf.setProducer('GSM');
    pdf.setCreator('GSM');
    pdf.setCreationDate(document.createdAt);
    pdf.setModificationDate(document.createdAt);
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
    const arabic: Partial<Record<FontWeight, PDFFont>> = {};
    if (needs.regular || needs.bold) {
      pdf.registerFontkit(fontkit);
      for (const weight of ['regular', 'bold'] as const) {
        if (!needs[weight]) continue;
        arabic[weight] = await pdf.embedFont(this.arabic().bytes(weight), {
          subset: true,
          customName: weight === 'bold' ? 'GSMArabic-Bold' : 'GSMArabic-Regular',
        });
      }
    }
    const sheet = new Sheet(pdf, font, bold, arabic, needs.regular || needs.bold ? this.arabic() : undefined);

    this.title(sheet, document);
    for (const block of document.blocks) this.block(sheet, block);
    this.footers(sheet, document.footer);
    return pdf.save();
  }

  /** The Arabic font, read and parsed on the first document that needs it, then kept for the life of the process. */
  private arabic(): ArabicFonts {
    this.arabicFonts ??= new ArabicFonts();
    return this.arabicFonts;
  }

  /** Scans every string of the document: a weight is needed when one of its strings has a character only the Arabic font draws. */
  private arabicNeeds(document: PdfDocument, latin: PDFFont): ArabicNeeds {
    const needs: ArabicNeeds = { regular: false, bold: false };
    const canLatin = latinEncoder(latin);
    for (const [text, weight] of documentStrings(document)) {
      if (needs[weight]) continue;
      // Only a character Helvetica cannot encode loads the Arabic font; a Latin document never reads the font files.
      const cleaned = classify(text, canLatin, () => true);
      for (const character of cleaned) {
        const codePoint = character.codePointAt(0)!;
        if (!canLatin(codePoint) && this.arabic().covers(codePoint, weight)) {
          needs[weight] = true;
          break;
        }
      }
    }
    return needs;
  }

  private title(sheet: Sheet, document: PdfDocument): void {
    sheet.draw(sheet.clean(document.title, 'bold'), MARGIN, sheet.y - 18, 20, INK, 'bold');
    sheet.y -= 30;
    if (document.subtitle) {
      sheet.draw(sheet.clean(document.subtitle, 'regular'), MARGIN, sheet.y - 4, 10, MUTED, 'regular');
      sheet.y -= 16;
    }
    this.rule(sheet);
  }

  private rule(sheet: Sheet): void {
    sheet.page.drawLine({
      start: { x: MARGIN, y: sheet.y },
      end: { x: PAGE.width - MARGIN, y: sheet.y },
      thickness: 0.6,
      color: RULE,
    });
    sheet.y -= 14;
  }

  private block(sheet: Sheet, block: PdfBlock): void {
    const width = PAGE.width - 2 * MARGIN;
    switch (block.kind) {
      case 'space':
        sheet.y -= block.size ?? 10;
        return;
      case 'heading':
        sheet.need(34);
        sheet.draw(sheet.clean(block.text, 'bold'), MARGIN, sheet.y - 12, 12, INK, 'bold');
        sheet.y -= 24;
        return;
      case 'text': {
        const { lines, direction } = sheet.wrap(block.text, 'regular', 10, width);
        for (const line of lines) {
          sheet.need(16);
          sheet.draw(line, MARGIN, sheet.y - 10, 10, block.muted ? MUTED : INK, 'regular', direction);
          sheet.y -= 15;
        }
        return;
      }
      case 'facts': {
        const labelWidth = 150;
        for (const [label, value] of block.rows) {
          const { lines, direction } = sheet.wrap(value, 'bold', 10, width - labelWidth, 'regular');
          sheet.need(15 * lines.length + 2);
          sheet.draw(sheet.clean(label, 'regular'), MARGIN, sheet.y - 10, 10, MUTED, 'regular');
          for (const line of lines) {
            sheet.draw(line, MARGIN + labelWidth, sheet.y - 10, 10, INK, 'bold', direction);
            sheet.y -= 15;
          }
        }
        sheet.y -= 4;
        return;
      }
      case 'table':
        this.table(sheet, block, width);
        return;
    }
  }

  private table(sheet: Sheet, block: Extract<PdfBlock, { kind: 'table' }>, width: number): void {
    const total = block.columns.reduce((sum, column) => sum + column.width, 0);
    const xs: number[] = [];
    const widths = block.columns.map((column) => (column.width / total) * width);
    let at = MARGIN;
    for (const columnWidth of widths) {
      xs.push(at);
      at += columnWidth;
    }
    const cell = (text: string, index: number, weight: FontWeight, y: number, color: Color) => {
      const column = block.columns[index]!;
      const size = 9;
      const fitted = sheet.fit(text, weight, size, widths[index]! - 8);
      const x =
        column.align === 'right'
          ? xs[index]! + widths[index]! - 4 - sheet.measure(fitted, size, weight)
          : xs[index]! + 4;
      sheet.draw(fitted, x, y, size, color, weight);
    };
    const header = () => {
      sheet.need(40);
      block.columns.forEach((column, index) => cell(column.title, index, 'bold', sheet.y - 10, INK));
      sheet.y -= 16;
      this.rule(sheet);
    };
    header();
    for (const row of block.rows) {
      if (sheet.y - 16 < MARGIN + 20) {
        sheet.need(1000);
        header();
      }
      row.forEach((text, index) => cell(text, index, 'regular', sheet.y - 10, INK));
      sheet.y -= 15;
    }
    sheet.y -= 6;
  }

  private footers(sheet: Sheet, footer: string | undefined): void {
    const count = sheet.pages.length;
    sheet.pages.forEach((page, index) => {
      sheet.page = page;
      const text = sheet.clean(`${footer ? `${footer}   ` : ''}Page ${index + 1} of ${count}`, 'regular');
      sheet.draw(text, MARGIN, MARGIN - 20, 8, MUTED, 'regular');
    });
  }
}
