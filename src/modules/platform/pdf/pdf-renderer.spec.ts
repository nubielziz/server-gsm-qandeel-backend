// Unit tests of the PDF renderer: it makes a valid PDF with the caller's time, wraps and paginates, and survives text the font cannot draw.
import { describe, expect, it } from 'bun:test';
import { PDFDocument } from 'pdf-lib';
import { type PdfDocument, PdfRenderer } from './pdf-renderer';

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

  it('prints a character the font cannot draw as ? instead of failing', async () => {
    const bytes = await render({
      title: 'Faktura مرحبا',
      blocks: [
        { kind: 'facts', rows: [['Name', 'Zain مرحبا hub']] },
        { kind: 'table', columns: [{ title: 'A', width: 1 }], rows: [['\u{1F600} smile']] },
        { kind: 'text', text: 'x'.repeat(300) },
      ],
    });
    expect((await PDFDocument.load(bytes)).getPageCount()).toBeGreaterThanOrEqual(1);
  });
});
