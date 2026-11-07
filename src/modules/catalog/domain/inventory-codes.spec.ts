// Unit tests of the inventory rules: which lines are codes, the mask, the batch reference and the pasted list preparation.
import { describe, expect, it } from 'bun:test';
import { BATCH_REF_PATTERN, batchRefOf, isStorableCode, lastFour, maskedCode, prepareCodes } from './inventory-codes';

describe('isStorableCode', () => {
  it('accepts 6 to 128 characters without whitespace or control characters', () => {
    expect(isStorableCode('ABCDEF')).toBe(true);
    expect(isStorableCode('A'.repeat(128))).toBe(true);
    expect(isStorableCode('Z3X-1000-A1B2')).toBe(true);
  });

  it('refuses short, long, spaced and control-character lines', () => {
    expect(isStorableCode('ABCDE')).toBe(false);
    expect(isStorableCode('A'.repeat(129))).toBe(false);
    expect(isStorableCode('ABC DEF')).toBe(false);
    expect(isStorableCode('ABC\tDEF')).toBe(false);
    expect(isStorableCode('ABC\u0000DEF')).toBe(false);
    expect(isStorableCode('ABC DEF')).toBe(false);
    expect(isStorableCode('')).toBe(false);
  });
});

describe('masking', () => {
  it('shows eight bullets and the last four characters', () => {
    expect(lastFour('Z3X-1000-A1B2')).toBe('A1B2');
    expect(maskedCode('A1B2')).toBe('••••••••A1B2');
    expect(maskedCode(lastFour('ABCDEFGH')).length).toBe(12);
  });
});

describe('batch references', () => {
  it('pads the sequence to four digits and keeps growing after 9999', () => {
    expect(batchRefOf(31)).toBe('B-0031');
    expect(batchRefOf(1)).toBe('B-0001');
    expect(batchRefOf(12345)).toBe('B-12345');
  });

  it('accepts letters, digits, dot, underscore and hyphen up to 40 characters', () => {
    expect(BATCH_REF_PATTERN.test('B-0031')).toBe(true);
    expect(BATCH_REF_PATTERN.test('supplier_2026.03')).toBe(true);
    expect(BATCH_REF_PATTERN.test('a'.repeat(41))).toBe(false);
    expect(BATCH_REF_PATTERN.test('has space')).toBe(false);
    expect(BATCH_REF_PATTERN.test('')).toBe(false);
  });
});

describe('prepareCodes', () => {
  it('trims, counts rejected lines and repeats, and keeps the first of a repeat', () => {
    const prepared = prepareCodes(['  ABCDEF ', 'ABCDEF', 'short', 'GHIJKL', 'GH IJKL', 'abcdef', '']);
    expect(prepared.codes).toEqual(['ABCDEF', 'GHIJKL', 'abcdef']);
    expect(prepared.rejected).toBe(3);
    expect(prepared.repeated).toBe(1);
  });
});
