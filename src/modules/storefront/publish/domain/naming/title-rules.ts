// The shop title rules of a supplier's service name (feature 31, plan section 3.5; A3 section 3, rules R1-R14), ported from the
// measured prototype: ordered pure string rules, the cut of a long title by whole trailing clauses, and the router-list guard.
// Arabic script is matched with escapes only (decision 039, fact 25 of the plan): no file holds the script itself.
import { decodeEntities } from '../../../search/domain/normalise';
import {
  CASING_FIXES,
  COMMON_SHORT_WORDS,
  PROTECTED_WORDS,
  SMALL_WORDS,
  TYPO_FIXES,
  type Replacement,
} from './lexicon/typos';

/** The type of a catalog service, as the publish run reads it. */
export type PublishServiceType = 'imei' | 'server' | 'remote' | 'file';

/** Which family of rules names a service: the IMEI rules, or the server rules (hours and days are the licence, no carrier). */
export type NamingKind = 'imei' | 'server';

/** A title longer than this is cut by whole trailing clauses (R13), when the cut makes it no other title's twin. */
export const TITLE_CUT_LENGTH = 80;

/** The cut never leaves fewer characters than this (R13). */
export const TITLE_CUT_MIN_LENGTH = 25;

/** The Arabic script blocks (basic, supplement, extended-A, presentation forms A and B). */
const ARABIC_CLASS = '\\u0600-\\u06FF\\u0750-\\u077F\\u08A0-\\u08FF\\uFB50-\\uFDFF\\uFE70-\\uFEFF';

/**
 * One character of Arabic script.
 *
 * Why: R4 of A3 section 3: the shop title is English (decision 039); written with escapes so the guard `english:check` reads no
 * Arabic in this file.
 */
export const ARABIC_SCRIPT = new RegExp(`[${ARABIC_CLASS}]`);

const ARABIC_RUN = new RegExp(`\\s*[/-]?\\s*(?:[${ARABIC_CLASS}]+[\\s/\\-+.,:]*)+(?:\\s*[/-]\\s*(?=[A-Za-z]))?`, 'g');
const ARABIC_LETTERS = new RegExp(`[${ARABIC_CLASS}]+`, 'g');
const EMOJI = /\p{Extended_Pictographic}|\u200D|\uFE0E|\uFE0F/gu;
// Check marks, sparkles, star, shamrock, guillemets, heart and bolt: decoration the Extended_Pictographic class misses or that
// suppliers write without the emoji selector.
const DECORATION = /[\u2713\u2714\u2705\u2728\u2B50\u2618\u00BB\u00AB\u2764\u26A1]/g;
// No-break space aside (it becomes a space): zero-width characters, direction marks and embeddings, isolates, the byte order
// mark and the variation selectors.
const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]|\uFE0E|\uFE0F/g;
// Letters of other scripts that suppliers type inside Latin words: the Turkish dotted capital I and dotless i (#313), the
// Cyrillic capital O (#885). Written as escapes only.
const LOOKALIKE_LETTERS: readonly Replacement[] = [
  [/\u0130/g, 'I'],
  [/\u0131/g, 'i'],
  [/\u041E/g, 'O'],
];
// A clause that states a restriction or a refusal is never cut (`[Not Support Single SIM Phone]`, `(No Refund any issue)`,
// `Infinix ONLY Mtk`): the buyer must read it on the shop.
const RESTRICTION = /\b(?:not|no|non|only|without|except|wrong)\b/i;
// A cut that drops the bracket after `Model` leaves the word dangling (`... Owner info) Model`, #476); `All Models` stays.
const DANGLING_MODEL = /\s+(?<!\b(?:all|any|every)\s+)Model$/i;
const EMPTY_BRACKETS = /\(\s*\)|\[\s*\]/g;
const ROUTER_CODE_LIST = /\bunlock(?:\/flash)? code by imei\b/i;

/** Collapses runs of white space into one space and trims the ends. */
function squeeze(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Applies a list of replacements in order. */
function applyAll(text: string, replacements: readonly Replacement[]): string {
  let out = text;
  for (const [pattern, to] of replacements)
    out = typeof to === 'string' ? out.replace(pattern, to) : out.replace(pattern, to);
  return out;
}

/**
 * Pairs the brackets: a stray closer is dropped, an opener that never closes is closed at the end (`[Existing Users Only` gives
 * `[Existing Users Only]`).
 *
 * Why: R5 and R12 of A3 section 3: 10 real names have unbalanced brackets; a shop title never shows them.
 *
 * @param text the title
 * @returns the title with every `(` and `[` closed in order
 */
export function balanceBrackets(text: string): string {
  const closer: Readonly<Record<string, string>> = { '(': ')', '[': ']' };
  const open: string[] = [];
  let out = '';
  for (const ch of text) {
    if (ch === '(' || ch === '[') {
      open.push(ch);
      out += ch;
    } else if (ch === ')' || ch === ']') {
      const last = open[open.length - 1];
      if (last !== undefined && closer[last] === ch) {
        open.pop();
        out += ch;
      }
    } else {
      out += ch;
    }
  }
  for (let last = open.pop(); last !== undefined; last = open.pop()) out += closer[last] ?? '';
  return out;
}

/**
 * Tells whether a text has as many closing as opening brackets of each kind (`[]`, `()`, `{}`).
 *
 * Why: the soft flag `brackets_repaired` (plan section 3.2) marks a name whose brackets the rules had to pair.
 *
 * @param text the supplier's name
 * @returns true when every kind is balanced by count
 */
export function bracketsBalanced(text: string): boolean {
  const count = (ch: string) => text.split(ch).length - 1;
  return count('[') === count(']') && count('(') === count(')') && count('{') === count('}');
}

/**
 * Tells whether a name is a router unlock code list (`Unlock code by imei (#5) Router - 4Good Light A103, ...`).
 *
 * Why: A3 hazard 9: the model list is the product, so such a title is never cut and names no carrier or country.
 *
 * @param name the supplier's name or the title
 * @returns true for a router code list
 */
export function isRouterCodeList(name: string): boolean {
  return ROUTER_CODE_LIST.test(name);
}

/**
 * The supplier group (the category name) as the detection reads it: entities decoded; invisible characters, emoji, decoration and
 * Arabic script removed; spaces collapsed.
 *
 * Why: plan section 3.5: the module decodes entities itself, and a category made by Quick add from now on carries the cleaned
 * group text (`cleanGroupName`) where an older one carries it verbatim; reading both the same way gives a service the same brand,
 * carrier and country whichever the category holds.
 *
 * @param group the category name
 * @returns the text the brand, carrier and country rules read
 */
export function groupText(group: string): string {
  return squeeze(
    decodeEntities(group)
      .replace(/\u00A0/g, ' ')
      .replace(INVISIBLE, '')
      .replace(EMOJI, '')
      .replace(DECORATION, ' ')
      .replace(ARABIC_LETTERS, ' '),
  );
}

/**
 * Removes the matches of a marketing pattern, except a match right after `not` or `no` (R7: `NOT FAST` says what the buyer
 * gets). `only` is protected by the patterns themselves (a trailing `Instant` is removed only after a separator, so
 * `Only Instant` stays): in the real names an `Only` closes the phrase before it (`by SN Only Auto Api Instant 100%`, #489;
 * `Clean IMEI Only Direct Source`, #1097), and the marketing after it goes.
 */
function dropMarketing(text: string, pattern: RegExp): string {
  return text.replace(pattern, (match: string, ...rest: unknown[]) => {
    const offset = rest[rest.length - 2] as number;
    const before = text.slice(0, offset) + match.slice(0, match.length - match.trimStart().length);
    return /\b(?:not|no)\s+$/i.test(before) ? match : ' ';
  });
}

const MARKETING: readonly RegExp[] = [
  // 100% Success, (90% Success ratio), 90% ratio
  /\(?\b\d{1,3}\s?%(?:\s*(?:successfully|successful|success|unlock|active))?(?:\s+(?:rate|ratio))?\)?/gi,
  /\[?\s*\b(?:very\s+instant|ultra[- ]fast)\b[^\]/)]*\]?/gi,
  /\[?\s*\bfast\s*&\s*reliable\s+service\b\s*\]?/gi,
  /[[(]?\s*\b(?:fast|express|fully\s+automated|instant)\s+(?:services?|auto\s*api|script)\b\s*[\])]?/gi,
  /\[?\s*(?:24\/7\s*)?(?:instant\s+)?auto\s*api(?:\s*\/\s*(?:fast|instant))?(?:\s+instant)?(?:\s+script)?\s*\]?/gi,
  /\b24\/7\b/gi,
  /\bapi\s*\/\s*(?:fast|instant)\b/gi,
  /\/?\s*\(?\bdirect\s+source\b\)?/gi,
  /\(\s*official\s*(?:reseller|distributors?|service)\s*\)|\[\s*official\s*(?:reseller|distributors?)\s*\]|\bofficial\s+(?:reseller|distributors?)\b/gi,
  /\bread\s+service\s+description\b/gi,
  /\binstant\s+to\s+\d+\s+hours\b/gi,
  /(?:[-/([]\s*)(?:fast|instant)(?=\s*[)\]]|\s*$)/gi,
];

/** What a removal leaves behind: empty brackets, a dangling separator before a closer, a trailing separator. */
function tidyRemoval(text: string): string {
  return text
    .replace(EMPTY_BRACKETS, ' ')
    .replace(/\s[/-]\s*(?=[/\])-])/g, ' ')
    .replace(/\s*[/\-,]+\s*$/, '');
}

/**
 * The tail of R7: a trailing `All Models Supported` becomes `All Models` (`NOT SUPPORTED` stays), and the separators it leaves.
 * It runs inside R7 and once more after the cut, because a cut can expose such a tail (names #1004 and #1005).
 *
 * @param text the title
 * @returns the title without the tail
 */
export function marketingTail(text: string): string {
  return tidyRemoval(text.replace(/\b(all\s+models?)\s+supported\s*$/i, '$1'));
}

/**
 * A name is SHOUTING when, outside brackets, it has two or more words of three or more letters and 80 % or more of its letters
 * are capitals; such a name is written in Title Case, keeping acronyms, protected words and words already in mixed case.
 *
 * Why: R10 of A3 section 3 (37 real names).
 *
 * @param text the title
 * @returns the title in Title Case, or unchanged when it is not shouting
 */
export function titleCaseIfShouting(text: string): string {
  const outside = text.replace(/\[[^\]]*\]|\([^)]*\)/g, ' ');
  const words = outside.split(/\s+/).filter((word) => /^[A-Za-z&-]{3,}$/.test(word));
  const letters = outside.replace(/[^A-Za-z]/g, '');
  if (words.length < 2 || letters.length < 8) return text;
  const upper = letters.replace(/[^A-Z]/g, '').length;
  if (upper / letters.length < 0.8) return text;
  let firstDone = false;
  return text
    .split(/(\s+)/)
    .map((word) => {
      if (word === '' || /^\s+$/.test(word)) return word;
      // Parts joined by `/`, `+`, `&` or `-` are cased one by one: MTK/SPD, FRP+MDM, AT&T, E-GSM.
      const out = word
        .split(/([/+&-])/)
        .map((part) => {
          if (!/[A-Za-z]/.test(part)) return part;
          const core = part.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '');
          if (core === '') return part;
          if (/[a-z]/.test(core) && /[A-Z]/.test(core)) return part; // mixed already (iPhone, SaskTel): deliberate
          if (/\d/.test(core) && core.length <= 4) return part; // A12, 11PRO
          if (PROTECTED_WORDS.has(core.toUpperCase()) && core === core.toUpperCase()) return part;
          const lower = part.toLowerCase();
          const bare = lower.replace(/[^a-z]/g, '');
          if (
            core.length <= 3 &&
            core === core.toUpperCase() &&
            !COMMON_SHORT_WORDS.has(bare) &&
            !SMALL_WORDS.has(bare)
          ) {
            return part; // DT, HD, SPD
          }
          if (firstDone && SMALL_WORDS.has(core.toLowerCase())) return lower;
          return lower.replace(/([a-z])/, (ch) => ch.toUpperCase());
        })
        .join('');
      firstDone = true;
      return out;
    })
    .join('');
}

/** One ordered title rule of A3 section 3. */
interface TitleRule {
  readonly id: string;
  readonly run: (text: string, kind: NamingKind) => string;
}

const RULES: readonly TitleRule[] = [
  // R1: invisible characters out; a no-break space becomes a space; the look-alike letters become Latin ones.
  {
    id: 'R1',
    run: (t) => applyAll(t.replace(/\u00A0/g, ' ').replace(INVISIBLE, ''), LOOKALIKE_LETTERS),
  },
  // R2: HTML entities decoded once.
  { id: 'R2', run: (t) => decodeEntities(t) },
  // R3: emoji and decoration out; arrows made plain.
  {
    id: 'R3',
    run: (t) =>
      t
        .replace(/\u21C4/g, '/')
        .replace(/\u2192|->/g, ' - ')
        .replace(EMOJI, '')
        .replace(DECORATION, ' '),
  },
  // R4: Arabic script runs out, with the slash, dash or empty brackets left around them.
  {
    id: 'R4',
    run: (t) =>
      ARABIC_SCRIPT.test(t)
        ? t
            .replace(ARABIC_RUN, ' ')
            .replace(EMPTY_BRACKETS, ' ')
            .replace(/\s[/-]\s*$/g, '')
        : t,
  },
  // R5: dashes unified, pipes become slashes, braces become parentheses, brackets re-spaced and balanced, stray separators out.
  {
    id: 'R5',
    run: (t) => {
      let s = t
        .replace(/[\u2013\u2014\u2212]/g, '-')
        .replace(/\u00B7/g, ' ')
        .replace(/[{]+/g, '(')
        .replace(/[}]+/g, ')');
      s = s.replace(/(\d)\|(?=\d)/g, '$1/').replace(/\s\|(?=\d)/g, ' '); // "|6|7|8" gives "6/7/8"
      s = s.replace(/\s*\|\s*/g, ' / ');
      s = s.replace(/(?<=[A-Za-z0-9])_+(?=[A-Za-z0-9])/g, ' '); // "IMEI_issue" gives "IMEI issue"
      s = s.replace(/([([])\s+/g, '$1').replace(/\s+([)\]])/g, '$1');
      s = s
        .replace(/\s+-\s+/g, ' - ')
        .replace(/\s*,\s*(?=[A-Za-z([])/g, ', ')
        .replace(/\s+,(?=\d)/g, ',')
        .replace(/(\S)\s*\/\s*(\S)/g, (m: string, a: string, b: string) => (/\s\/|\/\s/.test(m) ? `${a} / ${b}` : m));
      s = s
        .replace(/,\s*,/g, ',')
        .replace(/\(\)|\[\]/g, ' ')
        .replace(/[.]{2,}$/, '')
        .replace(/\s*[/|\-,:;]+\s*$/, '')
        .replace(/^\s*[/|\-,:;]+\s*/, '');
      return squeeze(balanceBrackets(s));
    },
  },
  // R6: the typo list and the duration plurals.
  { id: 'R6', run: (t) => applyAll(t, TYPO_FIXES) },
  // R7: supplier marketing out (never right after not or no), and the tail `All Models Supported`. Decision (a) of the B2
  // review: the plan says never after not, no, only; `only` is left out because it made #489, #490 and #1097 worse; confirmed by
  // the review.
  {
    id: 'R7',
    run: (t) => {
      let s = t;
      for (const pattern of MARKETING) s = dropMarketing(s, pattern);
      return marketingTail(s);
    },
  },
  // R8: delivery times out; on a server service hours and days are the licence and stay.
  {
    id: 'R8',
    run: (t, kind) => {
      let s = t.replace(
        /[[(/]?\s*(?:\d+\s*(?:-|:|to)\s*\d+\s*(?:hours?|hrs?|h|days?|mins?|minutes?)\b)(?:\s*\/?\s*max\s*\d+\s*h(?:ours?)?)?\s*[\])]?/gi,
        ' ',
      );
      s = s.replace(/[[(]\s*(?:few|1)\s*hours?\s*[\])]/gi, ' ');
      if (kind === 'imei') {
        s = s
          .replace(/[[(]\s*\d+\s*(?:hours?|hrs?|days?)\s*[\])]/gi, ' ')
          .replace(/\b\d+\s*(?:hrs?|hours?)\s*$/gi, ' ');
      }
      return tidyRemoval(s);
    },
  },
  // R9: face values as `$10`; the hint `Any Qnt` out (the service has its own quantity rule, feature 25).
  {
    id: 'R9',
    run: (t) =>
      t.replace(/\b(\d+(?:\.\d+)?)\s*\$/g, '$$$1').replace(/\s*[[(]?\bany\s*(?:qnt|quantity|qty)\b[\])]?/gi, ' '),
  },
  // R10: SHOUTING to Title Case.
  { id: 'R10', run: (t) => titleCaseIfShouting(t) },
  // R11: brand and model casing.
  { id: 'R11', run: (t) => applyAll(t, CASING_FIXES) },
  // R12: tidy: brackets re-spaced, a space after `)`, ` -x` becomes ` - x`, repeated words, trailing separators, brackets paired.
  {
    id: 'R12',
    run: (t) => {
      let s = t
        .replace(/([([])\s+/g, '$1')
        .replace(/\s+([)\]])/g, '$1')
        .replace(/\(\)|\[\]/g, ' ');
      s = s
        .replace(/([)\]])(?=[A-Za-z0-9])/g, '$1 ')
        .replace(/\s-(?=[A-Za-z0-9])/g, ' - ')
        .replace(/(?<=[A-Za-z0-9)])-\s/g, ' - ')
        .replace(/\bby\s+-\s+/gi, (m) => `${m.slice(0, 2)} `);
      // "Global Unlocker Pro Global Unlocker Pro": words only, never model numbers.
      s = s.replace(/\b([A-Za-z]{3,}(?:[- ][A-Za-z]{3,})*)\s+\1\b/gi, '$1');
      s = s
        .replace(/\s*[/|\-,:;+>]+\s*$/, '')
        .replace(/^\s*[/|\-,:;+>]+\s*/, '')
        .replace(/\s+,/g, ',');
      return squeeze(balanceBrackets(s));
    },
  },
];

/** The rule ids a relaxed cleaning skips (the uniqueness ladder of plan section 3.5): marketing and delivery times. */
const RELAXED_SKIP: ReadonlySet<string> = new Set(['R7', 'R8']);

/**
 * The family of rules that names a service type.
 *
 * Why: plan section 3.5: `imei` is named by the IMEI rules; `server`, `remote` and `file` by the server rules (a remote service is
 * a tool session; a `file` service is blocked anyway).
 *
 * @param type the catalog service type
 * @returns `imei` or `server`
 */
export function namingKind(type: PublishServiceType): NamingKind {
  return type === 'imei' ? 'imei' : 'server';
}

/** Options of {@link cleanTitle}. */
export interface CleanOptions {
  /** True for the uniqueness ladder: marketing words and delivery times are kept (flag `marketing_kept`). */
  readonly keepMarketing?: boolean;
}

/**
 * Cleans a supplier's service name into a shop title with the rules R1-R12 and the final trim R14; the cut (R13) is
 * {@link cutTitle}, applied by the batch where it is safe.
 *
 * Why: plan section 3.5, A3 section 3: a shop title without emoji, entities, Arabic script, pipes, marketing or shouting; the
 * words that say what the buyer gets stay (`Clean`, `Premium`, `High Success`, `NOT FMI OFF`, `NO REFUND`, `NOT SUPPORTED`).
 *
 * @param name the supplier's service name
 * @param type the catalog service type
 * @param options `keepMarketing` for the uniqueness ladder
 * @returns the title; `''` when no Latin word is left (an Arabic-only name: a person writes the title)
 */
export function cleanTitle(name: string, type: PublishServiceType, options: CleanOptions = {}): string {
  const kind = namingKind(type);
  let title = name;
  for (const rule of RULES) {
    if (options.keepMarketing === true && RELAXED_SKIP.has(rule.id)) continue;
    title = squeeze(rule.run(title, kind));
  }
  // R14: the final trim; nothing Latin left gives an empty title.
  title = title.replace(/\s*[/|\-,:;+>([]+$/, '').replace(/^[/|\-,:;+>)\]\s]+/, '');
  return /[A-Za-z]{2,}/.test(title) ? title : '';
}

/**
 * Cuts a long title (R13): over {@link TITLE_CUT_LENGTH} characters, trailing bracket groups and ` - ` or ` / ` clauses are dropped
 * one at a time from the end while at least {@link TITLE_CUT_MIN_LENGTH} characters remain, never inside a clause; a router code
 * list is never cut, and the cut stops at a clause that states a restriction or a refusal (a whole word `not`, `no`, `non`,
 * `only`, `without`, `except` or `wrong`: that clause and everything before it stay, even over 80 characters). A `Model` left
 * dangling by the cut goes. The tail rule of R7 runs once more after a cut, so cleaning a cut title again changes nothing.
 *
 * Why: A3 section 3, R13 and hazard 1: the end of a long name is often what tells variants apart, so the batch applies this only
 * where it makes no title equal to another (`nameAll`).
 *
 * @param title a title from {@link cleanTitle}
 * @returns the cut title, or the title unchanged when it fits, is a router list, or has no clause to drop
 */
export function cutTitle(title: string): string {
  if (title.length <= TITLE_CUT_LENGTH || isRouterCodeList(title)) return title;
  let s = title;
  for (;;) {
    const clause = /\s*(?:\[[^[\]]*\]|\([^()]*\)|\s-\s(?:(?!\s-\s)[^[\]()])*|\s\/\s[^[\]()/]*)\s*$/.exec(s);
    if (clause === null || s.length - clause[0].length < TITLE_CUT_MIN_LENGTH) break;
    if (RESTRICTION.test(clause[0])) break;
    s = s
      .slice(0, s.length - clause[0].length)
      .replace(/\s*[/|\-,:;+([]+$/, '')
      .replace(DANGLING_MODEL, '');
    if (s.length <= TITLE_CUT_LENGTH) break;
  }
  const cut = squeeze(s);
  return cut === title ? title : squeeze(marketingTail(cut));
}
