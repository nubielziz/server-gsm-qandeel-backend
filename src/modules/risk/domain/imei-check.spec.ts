// Unit tests of the storefront IMEI check rules (feature 14a).
import { describe, expect, it } from 'bun:test';
import { basicResult, countryFromHeader, imeiHashInput, readImei } from './imei-check';

describe('readImei', () => {
  it('reads a valid IMEI and its TAC, removing spaces and dashes', () => {
    expect(readImei('353890110000004')).toEqual({ ok: true, imei: '353890110000004', tac: '35389011' });
    expect(readImei(' 35 389011-0000004 ')).toEqual({ ok: true, imei: '353890110000004', tac: '35389011' });
  });

  it('refuses a wrong check digit, a wrong length and anything that is not digits', () => {
    for (const bad of [
      '353890110000005',
      '35389011000000',
      '3538901100000044',
      '35389011000000a',
      '',
      '---',
      '١٢٣٤٥٦٧٨٩٠١٢٣٤٥',
    ])
      expect(readImei(bad), bad).toEqual({ ok: false });
  });
});

describe('imeiHashInput', () => {
  it('puts the IMEI behind a prefix so it never collides with another keyed hash', () => {
    expect(imeiHashInput('353890110000004')).toBe('imei:353890110000004');
  });
});

describe('basicResult', () => {
  it('says which stage ran and what the TAC lookup found', () => {
    expect(basicResult(true)).toEqual({ stage: 'basic', checksum: 'valid', tac: 'known' });
    expect(basicResult(false)).toEqual({ stage: 'basic', checksum: 'valid', tac: 'unknown' });
  });
});

describe('countryFromHeader', () => {
  it('accepts a two-letter country and upper-cases it', () => {
    expect(countryFromHeader('gb')).toBe('GB');
    expect(countryFromHeader(' US ')).toBe('US');
    expect(countryFromHeader(['de', 'fr'])).toBe('DE');
  });

  it('refuses anything else, including the proxy placeholders for unknown and Tor', () => {
    for (const bad of [undefined, '', 'GBR', 'G', '1A', 'XX', 'T1', 'g b'])
      expect(countryFromHeader(bad), String(bad)).toBeNull();
  });
});
