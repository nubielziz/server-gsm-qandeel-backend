// The supported form of the regular expressions staff attach to order fields, and the one checker that decides it (decision 051): used when
// staff save a pattern and when a value is checked against it. Pure; it needs no engine other than the runtime's own.

/** The longest pattern accepted: the contract's cap on a field's `regex`. */
export const FIELD_PATTERN_MAX_LENGTH = 500;
/** The longest value a pattern runs on: the cap of an order input. */
export const FIELD_VALUE_MAX_LENGTH = 500;
/** The largest count in `{n}`, `{n,}` and `{n,m}`. */
export const FIELD_PATTERN_MAX_COUNT = 500;
/**
 * The most work a pattern may be judged to need on a value of {@link FIELD_VALUE_MAX_LENGTH} characters, in the units of
 * {@link fieldPatternProblem}: per top-level alternative, the product of its repeat choices times (10 + its fixed length, the least
 * characters its pieces consume, a character of a bracket class counting 4), times 501 when it does not start with `^`, summed.
 *
 * Why: decision 051: measured with Bun 1.4.4 on the development machine (2026-11-22) on values of 500 characters, Latin-1 ones and
 * ones with characters above U+00FF, the slowest accepted pattern found took about 18 ms (at most 18.8 ms over repeated runs, for a lazy
 * repeat of a class escape before a literal it cannot match, `^\S{0,13}\S{0,13}\S{0,13}\S{0,13}\S+? $`), under the 20 ms allowed for one
 * check; at 30,000,000 such patterns took about 25 ms. The common mail form `^[^@\s]+@[^@\s]+\.[a-z]{2,10}$` (9,126,000) is accepted.
 */
export const FIELD_PATTERN_MAX_WORK = 20_000_000;

/** Why a pattern is outside the supported form. */
export type FieldPatternReason = 'invalid' | 'unsupported' | 'nested' | 'anchors' | 'counts' | 'too_complex';

/** The sentence staff see for each {@link FieldPatternReason} (on `fields.N.regex`). */
export const FIELD_PATTERN_MESSAGES: Readonly<Record<FieldPatternReason, string>> = {
  invalid: 'Enter a valid regular expression.',
  unsupported:
    'Use only letters, digits, character classes, groups and counts: look-arounds, back-references, named groups, \\b, \\p and flags are not supported here.',
  nested: 'A group cannot repeat and cannot hold another group: write the repeat inside the group.',
  anchors: 'Use ^ only at the start and $ only at the end of the pattern or of an alternative.',
  counts: 'Use counts from 0 to 500 in {n}, {n,} and {n,m}.',
  too_complex:
    'This pattern could take too long to check: use fewer open repeats such as +, * and {n,}, or start it with ^.',
};

/** What is wrong with a pattern. */
export interface FieldPatternProblem {
  readonly reason: FieldPatternReason;
  readonly message: string;
}

// Characters that may follow a backslash and stand for themselves.
const SYNTAX = new Set('^$\\.*+?()[]{}|/-');
const CLASS_ESCAPES = new Set('dDwWsS');
const CONTROL_ESCAPES: Readonly<Record<string, number>> = { t: 9, n: 10, r: 13, f: 12, v: 11 };
const HEX = /^[0-9a-fA-F]$/;

/** A class escape of the supported form: `\d \D \w \W \s \S`. */
export type FieldPatternClassEscape = 'd' | 'D' | 'w' | 'W' | 's' | 'S';

/**
 * What one piece of a field pattern matches, as the work bound reads it: one character (a UTF-16 code unit, as the patterns compile
 * without flags), `.`, a class escape, or a bracket class with its ranges (both ends included; a single character is a range of one) and
 * the class escapes it lists.
 *
 * Why: decision 051: the work bound gives a repeat one viable count when the literal after it is a character its atom can never match
 * ({@link atomCannotMatch}).
 */
export type FieldPatternAtom =
  | { readonly kind: 'literal'; readonly code: number }
  | { readonly kind: 'any' }
  | { readonly kind: 'escape'; readonly escape: FieldPatternClassEscape }
  | {
      readonly kind: 'class';
      readonly negated: boolean;
      readonly ranges: ReadonlyArray<readonly [from: number, to: number]>;
      readonly escapes: readonly FieldPatternClassEscape[];
    };

// The engine's own reading of each class escape, without flags like the patterns: which characters \s holds follows the runtime's Unicode
// tables, so it is asked rather than listed here.
const ESCAPE_TESTS: Readonly<Record<FieldPatternClassEscape, RegExp>> = {
  d: /^\d$/,
  D: /^\D$/,
  w: /^\w$/,
  W: /^\W$/,
  s: /^\s$/,
  S: /^\S$/,
};

function escapeMatches(escape: FieldPatternClassEscape, code: number): boolean {
  return ESCAPE_TESTS[escape].test(String.fromCharCode(code));
}

/**
 * Tells whether a piece's atom can never match one character, proved from the atom alone.
 *
 * Why: decision 051: a repeat followed by a literal its atom can never match cannot give that literal a character back, so the engine
 * tries one of its counts only and the work bound may count it so. A wrong `true` would let a slow pattern through, so the answer is
 * `true` only when it is certain: a different literal; a class escape that leaves the character out; a positive class none of whose ranges
 * and escapes holds it; a negated class one of whose ranges or escapes holds it. `.` is taken to match every character.
 *
 * @param atom the atom of a repeat
 * @param code the UTF-16 code unit of the literal that follows it
 * @returns `true` when the atom matches no string of that one character; `false` when it can, and for `.`
 */
export function atomCannotMatch(atom: FieldPatternAtom, code: number): boolean {
  switch (atom.kind) {
    case 'literal':
      return atom.code !== code;
    case 'any':
      return false;
    case 'escape':
      return !escapeMatches(atom.escape, code);
    case 'class': {
      const listed =
        atom.ranges.some(([from, to]) => from <= code && code <= to) ||
        atom.escapes.some((escape) => escapeMatches(escape, code));
      return atom.negated ? listed : !listed;
    }
  }
}

// What escapeAt and the class reader answer for one item: a single character or a class escape, and the index after it.
type Item =
  | { readonly kind: 'single'; readonly code: number; readonly next: number }
  | { readonly kind: 'set'; readonly escape: FieldPatternClassEscape; readonly next: number };

// The least characters and the paths of one sequence (a top-level alternative or an alternative inside a group).
type Sequence = { product: number; fixed: number; pieces: number };

// What one path of the engine's search costs beside the characters it scans, in characters: measured with Bun 1.4.4, a path of open
// repeats costs about ten times one character of a fixed piece (decision 051).
const PATH_WEIGHT = 10;
// What one character of a bracket class counts in the fixed length: on a value that holds a character above U+00FF (stored with 16-bit
// characters), a class costs about four times a literal, `.` or a class escape per character scanned (decision 051).
const CLASS_WEIGHT = 4;

/**
 * Tells whether a pattern is in the supported form, and why not when it is not.
 *
 * Why: decision 051: a pattern typed by staff runs on every order input on the request path (the portal, the REST API, the Dhru API and the
 * anonymous checkout), and the engine's backtracking can take seconds on a pattern with nested repeats. The supported form cannot do that:
 * literals, `.`; character classes; the escapes `\d \D \w \W \s \S \t \n \r \f \v \xHH \uHHHH` and escaped syntax characters; groups `( )`
 * and `(?: )` with alternatives, never nested and never repeated; the quantifiers `? * + {n} {n,} {n,m}` with counts up to 500, lazy or not;
 * `^` only at the start and `$` only at the end of the pattern or of a top-level alternative. Look-arounds, back-references, named groups,
 * `\b`, `\B`, `\p`, `\c`, `\0` and every other escape are refused. Because a value has at most 500 characters, `*` is a bounded
 * repeat.
 *
 * The work bound counts, per top-level alternative, the paths the engine can try times what each path costs. The paths are the product
 * of the repeat choices (2 for `?`, 501 for `*`, 500 for `+`, 1 for `{n}`, 501 - n for `{n,}`, m - n + 1 for `{n,m}`; a group
 * counts the sum of its alternatives' products). A path costs 10 for the path itself plus the fixed length: the least characters the
 * pieces consume, which the engine scans again on every path. A piece without a quantifier counts 1, `?` and `*` count 0, `+` counts
 * 1, and `{n}`, `{n,}` and `{n,m}` count n; a piece whose atom is a bracket class `[...]` counts 4 times that, because on a value that
 * holds a character above U+00FF one character of a class costs about four times a literal, `.` or a class escape; a group counts the sum
 * of its alternatives', since a failing alternative scans too. A repeat directly followed, in the same sequence, by a literal piece of at
 * least one character that the repeat's atom can never match ({@link atomCannotMatch}; as in `[^@\s]+@`) has one viable count: its
 * choices leave the product and its choices times its weight (4 for a class, else 1) are added to the fixed length; the rule ends at `|`,
 * `(` and `)`. An alternative that does not start with `^` counts 501 times (once per start); the alternatives are added and more than
 * {@link FIELD_PATTERN_MAX_WORK} is refused. The pattern is read once, left to right, and the first problem found is the answer; the work
 * bound is judged after the whole pattern was read and the compile check comes last (the use compiles without flags, so does this).
 *
 * @param pattern the pattern text; `''` means "no pattern" and is fine
 * @returns `undefined` when the pattern is in the supported form, else the reason and the sentence for staff
 */
export function fieldPatternProblem(pattern: string): FieldPatternProblem | undefined {
  const reason = reasonOf(pattern);
  return reason === undefined ? undefined : { reason, message: FIELD_PATTERN_MESSAGES[reason] };
}

function reasonOf(p: string): FieldPatternReason | undefined {
  if (p === '') return undefined;
  if (p.length > FIELD_PATTERN_MAX_LENGTH) return 'invalid';
  const len = p.length;
  // Per sequence: `product` multiplies the repeat choices (the paths the engine can try) and `fixed` adds the least characters each
  // piece consumes times its weight (what the engine scans again on every path; a group adds all its alternatives, since a failing one
  // scans too).
  const top: Array<{ anchored: boolean; product: number; fixed: number }> = [];
  let alt: Sequence & { anchored: boolean } = { anchored: false, product: 1, fixed: 0, pieces: 0 }; // the current top-level alternative
  let inGroup = false;
  let group = { product: 0, fixed: 0 }; // the finished alternatives of the current group: their products and fixed lengths, summed
  let groupAlt: Sequence = { product: 1, fixed: 0, pieces: 0 }; // the current alternative inside a group
  // The piece just read in the current sequence, and the product of the sequence before it; `null` after `|`, `(` and `)`.
  let prev: { atom: FieldPatternAtom; choices: number; weight: number; productBefore: number } | null = null;
  let i = 0;
  if (p[i] === '^') {
    alt.anchored = true;
    i += 1;
  }

  const escapeAt = (j: number): Item | FieldPatternReason => {
    const d = p[j + 1];
    if (d === undefined) return 'invalid';
    if (CLASS_ESCAPES.has(d)) return { kind: 'set', escape: d as FieldPatternClassEscape, next: j + 2 };
    if (Object.hasOwn(CONTROL_ESCAPES, d)) return { kind: 'single', code: CONTROL_ESCAPES[d]!, next: j + 2 };
    if (d === 'x' || d === 'u') {
      const size = d === 'x' ? 2 : 4;
      const hex = p.slice(j + 2, j + 2 + size);
      if (hex.length !== size || ![...hex].every((c) => HEX.test(c))) return 'invalid';
      return { kind: 'single', code: Number.parseInt(hex, 16), next: j + 2 + size };
    }
    if (SYNTAX.has(d)) return { kind: 'single', code: d.charCodeAt(0), next: j + 2 };
    return 'unsupported'; // \b \B \1-\9 \0 \k \p \P \c and every other escape
  };
  const classItem = (j: number): Item | FieldPatternReason =>
    p[j] === '\\' ? escapeAt(j) : { kind: 'single', code: p.charCodeAt(j), next: j + 1 };
  // p[start] is '['; answers the class and the index after the closing ']'
  const classAt = (start: number): { atom: FieldPatternAtom; next: number } | FieldPatternReason => {
    let j = start + 1;
    const negated = p[j] === '^';
    if (negated) j += 1;
    const ranges: Array<readonly [number, number]> = [];
    const escapes: FieldPatternClassEscape[] = [];
    for (;;) {
      if (j >= len) return 'invalid';
      if (p[j] === ']') {
        if (ranges.length + escapes.length === 0) return 'invalid'; // [] and [^] are refused
        return { atom: { kind: 'class', negated, ranges, escapes }, next: j + 1 };
      }
      const first = classItem(j);
      if (typeof first === 'string') return first;
      j = first.next;
      if (p[j] === '-' && j + 1 < len && p[j + 1] !== ']') {
        // a range
        if (first.kind === 'set') return 'unsupported'; // [\d-z]
        const last = classItem(j + 1);
        if (typeof last === 'string') return last;
        if (last.kind === 'set') return 'unsupported';
        if (first.code > last.code) return 'invalid'; // range out of order
        ranges.push([first.code, last.code]);
        j = last.next;
      } else if (first.kind === 'set') escapes.push(first.escape);
      else ranges.push([first.code, first.code]);
    }
  };
  // `choices`: how many counts the piece can take on a value of at most 500 characters; `least`: the fewest characters it consumes.
  const quantifier = (start: number): { choices: number; least: number; next: number } | FieldPatternReason => {
    let j = start;
    let choices: number;
    let least: number;
    if (p[j] === '?') {
      choices = 2;
      least = 0;
      j += 1;
    } else if (p[j] === '*') {
      choices = FIELD_VALUE_MAX_LENGTH + 1;
      least = 0;
      j += 1;
    } else if (p[j] === '+') {
      choices = FIELD_VALUE_MAX_LENGTH;
      least = 1;
      j += 1;
    } else if (p[j] === '{') {
      const m = /^\{(\d+)(,(\d*))?\}/.exec(p.slice(j));
      if (m === null) return 'invalid'; // a '{' that is not a count must be escaped
      const n = Number(m[1]);
      if (n > FIELD_PATTERN_MAX_COUNT) return 'counts';
      least = n;
      if (m[2] === undefined) choices = 1;
      else if (m[3] === '') choices = Math.max(1, FIELD_VALUE_MAX_LENGTH + 1 - n);
      else {
        const upper = Number(m[3]);
        if (upper > FIELD_PATTERN_MAX_COUNT) return 'counts';
        if (upper < n) return 'invalid';
        choices = upper - n + 1;
      }
      j += m[0].length;
    } else return { choices: 1, least: 1, next: j };
    if (p[j] === '?') j += 1; // lazy
    return { choices, least, next: j };
  };

  while (i < len) {
    const c = p[i]!;
    if (c === '^') return 'anchors';
    if (c === '$') {
      if (inGroup || !(i === len - 1 || p[i + 1] === '|')) return 'anchors';
      i += 1;
      continue;
    }
    if (c === '|') {
      prev = null;
      if (inGroup) {
        if (groupAlt.pieces === 0) return 'invalid';
        group.product += groupAlt.product;
        group.fixed += groupAlt.fixed;
        groupAlt = { product: 1, fixed: 0, pieces: 0 };
        i += 1;
        continue;
      }
      if (alt.pieces === 0) return 'invalid';
      top.push(alt);
      alt = { anchored: false, product: 1, fixed: 0, pieces: 0 };
      i += 1;
      if (p[i] === '^') {
        alt.anchored = true;
        i += 1;
      }
      continue;
    }
    if (c === '(') {
      if (inGroup) return 'nested';
      if (p.startsWith('(?:', i)) i += 3;
      else if (p[i + 1] === '?')
        return 'unsupported'; // (?= (?! (?<= (?<! (?<name> and the rest
      else i += 1;
      inGroup = true;
      prev = null;
      group = { product: 0, fixed: 0 };
      groupAlt = { product: 1, fixed: 0, pieces: 0 };
      continue;
    }
    if (c === ')') {
      if (!inGroup || groupAlt.pieces === 0) return 'invalid';
      group.product += groupAlt.product;
      group.fixed += groupAlt.fixed;
      inGroup = false;
      prev = null;
      i += 1;
      if (i < len && '?*+{'.includes(p[i]!)) return 'nested'; // a group never repeats
      alt.product *= group.product;
      alt.fixed += group.fixed;
      alt.pieces += 1;
      continue;
    }
    if ('*+?{}]'.includes(c)) return 'invalid'; // nothing to repeat, or a bracket that must be escaped
    let atom: FieldPatternAtom;
    let next: number;
    let weight = 1;
    if (c === '[') {
      const parsed = classAt(i);
      if (typeof parsed === 'string') return parsed;
      ({ atom, next } = parsed);
      weight = CLASS_WEIGHT;
    } else if (c === '\\') {
      const item = escapeAt(i);
      if (typeof item === 'string') return item;
      atom = item.kind === 'single' ? { kind: 'literal', code: item.code } : { kind: 'escape', escape: item.escape };
      next = item.next;
    } else {
      atom = c === '.' ? { kind: 'any' } : { kind: 'literal', code: p.charCodeAt(i) };
      next = i + 1;
    }
    const q = quantifier(next);
    if (typeof q === 'string') return q;
    i = q.next;
    const sequence = inGroup ? groupAlt : alt;
    if (
      prev !== null &&
      prev.choices > 1 &&
      atom.kind === 'literal' &&
      q.least >= 1 &&
      atomCannotMatch(prev.atom, atom.code)
    ) {
      // The repeat just before cannot hand this literal a character, so only one of its counts leads on: its choices leave the product
      // (restored to what it was before the repeat) and each count it gives back is scanned once per path.
      sequence.product = prev.productBefore;
      sequence.fixed += prev.choices * prev.weight;
    }
    prev = { atom, choices: q.choices, weight, productBefore: sequence.product };
    sequence.product *= q.choices;
    sequence.fixed += q.least * weight;
    sequence.pieces += 1;
  }
  if (inGroup || alt.pieces === 0) return 'invalid';
  top.push(alt);
  const work = top.reduce(
    (sum, a) => sum + (a.anchored ? 1 : FIELD_VALUE_MAX_LENGTH + 1) * a.product * (PATH_WEIGHT + a.fixed),
    0,
  );
  if (work > FIELD_PATTERN_MAX_WORK) return 'too_complex';
  try {
    new RegExp(p); // no flags: the use compiles it the same way
  } catch {
    return 'invalid';
  }
  return undefined;
}

const COMPILED_MAX = 500;
const compiled = new Map<string, RegExp | null>();

/**
 * The regular expression of a pattern that is in the supported form.
 *
 * Why: decision 051: the order check runs a pattern only when it is in the supported form; a pattern outside it (or empty, or one that does
 * not compile) is not run, so the field has no pattern. Answers are kept in a small memo (a pattern is checked once, not on every value); a
 * regular expression without flags keeps no state in `test`, so sharing it is safe.
 *
 * @param pattern the stored pattern text
 * @returns `null` for `''` and for every pattern {@link fieldPatternProblem} refuses, else `new RegExp(pattern)` (no flags)
 */
export function compileFieldPattern(pattern: string): RegExp | null {
  const known = compiled.get(pattern);
  if (known !== undefined) return known;
  const result = pattern === '' || fieldPatternProblem(pattern) !== undefined ? null : new RegExp(pattern);
  if (compiled.size >= COMPILED_MAX) compiled.clear();
  compiled.set(pattern, result);
  return result;
}
