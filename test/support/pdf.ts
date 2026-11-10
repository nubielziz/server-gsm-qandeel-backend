// PDF helpers for integration tests (decision 030, feature 24E): which fonts a rendered document embeds, read from the file itself
// (the page text is compressed, so tests check fonts, not text).
import { PDFDict, PDFDocument, PDFName } from 'pdf-lib';

/**
 * The BaseFont names of every font a PDF embeds, sorted (for example `GSMArabic-Regular`, `Helvetica`).
 *
 * @param bytes the PDF file
 * @returns the distinct font names, without the leading slash
 */
export async function pdfFontNames(bytes: Uint8Array): Promise<string[]> {
  const pdf = await PDFDocument.load(bytes);
  const names = new Set<string>();
  for (const [, object] of pdf.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFDict) || object.get(PDFName.of('Type'))?.toString() !== '/Font') continue;
    const base = object.get(PDFName.of('BaseFont'))?.toString();
    // The descendant CIDFont of a Type0 font repeats the name; the Set keeps one.
    if (base) names.add(base.slice(1));
  }
  return [...names].sort();
}
