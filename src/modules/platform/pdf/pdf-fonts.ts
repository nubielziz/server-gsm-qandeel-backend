// The Arabic font of the PDF renderer (decision 030, amended by feature 24E): IBM Plex Sans Arabic Regular and Bold (SIL OFL 1.1),
// read once from the files next to this module and parsed with fontkit for coverage and direction questions.
import { readFileSync } from 'node:fs';
import fontkit, { type Font } from '@pdf-lib/fontkit';

/** The two weights the renderer draws with: body text, and titles, headings, fact values and table headers. */
export type FontWeight = 'regular' | 'bold';

/**
 * The bundled font files and their SHA-256, as recorded in `fonts/README.md`.
 *
 * Why: the fonts are parsed by fontkit, so only these two vetted files ever reach it; a unit test checks that the files on disk
 * still carry these hashes (a container or a worktree that lost or changed them fails the test, not a customer's invoice).
 */
export const ARABIC_FONT_FILES: Readonly<Record<FontWeight, { readonly file: string; readonly sha256: string }>> = {
  regular: {
    file: 'IBMPlexSansArabic-Regular.ttf',
    sha256: '8e0f1046c736bf939d4939ee3ae0116acf61cbcd6592deae7656761627080981',
  },
  bold: {
    file: 'IBMPlexSansArabic-Bold.ttf',
    sha256: 'b74f809dead12442ed56e02a12c3bcc02076c9ad4e32f17d0a9ca6fc1aafc89e',
  },
};

/** fontkit's tags for the Common, Inherited and Unknown scripts, which do not decide a run's direction. */
const NEUTRAL_SCRIPTS: ReadonlySet<string> = new Set(['zyyy', 'zinh', 'zzzz']);

/**
 * The Arabic-capable font of the PDF renderer: the raw bytes to embed and one parsed font per weight.
 *
 * Why: feature 24E prints Arabic names, titles and notes in invoices, receipts, statements and dispute evidence instead of `?`.
 * pdf-lib parses the bytes again when it embeds them (its subset embedder needs its own font object); the parsed fonts kept here
 * only answer which characters the font draws and whether fontkit lays a string out right to left, which the bidi step needs.
 *
 * Side effects: reads the two font files once, in the constructor.
 *
 * @see docs/decisions/030-pdf-rendering.md
 * @see src/modules/platform/pdf/fonts/README.md
 */
export class ArabicFonts {
  private readonly data: Record<FontWeight, Uint8Array>;
  private readonly fonts: Record<FontWeight, Font>;
  private readonly scripts = new Map<number, 'ltr' | 'rtl' | null>();

  constructor() {
    const read = (weight: FontWeight) =>
      new Uint8Array(readFileSync(new URL(`./fonts/${ARABIC_FONT_FILES[weight].file}`, import.meta.url)));
    this.data = { regular: read('regular'), bold: read('bold') };
    this.fonts = { regular: fontkit.create(this.data.regular), bold: fontkit.create(this.data.bold) };
  }

  /**
   * Whether the font has a glyph for a character.
   *
   * @param codePoint the Unicode code point
   * @param weight the weight asked about (both weights cover the same characters today)
   * @returns true when the font draws the character
   */
  covers(codePoint: number, weight: FontWeight = 'regular'): boolean {
    return this.fonts[weight].hasGlyphForCodePoint(codePoint);
  }

  /**
   * Whether fontkit lays a string out right to left, which it does for a string whose first script-bearing character is
   * Arabic (letters and Arabic-Indic digits) and then returns the glyphs reversed.
   *
   * @param text the string as it will be handed to `drawText`
   * @returns true when fontkit will reverse the glyphs of `text`
   */
  laysOutRightToLeft(text: string): boolean {
    return this.fonts.regular.layout(text).direction === 'rtl';
  }

  /**
   * The direction fontkit gives a run because of one character: that of the character's script, or `null` for a Common or
   * Inherited character (fontkit skips those when it picks a run's script). Cached per code point.
   *
   * @param codePoint the Unicode code point
   * @returns `rtl`, `ltr` or `null`
   */
  scriptDirection(codePoint: number): 'ltr' | 'rtl' | null {
    let direction = this.scripts.get(codePoint);
    if (direction === undefined) {
      const run = this.fonts.regular.layout(String.fromCodePoint(codePoint));
      direction = NEUTRAL_SCRIPTS.has(run.script) ? null : run.direction === 'rtl' ? 'rtl' : 'ltr';
      this.scripts.set(codePoint, direction);
    }
    return direction;
  }

  /**
   * The bytes of a weight's font file, for `PDFDocument.embedFont`.
   *
   * @param weight the weight to embed
   * @returns the TrueType file's bytes
   */
  bytes(weight: FontWeight): Uint8Array {
    return this.data[weight];
  }
}
