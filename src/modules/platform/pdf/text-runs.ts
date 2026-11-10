// Bidirectional text for the PDF renderer (decision 030, amended by feature 24E): cleans a string, then splits one line into the
// runs to draw left to right, each with its font and the exact string to hand to pdf-lib (which shapes it through fontkit).
import bidiFactory from 'bidi-js';

/** The font a run is drawn with: the standard Helvetica (WinAnsi) or the embedded Arabic font. */
export type RunFont = 'latin' | 'arabic';

/** The base direction of a line: forced, or `auto` (from its first strong character, UAX #9 rules P2 and P3). */
export type BaseDirection = 'ltr' | 'rtl' | 'auto';

/** One run of a line, in left-to-right drawing order. */
export interface VisualRun {
  /** The run's characters in logical (reading) order, as they appear in the line. */
  readonly text: string;
  /** The string to pass to `drawText`: mirrored and reversed as needed so that, after fontkit's own reversal, it reads right. */
  readonly drawn: string;
  readonly font: RunFont;
  /** The resolved UAX #9 embedding level: odd is right to left. */
  readonly level: number;
}

/** What {@link visualRuns} needs to know about the two fonts. */
export interface RunFonts {
  /** Whether Helvetica (WinAnsi) can encode the character. */
  readonly canLatin: (codePoint: number) => boolean;
  /** Whether the Arabic font has a glyph for the character (always false when no Arabic font is embedded). */
  readonly canArabic: (codePoint: number) => boolean;
  /**
   * The direction fontkit gives a run because of this character: `rtl` for a right-to-left script (Arabic letters and digits),
   * `ltr` for another script, `null` for a Common or Inherited character (spaces, punctuation, European digits, marks), which
   * does not decide the direction of the run it sits in.
   */
  readonly scriptDirection: (codePoint: number) => 'ltr' | 'rtl' | null;
}

/**
 * Bidi control characters (LRM, RLM, ALM, the embeddings and overrides, the isolates) and invisible format characters (zero
 * width space, joiners, word joiner, BOM). They are removed before any level is computed, so a user-controlled name can never
 * reorder the rest of a line (for example reverse an amount with U+202E).
 */
const INVISIBLE = /[\u061C\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/g;

const bidi = bidiFactory();

/**
 * Cleans a string for drawing: removes bidi controls and invisible format characters, collapses whitespace to single spaces,
 * and turns every character neither font can draw into `?`.
 *
 * Why: decision 030 prints an undrawable character as `?` instead of failing the whole document (emoji, CJK); feature 24E adds
 * the Arabic font as a second source of glyphs and strips bidi controls for safety. For a Latin string the result is the same
 * as the renderer's former `printable`.
 *
 * @param text the caller's string
 * @param canLatin whether Helvetica can encode a code point
 * @param canArabic whether the embedded Arabic font (if any) has a glyph for a code point
 * @returns the cleaned string, every character of which one of the two fonts draws
 */
export function classify(
  text: string,
  canLatin: (codePoint: number) => boolean,
  canArabic: (codePoint: number) => boolean,
): string {
  let out = '';
  for (const character of text.replace(INVISIBLE, '').replace(/\s+/g, ' ')) {
    const codePoint = character.codePointAt(0)!;
    out += canLatin(codePoint) || canArabic(codePoint) ? character : '?';
  }
  return out;
}

/**
 * The base direction of a paragraph: right to left when its first strong character is right to left (UAX #9 P2, P3).
 *
 * Why: a wrapped paragraph keeps one base direction for all its lines; deriving it per line would flip a continuation line
 * that happens to start with a Latin word.
 *
 * @param text a cleaned paragraph (see {@link classify})
 * @returns `rtl` or `ltr`
 */
export function paragraphDirection(text: string): 'ltr' | 'rtl' {
  if (text === '') return 'ltr';
  return (bidi.getEmbeddingLevels(text, 'auto').paragraphs[0]?.level ?? 0) % 2 === 1 ? 'rtl' : 'ltr';
}

interface Segment {
  start: number;
  end: number;
  readonly level: number;
  readonly font: RunFont;
  /** The fontkit direction this run already has from a script character (`null` while it holds only neutrals). */
  script: 'ltr' | 'rtl' | null;
}

/**
 * Splits one line into the runs to draw from left to right.
 *
 * Why: pdf-lib draws a string in one font and lets fontkit shape it (contextual forms, lam-alef) and reverse it when its script
 * is right to left, but it neither splits a mixed line into directional runs nor orders them. This function does: UAX #9
 * embedding levels from `bidi-js` (bidi controls already removed by {@link classify}), one run per level, font and fontkit
 * direction, runs ordered by rule L2, brackets mirrored at odd levels (the bundled font has no `rtlm` feature and fontkit does
 * not mirror), and each run's string reversed when fontkit's own reversal would not give the run's direction (an odd run with
 * no Arabic letter, or Arabic-Indic digits at an even level). An odd run is drawn with the Arabic font where it can, so its
 * spaces and punctuation stay inside one shaping call; an even run uses Helvetica where it can.
 *
 * @param line one cleaned line (see {@link classify}); wrap first, then call this per line
 * @param fonts the coverage and direction answers of the two fonts
 * @param direction the paragraph's base direction (`auto`: from the line's first strong character)
 * @returns the runs in left-to-right drawing order; an empty array for an empty line
 */
export function visualRuns(line: string, fonts: RunFonts, direction: BaseDirection = 'auto'): VisualRun[] {
  if (line === '') return [];
  // A WinAnsi-only line holds no right-to-left character, so unless the base is forced to rtl it is one level-0 Helvetica run.
  if (direction !== 'rtl' && Array.from(line).every((character) => fonts.canLatin(character.codePointAt(0)!))) {
    return [{ text: line, drawn: line, font: 'latin', level: 0 }];
  }

  const { levels } = bidi.getEmbeddingLevels(line, direction);
  const mirrors = bidi.getMirroredCharactersMap(line, levels);
  const segments: Segment[] = [];
  let index = 0;
  for (const character of line) {
    const codePoint = character.codePointAt(0)!;
    const level = levels[index]!;
    const odd = level % 2 === 1;
    const font: RunFont = odd
      ? fonts.canArabic(codePoint) || !fonts.canLatin(codePoint)
        ? 'arabic'
        : 'latin'
      : fonts.canLatin(codePoint) || !fonts.canArabic(codePoint)
        ? 'latin'
        : 'arabic';
    const script = font === 'arabic' ? fonts.scriptDirection(codePoint) : null;
    const last = segments.at(-1);
    // A run must never mix an rtl-script and an ltr-script character: fontkit takes the direction from the first one it meets,
    // so after a reversal the run would flip. Neutrals join the current run (tatweel, harakat and spaces keep the joining).
    if (
      last &&
      last.level === level &&
      last.font === font &&
      (script === null || last.script === null || last.script === script)
    ) {
      last.end = index + character.length;
      last.script ??= script;
    } else {
      segments.push({ start: index, end: index + character.length, level, font, script });
    }
    index += character.length;
  }

  // Rule L2: from the highest level down to the lowest odd level, reverse every maximal sequence at that level or higher.
  // Segments have one level each, so reversing whole segments is exact; the characters inside an odd segment read right to
  // left, which the drawn string below takes care of.
  const highest = Math.max(...segments.map((segment) => segment.level));
  const lowest = Math.min(...segments.map((segment) => segment.level));
  for (let level = highest; level >= (lowest % 2 === 1 ? lowest : lowest + 1); level--) {
    for (let start = 0; start < segments.length;) {
      if (segments[start]!.level < level) {
        start++;
        continue;
      }
      let end = start;
      while (end < segments.length && segments[end]!.level >= level) end++;
      segments.splice(start, end - start, ...segments.slice(start, end).reverse());
      start = end;
    }
  }

  return segments.map((segment) => {
    const text = line.slice(segment.start, segment.end);
    const odd = segment.level % 2 === 1;
    let drawn = text;
    if (odd) {
      drawn = '';
      let at = segment.start;
      for (const character of text) {
        drawn += mirrors.get(at) ?? character;
        at += character.length;
      }
    }
    // fontkit reverses a run whose script is right to left; Helvetica never reverses.
    const reversedByFontkit = segment.font === 'arabic' && segment.script === 'rtl';
    if (odd !== reversedByFontkit) drawn = Array.from(drawn).reverse().join('');
    return { text, drawn, font: segment.font, level: segment.level };
  });
}
