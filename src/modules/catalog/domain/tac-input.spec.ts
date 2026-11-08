// Unit tests of the TAC catalog input rules: the release year bounds and the wire form of an unknown year.
import { describe, expect, it } from 'bun:test';
import { MIN_RELEASE_YEAR, checkReleaseYear, tacInUseMessage, wireReleaseYear } from './tac-input';

describe('checkReleaseYear', () => {
  it('accepts a whole year from 1990 up to next year', () => {
    expect(checkReleaseYear(MIN_RELEASE_YEAR, 2026)).toBeUndefined();
    expect(checkReleaseYear(2021, 2026)).toBeUndefined();
    expect(checkReleaseYear(2027, 2026)).toBeUndefined();
  });

  it('refuses 0, a year before 1990, after next year, and a year with a fraction, naming the bounds', () => {
    for (const year of [0, 1989, 2028, 2020.5, Number.NaN]) {
      expect(checkReleaseYear(year, 2026)).toEqual({
        field: 'releaseYear',
        code: 'range',
        message: 'Enter a 4-digit year from 1990 to 2027.',
      });
    }
  });
});

describe('wireReleaseYear and tacInUseMessage', () => {
  it('sends an unknown year as 0', () => {
    expect(wireReleaseYear(null)).toBe(0);
    expect(wireReleaseYear(2021)).toBe(2021);
  });

  it('words the refusal exactly as RESOLUTIONS catalog-7 does', () => {
    expect(tacInUseMessage(3, '35389011')).toBe(
      '3 IMEI checks already use TAC 35389011; add a new entry for the new TAC instead.',
    );
  });
});
