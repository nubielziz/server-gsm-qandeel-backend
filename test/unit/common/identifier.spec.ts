// Unit tests of the identifier maker shared by the payment gateways and the alert rules (decision 077). Characters that are not Latin are
// written with escapes only (decision 039).
import { describe, expect, it } from 'bun:test';
import {
  MAX_IDENTIFIER_ATTEMPTS,
  firstFreeIdentifier,
  identifierAttempt,
  identifierFrom,
} from '@src/common/identifier';

const CODE = { maxLength: 40, fallback: 'method' } as const;
const KEY = { maxLength: 41, minLength: 3, startsWithLetter: true, fallback: 'rule' } as const;

describe('identifierFrom', () => {
  it('lower-cases and turns every run of other characters into one underscore, none at either end', () => {
    expect(identifierFrom('Bank of Jordan', CODE)).toBe('bank_of_jordan');
    expect(identifierFrom('  Vodafone -- Cash!!  ', CODE)).toBe('vodafone_cash');
    expect(identifierFrom('A/B  test_2 (new)', CODE)).toBe('a_b_test_2_new');
    expect(identifierFrom('__x__', CODE)).toBe('x');
  });

  it('drops accents and spells out the Latin letters that do not decompose', () => {
    expect(identifierFrom('Cr\u00e9dit Agricole Caf\u00e9', CODE)).toBe('credit_agricole_cafe');
    expect(identifierFrom('\u00dcber Bank \u00c5ngstr\u00f6m', CODE)).toBe('uber_bank_angstrom');
    expect(identifierFrom('Stra\u00dfe \u00e6 \u0153 \u00f8 \u0142 \u0111', CODE)).toBe('strasse_ae_oe_o_l_d');
    expect(identifierFrom('na\u00efve', CODE)).toBe('naive');
  });

  it('keeps the a-z and 0-9 of a mixed name and gives the fallback for a name in another script', () => {
    expect(identifierFrom('\u0628\u0646\u0643 Bank 2', CODE)).toBe('bank_2');
    expect(identifierFrom('\u0628\u0646\u0643 \u0627\u0644\u0623\u0631\u062f\u0646', CODE)).toBe('method');
    expect(identifierFrom('\u4e2d\u6587 \u0440\u0443\u0441\u0441\u043a\u0438\u0439', CODE)).toBe('method');
    expect(identifierFrom('\u0628\u0646\u0643', KEY)).toBe('rule');
  });

  it('gives the fallback when nothing is left', () => {
    expect(identifierFrom('', CODE)).toBe('method');
    expect(identifierFrom('   ', CODE)).toBe('method');
    expect(identifierFrom('!!! ??? ---', CODE)).toBe('method');
    expect(identifierFrom('\u{1F4B3}\u{1F4B3}', CODE)).toBe('method');
  });

  it('cuts to the longest length and never leaves an underscore at the end of the cut', () => {
    const long = identifierFrom('a'.repeat(100), CODE);
    expect(long).toBe('a'.repeat(40));
    // The 40th character falls on an underscore: it goes.
    const cut = identifierFrom(`${'a'.repeat(39)} bbbb`, CODE);
    expect(cut).toBe('a'.repeat(39));
    expect(identifierFrom('word '.repeat(30), { maxLength: 12, fallback: 'x' })).toBe('word_word_wo');
    expect(identifierFrom('word word word', { maxLength: 10, fallback: 'x' })).toBe('word_word');
  });

  it('puts a result that starts with a digit or is too short behind the fallback when the rules ask for it', () => {
    expect(identifierFrom('5xx errors', KEY)).toBe('rule_5xx_errors');
    expect(identifierFrom('5xx errors', CODE)).toBe('5xx_errors');
    expect(identifierFrom('A!', KEY)).toBe('rule_a');
    expect(identifierFrom('Ab', KEY)).toBe('rule_ab');
    expect(identifierFrom('CPU', KEY)).toBe('cpu');
    expect(identifierFrom('12', KEY)).toBe('rule_12');
    expect(identifierFrom('A', CODE)).toBe('a');
  });

  it('always satisfies the format of both users', () => {
    const slug = /^[a-z0-9][a-z0-9_-]{0,39}$/;
    const key = /^[a-z][a-z0-9_]{2,40}$/;
    for (const text of [
      '',
      ' ',
      '9',
      '__',
      'A',
      'x'.repeat(200),
      '1'.repeat(200),
      'a_'.repeat(60),
      '\u0628\u0646\u0643',
      'Caf\u00e9 5xx',
    ]) {
      expect(identifierFrom(text, CODE)).toMatch(slug);
      expect(identifierFrom(text, KEY)).toMatch(key);
    }
  });
});

describe('identifierAttempt', () => {
  it('is the base itself first, then _2, _3, ...', () => {
    expect(identifierAttempt('bank', 1, 40)).toBe('bank');
    expect(identifierAttempt('bank', 2, 40)).toBe('bank_2');
    expect(identifierAttempt('bank', 3, 40)).toBe('bank_3');
    expect(identifierAttempt('bank', 12, 40)).toBe('bank_12');
    expect(identifierAttempt('bank', 0, 40)).toBe('bank');
    expect(identifierAttempt('bank', -4, 40)).toBe('bank');
  });

  it('cuts the base so that the suffix always fits the longest length', () => {
    const base = 'a'.repeat(40);
    expect(identifierAttempt(base, 1, 40)).toBe(base);
    expect(identifierAttempt(base, 2, 40)).toBe(`${'a'.repeat(38)}_2`);
    expect(identifierAttempt(base, 10, 40)).toBe(`${'a'.repeat(37)}_10`);
    expect(identifierAttempt(`${'a'.repeat(37)}_bc`, 2, 40)).toBe(`${'a'.repeat(37)}_2`);
    for (let attempt = 1; attempt < 200; attempt += 1) {
      expect(identifierAttempt(base, attempt, 40).length).toBeLessThanOrEqual(40);
    }
  });
});

describe('firstFreeIdentifier', () => {
  /** A fake store: `held` are the identifiers taken; `raceOn` are taken between the read and the write, once. */
  function store(held: string[], raceOn: string[] = []) {
    const rows: string[] = [];
    const reads: string[] = [];
    const writes: string[] = [];
    return {
      rows,
      reads,
      writes,
      search: (base: string, maxLength = 40) => ({
        base,
        maxLength,
        isTaken: (candidate: string) => {
          reads.push(candidate);
          return Promise.resolve(held.includes(candidate));
        },
        insert: (candidate: string) => {
          writes.push(candidate);
          held.push(candidate);
          if (raceOn.includes(candidate)) return Promise.resolve(undefined);
          rows.push(candidate);
          return Promise.resolve(candidate);
        },
      }),
    };
  }

  it('writes the base when nothing holds it', async () => {
    const s = store([]);
    expect(await firstFreeIdentifier(s.search('bank'))).toBe('bank');
    expect(s.writes).toEqual(['bank']);
  });

  it('skips the identifiers that are held, without writing them', async () => {
    const s = store(['bank', 'bank_2', 'bank_3']);
    expect(await firstFreeIdentifier(s.search('bank'))).toBe('bank_4');
    expect(s.reads).toEqual(['bank', 'bank_2', 'bank_3', 'bank_4']);
    expect(s.writes).toEqual(['bank_4']);
  });

  it('tries the next number when the write reports that another create took the identifier first', async () => {
    const s = store([], ['bank', 'bank_2']);
    expect(await firstFreeIdentifier(s.search('bank'))).toBe('bank_3');
    expect(s.writes).toEqual(['bank', 'bank_2', 'bank_3']);
    expect(s.rows).toEqual(['bank_3']);
  });

  it('gives up with an error when every try is taken', async () => {
    let tries = 0;
    const failure = await firstFreeIdentifier({
      base: 'x',
      maxLength: 40,
      isTaken: () => {
        tries += 1;
        return Promise.resolve(true);
      },
      insert: () => Promise.resolve('never'),
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain('No free identifier');
    expect(tries).toBe(MAX_IDENTIFIER_ATTEMPTS);
  });
});
