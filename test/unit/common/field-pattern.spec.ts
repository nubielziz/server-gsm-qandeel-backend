// Unit tests of the supported form of order-field patterns, the reasons it refuses with, and the time bound of what it accepts (decision 051).
import { describe, expect, it } from 'bun:test';
import {
  FIELD_PATTERN_MESSAGES,
  type FieldPatternAtom,
  type FieldPatternClassEscape,
  type FieldPatternReason,
  atomCannotMatch,
  compileFieldPattern,
  fieldPatternProblem,
} from '@src/common/field-pattern';

/** A class of single characters, as staff type them for a list of letters: 120 of them, U+0100 to U+01EE, every second one. */
const SINGLES_120 = Array.from({ length: 120 }, (_, i) => String.fromCharCode(0x100 + 2 * i)).join('');
/** The last character of {@link SINGLES_120}, the one the engine compares last. */
const LAST_OF_SINGLES = '\u01ee';

/** Patterns of the supported form (the Arabic range is written with escapes in this file; the pattern holds the characters themselves). */
const ACCEPTED = [
  '',
  '^[0-9]{15}$',
  '^\\d{15}$',
  '^.{1,500}$',
  '^[A-Za-z0-9._-]+$',
  '^[A-Z]{2}\\d{6,10}[A-Z]?$',
  '^\\S+@\\S+$',
  '^\\d{15}$|^\\d{17}$',
  '^(SN|IMEI)\\d+$',
  '^(?:[A-F0-9]{8})$',
  '\\d+$',
  '[0-9]{15}',
  '^\\+?\\d{7,15}$',
  '^[\u0600-\u06ff ]{2,40}$',
  '^\\x41{3}$',
  '^a-b$',
  '^[a-]$',
  '^[-a]$',
  '[\\w-]+',
  '^[\\w.+-]+$',
  '[\\]]',
  'a\\/b',
  'a{0}',
  'a{3}?',
  '^\\d{0,30}\\d{0,30}\\d{0,30}\\d{0,30}$',
  // The common mail form must be accepted (9,126,000: each [^@\\s]+ before a literal it cannot match has one viable count).
  '^[^@\\s]+@[^@\\s]+\\.[a-z]{2,10}$',
  `^${'(a|a)'.repeat(18)}$`,
];

/**
 * Accepted patterns found nearest the work bound (each family's largest one: one more count is refused), with fixed pieces, open
 * repeats, groups, bracket classes and repeats before a literal they cannot match: the slowest accepted patterns measured on the
 * development machine, on Latin-1 values and on values with characters above U+00FF.
 */
const NEAR_BOUND = [
  `^${'.{0,57}.{30}'.repeat(3)}$`,
  `^${'.{0,49}.{49}'.repeat(3)}$`,
  `^${'.{0,59}'.repeat(3)}[${SINGLES_120}]{20}$`,
  `^${'.{0,35}'.repeat(3)}[^@\\s]{0,100}?@$`,
  `^${'\\S{0,13}'.repeat(4)}\\S+? $`,
  `^${'.{0,55}'.repeat(3)}\\s{0,100}?x$`,
  `^${'\\w{0,19}'.repeat(4)}\\w{0,100}?@$`,
  `^${'[^@\\s]{0,36}'.repeat(4)}$`,
  `^${'\\d{0,47}\\d{55}'.repeat(3)}$`,
  `${'\\d{0,29}'.repeat(3)}x`,
  `^${'(.{0,40}|.{0,40}|.{0,40})'.repeat(3)}$`,
  `^${'(a{0,5}|a{0,5}|a{0,5})'.repeat(5)}$`,
];

const REFUSED: Record<FieldPatternReason, string[]> = {
  nested: [
    '^(a+)+$',
    '(a|aa)*',
    '(\\w+\\s?)+$',
    '^(([a-z])+.)+[A-Z]([a-z])+$',
    '(.*a){12}',
    '(a?){25}a{25}',
    '^(\\d{3}-){2}\\d{4}$',
    '((a))',
  ],
  unsupported: [
    '(a)\\1',
    '^(?=.*\\d).{8,}$',
    '(?<n>a)',
    '\\bword\\b',
    '\\p{L}+',
    'a\\qb',
    '[\\d-z]',
    '(?i)abc',
    '\\c',
    '\\0',
    '\\B',
  ],
  anchors: ['a^b', '^a$b', '(^a)', '(a$)', 'a$+'],
  counts: ['^\\d{0,600}$', '^\\d{501}$'],
  too_complex: [
    '^\\d+\\d+\\d+$',
    '\\d+\\d+$',
    '^\\S+@\\S+\\.\\S+$',
    '\\w*\\w*$',
    '^\\d*\\d*\\d*\\d*\\d*\\d*\\d*\\d*x$',
    '^\\d{0,60}\\d{0,60}\\d{0,60}\\d{0,60}$',
    `^${'(a|a)'.repeat(22)}$`,
    `^${'(a|a)'.repeat(23)}$`,
    `${'a?'.repeat(21)}${'a'.repeat(21)}`,
    // Fixed-length pieces are scanned again on every path: each of these took 90 to 215 ms on 496 characters and a bad ending.
    `^${'.{0,46}.{78}'.repeat(4)}$`,
    `^${'\\d{0,46}[0-9]{78}'.repeat(4)}$`,
    `^${'a{0,46}a{78}'.repeat(4)}$`,
    `^${'a{0,20}a{79}'.repeat(5)}$`,
    `^${'(?:.{22}|.{22})'.repeat(22)}$`,
    `^${'(?:a{22}|a{22})'.repeat(22)}$`,
    // A character of a bracket class costs about four times a literal on a value with a character above U+00FF: each of these took 21 to
    // 61 ms on such a value while a class character counted 1.
    `^.{0,117}.{0,117}.{0,117}[${SINGLES_120}]{20}$`,
    '^.{0,75}.{0,75}.{0,75}[\u0100\u0102\u0104\u0106\u0108\u010a\u010c\u010e\u0110\u0112]{100}$',
    '^.{0,93}.{0,93}.{0,93}[\u0621-\u064a\\s]{50}$',
    `^${'[^@\\s]{0,78}[^@\\s]{30}'.repeat(3)}$`,
    // Over the bound of 20,000,000 (28,257,610 and 25,165,824): a repeat of a class escape before a literal it cannot match took up to
    // 25 ms at 30,000,000.
    '^\\d{0,40}\\d{0,40}\\d{0,40}\\d{0,40}$',
    `^${'(a|a)'.repeat(19)}$`,
    // One more count than the largest of each NEAR_BOUND family.
    `^${'.{0,58}.{30}'.repeat(3)}$`,
    `^${'.{0,36}'.repeat(3)}[^@\\s]{0,100}?@$`,
    `^${'\\S{0,14}'.repeat(4)}\\S+? $`,
    `^${'(a{0,6}|a{0,6}|a{0,6})'.repeat(5)}$`,
  ],
  invalid: [
    '([0-9',
    '*a',
    'a**',
    'a{2}{3}',
    'a{,3}',
    'a}',
    'a]',
    '[z-a]',
    '[]',
    '[^]',
    '()',
    'a||b',
    '^$',
    'a{3,2}',
    '\\',
    '\\x4',
    '\\u{1F600}',
    '[[:alpha:]]',
    'x'.repeat(501),
  ],
};

describe('fieldPatternProblem', () => {
  it('accepts the supported form', () => {
    for (const pattern of ACCEPTED) expect(fieldPatternProblem(pattern), pattern).toBeUndefined();
  });

  it('refuses each construct outside the form with its reason', () => {
    for (const [reason, patterns] of Object.entries(REFUSED) as Array<[FieldPatternReason, string[]]>) {
      for (const pattern of patterns) {
        expect(fieldPatternProblem(pattern), pattern.slice(0, 40)).toEqual({
          reason,
          message: FIELD_PATTERN_MESSAGES[reason],
        });
      }
    }
  });

  it('accepts what the supplier import builds from lengths', () => {
    for (const pattern of ['^.{1,500}$', '^.{5,5}$', '^.{1,1}$']) expect(fieldPatternProblem(pattern)).toBeUndefined();
  });
});

/** The UTF-16 code unit of a one-character string. */
const unit = (character: string): number => character.charCodeAt(0);
const literal = (character: string): FieldPatternAtom => ({ kind: 'literal', code: unit(character) });
const escape = (name: FieldPatternClassEscape): FieldPatternAtom => ({ kind: 'escape', escape: name });
/** A bracket class: its ranges as two-character strings (`'az'` is a-z, `'@@'` the single @) and its escapes. */
const bracket = (negated: boolean, ranges: string[], escapes: FieldPatternClassEscape[] = []): FieldPatternAtom => ({
  kind: 'class',
  negated,
  ranges: ranges.map((range) => [unit(range[0]!), unit(range[1]!)] as const),
  escapes,
});

describe('atomCannotMatch', () => {
  // Each pair differs in one point only: the first can never match the character, the second can (or is not proved not to).
  const pairs: Array<[name: string, cannot: [FieldPatternAtom, string], can: [FieldPatternAtom, string]]> = [
    ['a different literal', [literal('a'), 'b'], [literal('a'), 'a']],
    ['a class escape that leaves it out', [escape('d'), 'a'], [escape('d'), '5']],
    ['\\D', [escape('D'), '0'], [escape('D'), 'a']],
    ['\\w', [escape('w'), '@'], [escape('w'), '_']],
    ['\\W', [escape('W'), 'a'], [escape('W'), '@']],
    ['\\s and a wide space', [escape('s'), 'x'], [escape('s'), '\u3000']],
    ['\\S', [escape('S'), ' '], [escape('S'), 'x']],
    ['a positive class whose range leaves it out', [bracket(false, ['az']), '@'], [bracket(false, ['az']), 'm']],
    ['the end of a range', [bracket(false, ['09', 'af']), 'g'], [bracket(false, ['09', 'ag']), 'g']],
    [
      'a positive class whose escape leaves it out',
      [bracket(false, ['..'], ['d']), 'a'],
      [bracket(false, ['..'], ['w']), 'a'],
    ],
    ['a negated class that lists it', [bracket(true, ['@@']), '@'], [bracket(true, ['aa']), '@']],
    ['a negated class whose escape covers it', [bracket(true, [], ['s']), ' '], [bracket(true, [], ['d']), ' ']],
    ['a negated class whose range covers it', [bracket(true, ['ac']), 'b'], [bracket(true, ['ac']), 'd']],
    [
      'a negated class of @ and \\s',
      [bracket(true, ['@@'], ['s']), '\u3000'],
      [bracket(true, ['@@'], ['s']), '\u0100'],
    ],
    [
      'a character above U+00FF',
      [bracket(false, ['\u0100\u0100']), '\u0101'],
      [bracket(false, ['\u0100\u0100']), '\u0100'],
    ],
  ];

  it('is true only where the atom can never match the character', () => {
    for (const [name, [cannotAtom, cannotCharacter], [canAtom, canCharacter]] of pairs) {
      expect(atomCannotMatch(cannotAtom, unit(cannotCharacter)), name).toBe(true);
      expect(atomCannotMatch(canAtom, unit(canCharacter)), name).toBe(false);
    }
  });

  it('never claims it for . , which is taken to match every character', () => {
    for (const character of ['@', 'a', '\n', '\u2028'])
      expect(atomCannotMatch({ kind: 'any' }, unit(character))).toBe(false);
  });

  it('agrees with the engine wherever it claims it', () => {
    const atoms: Array<[FieldPatternAtom, string]> = [
      [escape('d'), '\\d'],
      [escape('D'), '\\D'],
      [escape('w'), '\\w'],
      [escape('W'), '\\W'],
      [escape('s'), '\\s'],
      [escape('S'), '\\S'],
      [bracket(true, ['@@'], ['s']), '[^@\\s]'],
      [bracket(false, ['az', '09', '..', '--']), '[a-z0-9.-]'],
      [bracket(true, ['az'], ['d']), '[^a-z\\d]'],
    ];
    for (const [atom, text] of atoms) {
      const engine = new RegExp(`^${text}$`);
      for (let code = 0; code <= 0xffff; code += 1) {
        if (atomCannotMatch(atom, code))
          expect(engine.test(String.fromCharCode(code)), `${text} U+${code.toString(16)}`).toBe(false);
      }
    }
  });
});

describe('the work of a repeat followed by a literal it can never match', () => {
  // Each pair differs in one point only. The prefix makes 5,000 paths (of `.`, which no rule reduces); with the rule the repeat adds no
  // paths (accepted), without it it multiplies them by its 500 counts (refused).
  const prefix = '^.{0,99}.{0,49}';
  const pairs: Array<[name: string, accepted: string, refused: string]> = [
    ['a positive class and a literal outside it', `${prefix}[a-z]+@$`, `${prefix}[a-z]+a$`],
    ['a negated class that lists the literal', `${prefix}[^@]+@$`, `${prefix}[^a]+@$`],
    ['a class escape that leaves the literal out', `${prefix}\\d+a$`, `${prefix}\\w+a$`],
    ['. matches every character', `${prefix}\\d+@$`, `${prefix}.+@$`],
    ['a negated class whose escape covers the literal', `${prefix}[^\\s]+ $`, `${prefix}[^\\d]+ $`],
    ['a different literal', `${prefix}x+y$`, `${prefix}x+x$`],
    ['the piece after is a literal, not a class', `${prefix}[^@]+@$`, `${prefix}[^@]+[@]$`],
    ['the literal takes at least one character', `${prefix}[^@]+@$`, `${prefix}[^@]+@?$`],
    ['a lazy repeat too', `${prefix}[^@]+?@$`, `${prefix}[^@]+?@?$`],
    ['the rule ends at (', `${prefix}(?:[^@]+@)$`, `${prefix}[^@]+(?:@)$`],
    ['the rule ends at )', `${prefix}(?:[^@]+@)$`, `${prefix}(?:[^@]+)@$`],
    ['the rule ends at |', '^.{0,99}.{0,29}(?:[^@]+@|x)$', '^.{0,99}.{0,29}(?:[^@]+|@x)$'],
  ];

  it('gives the repeat one viable count only when the literal after it can never be matched by its atom', () => {
    for (const [name, accepted, refused] of pairs) {
      expect(fieldPatternProblem(accepted), name).toBeUndefined();
      expect(fieldPatternProblem(refused)?.reason, name).toBe('too_complex');
    }
  });
});

describe('compileFieldPattern', () => {
  it('never runs a refused pattern: null for each of them and for the empty pattern, the same object twice for an accepted one', () => {
    expect(compileFieldPattern('')).toBeNull();
    for (const patterns of Object.values(REFUSED))
      for (const pattern of patterns) expect(compileFieldPattern(pattern)).toBeNull();
    const first = compileFieldPattern('^[0-9]{15}$');
    expect(first).toBeInstanceOf(RegExp);
    expect(compileFieldPattern('^[0-9]{15}$')).toBe(first);
    expect(first?.test('123456789012345')).toBe(true);
    expect(first?.test('12345')).toBe(false);
  });

  // The slowest accepted pattern measured on the development machine took about 18 ms (at most 18.8 ms, a lazy repeat of \S before a
  // literal it cannot match, on a 16-bit value); the bound is twenty times that or more, so a loaded machine does not fail it.
  const BOUND_MS = 400;

  it('runs every accepted pattern over hard inputs of up to 500 characters, 16-bit values too, in a bounded time', () => {
    const patterns = [
      ...ACCEPTED.filter((pattern) => pattern !== ''),
      '.{0,500}x',
      '^\\w*\\w*$',
      '(\\w+|\\d+)x',
      '^.*.*$',
      `^${'a?'.repeat(19)}${'a'.repeat(19)}$`,
    ];
    // Latin-1 characters, and characters above U+00FF (a value that holds one is stored with 16-bit characters, where a bracket class
    // costs more per character): a Latin letter, an Arabic letter, a wide space and the last of a class of single characters.
    const characters = [
      '0',
      'a',
      'A',
      '.',
      '@',
      '-',
      '_',
      'x',
      '\u00e9',
      ' ',
      '\n',
      '\u0100',
      '\u0628',
      '\u3000',
      LAST_OF_SINGLES,
    ];
    const endings = ['', '!', ' ', '\n', '#', '@', '.'];
    let worst = 0;
    for (const pattern of patterns) {
      const compiled = compileFieldPattern(pattern);
      expect(compiled, pattern).not.toBeNull();
      for (const character of characters) {
        for (const length of [50, 250, 496, 500]) {
          for (const ending of endings) {
            const input = character.repeat(length) + ending;
            const started = performance.now();
            compiled!.test(input);
            const took = performance.now() - started;
            worst = Math.max(worst, took);
            expect(took, `${pattern.slice(0, 30)} on ${JSON.stringify(character)} x ${length}`).toBeLessThan(BOUND_MS);
          }
        }
      }
    }
    expect(worst).toBeLessThan(BOUND_MS);
  });

  it('runs the accepted patterns nearest the bound, fixed pieces included, on 496 characters and a bad ending in a bounded time, 16-bit values too', () => {
    const inputs = ['x', '0', 'a', ' ', '.', '_', '\u0100', '\u0628', '\u3000', LAST_OF_SINGLES].flatMap(
      (character) => [...['!', '\n', '#', '@'].map((ending) => character.repeat(496) + ending), character.repeat(500)],
    );
    for (const pattern of NEAR_BOUND) {
      const compiled = compileFieldPattern(pattern);
      expect(compiled, pattern).not.toBeNull();
      for (const input of inputs) {
        const started = performance.now();
        compiled!.test(input);
        const took = performance.now() - started;
        expect(took, `${pattern.slice(0, 30)} on ${JSON.stringify(input.slice(0, 2))} x ${input.length}`).toBeLessThan(
          BOUND_MS,
        );
      }
    }
  });
});
