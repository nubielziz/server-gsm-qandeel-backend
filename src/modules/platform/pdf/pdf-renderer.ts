// PdfRenderer: draws a small document (headings, facts, tables, text) as a PDF with pdf-lib (decision 030). Used by the invoice PDFs
// of the billing feature and, later, by the client statement of feature 11.
import { Injectable } from '@nestjs/common';
import { PDFDocument, type PDFFont, type PDFPage, StandardFonts, rgb } from 'pdf-lib';

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

/** Replaces the characters the standard Latin font cannot draw (Arabic and other scripts are out of scope, decision 030). */
function printable(font: PDFFont, text: string): string {
  let out = '';
  for (const character of text.replace(/\s+/g, ' ')) {
    try {
      font.encodeText(character);
      out += character;
    } catch {
      out += '?';
    }
  }
  return out;
}

/** The cursor of one render: the page being drawn and the height left on it. */
class Sheet {
  page: PDFPage;
  y: number;
  readonly pages: PDFPage[] = [];

  constructor(
    private readonly pdf: PDFDocument,
    readonly font: PDFFont,
    readonly bold: PDFFont,
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

  /** Splits text into lines no wider than `width` points. */
  wrap(text: string, font: PDFFont, size: number, width: number): string[] {
    const lines: string[] = [];
    let line = '';
    for (const word of printable(font, text).split(' ')) {
      const attempt = line === '' ? word : `${line} ${word}`;
      if (line !== '' && font.widthOfTextAtSize(attempt, size) > width) {
        lines.push(line);
        line = word;
      } else {
        line = attempt;
      }
    }
    if (line !== '' || lines.length === 0) lines.push(line);
    return lines;
  }
}

/**
 * Draws documents as PDF files.
 *
 * Why: decision 030: one small pure-TypeScript renderer behind one service, shared by the invoice documents and the client
 * statement. The text is English in the standard Helvetica font (no Arabic shaping); a character outside that font prints as `?`
 * instead of failing the whole document. The document properties carry the caller's time, never the wall clock.
 *
 * Side effects: none (pure; returns bytes).
 *
 * @see docs/decisions/030-pdf-rendering.md
 */
@Injectable()
export class PdfRenderer {
  /**
   * Renders a document.
   *
   * @param document the title, the blocks and the footer
   * @returns the bytes of the PDF file
   */
  async render(document: PdfDocument): Promise<Uint8Array> {
    const pdf = await PDFDocument.create({ updateMetadata: false });
    pdf.setTitle(printable(await pdf.embedFont(StandardFonts.Helvetica), document.title));
    pdf.setProducer('GSM');
    pdf.setCreator('GSM');
    pdf.setCreationDate(document.createdAt);
    pdf.setModificationDate(document.createdAt);
    const sheet = new Sheet(
      pdf,
      await pdf.embedFont(StandardFonts.Helvetica),
      await pdf.embedFont(StandardFonts.HelveticaBold),
    );

    this.title(sheet, document);
    for (const block of document.blocks) this.block(sheet, block);
    this.footers(sheet, document.footer);
    return pdf.save();
  }

  private title(sheet: Sheet, document: PdfDocument): void {
    sheet.page.drawText(printable(sheet.bold, document.title), {
      x: MARGIN,
      y: sheet.y - 18,
      size: 20,
      font: sheet.bold,
      color: INK,
    });
    sheet.y -= 30;
    if (document.subtitle) {
      sheet.page.drawText(printable(sheet.font, document.subtitle), {
        x: MARGIN,
        y: sheet.y - 4,
        size: 10,
        font: sheet.font,
        color: MUTED,
      });
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
        sheet.page.drawText(printable(sheet.bold, block.text), {
          x: MARGIN,
          y: sheet.y - 12,
          size: 12,
          font: sheet.bold,
          color: INK,
        });
        sheet.y -= 24;
        return;
      case 'text':
        for (const line of sheet.wrap(block.text, sheet.font, 10, width)) {
          sheet.need(16);
          sheet.page.drawText(line, {
            x: MARGIN,
            y: sheet.y - 10,
            size: 10,
            font: sheet.font,
            color: block.muted ? MUTED : INK,
          });
          sheet.y -= 15;
        }
        return;
      case 'facts': {
        const labelWidth = 150;
        for (const [label, value] of block.rows) {
          const lines = sheet.wrap(value, sheet.font, 10, width - labelWidth);
          sheet.need(15 * lines.length + 2);
          sheet.page.drawText(printable(sheet.font, label), {
            x: MARGIN,
            y: sheet.y - 10,
            size: 10,
            font: sheet.font,
            color: MUTED,
          });
          for (const line of lines) {
            sheet.page.drawText(line, {
              x: MARGIN + labelWidth,
              y: sheet.y - 10,
              size: 10,
              font: sheet.bold,
              color: INK,
            });
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
    const cell = (text: string, index: number, font: PDFFont, y: number, color: ReturnType<typeof rgb>) => {
      const column = block.columns[index]!;
      const size = 9;
      const fitted = this.fit(font, text, size, widths[index]! - 8);
      const x =
        column.align === 'right'
          ? xs[index]! + widths[index]! - 4 - font.widthOfTextAtSize(fitted, size)
          : xs[index]! + 4;
      sheet.page.drawText(fitted, { x, y, size, font, color });
    };
    const header = () => {
      sheet.need(40);
      block.columns.forEach((column, index) => cell(column.title, index, sheet.bold, sheet.y - 10, INK));
      sheet.y -= 16;
      this.rule(sheet);
    };
    header();
    for (const row of block.rows) {
      if (sheet.y - 16 < MARGIN + 20) {
        sheet.need(1000);
        header();
      }
      row.forEach((text, index) => cell(text, index, sheet.font, sheet.y - 10, INK));
      sheet.y -= 15;
    }
    sheet.y -= 6;
  }

  /** Shortens text with an ellipsis until it fits `width`. */
  private fit(font: PDFFont, text: string, size: number, width: number): string {
    let out = printable(font, text);
    if (font.widthOfTextAtSize(out, size) <= width) return out;
    while (out.length > 1 && font.widthOfTextAtSize(`${out}...`, size) > width) out = out.slice(0, -1);
    return `${out}...`;
  }

  private footers(sheet: Sheet, footer: string | undefined): void {
    const count = sheet.pages.length;
    sheet.pages.forEach((page, index) => {
      const text = printable(sheet.font, `${footer ? `${footer}   ` : ''}Page ${index + 1} of ${count}`);
      page.drawText(text, { x: MARGIN, y: MARGIN - 20, size: 8, font: sheet.font, color: MUTED });
    });
  }
}
