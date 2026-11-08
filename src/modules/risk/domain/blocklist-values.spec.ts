// Unit tests of the blocklist values (feature 18): normalising a typed value, the hash input and the display text.
import { describe, expect, it } from 'bun:test';
import {
  auditBlockDisplay,
  auditBlockLabel,
  blockDisplay,
  blockHashInput,
  normalizeBlockValue,
} from './blocklist-values';

describe('normalizeBlockValue', () => {
  it('lower-cases and trims an email and a domain, and drops the @ of a domain', () => {
    expect(normalizeBlockValue('email', '  Jack.Turner@Example.COM ')).toEqual({
      ok: true,
      value: 'jack.turner@example.com',
    });
    expect(normalizeBlockValue('domain', ' @TempBox.Example ')).toEqual({ ok: true, value: 'tempbox.example' });
  });

  it('refuses a malformed email, domain and empty value with the field message', () => {
    expect(normalizeBlockValue('email', 'not-an-email')).toEqual({
      ok: false,
      message: 'Enter a valid email address.',
    });
    expect(normalizeBlockValue('domain', 'nodot')).toEqual({
      ok: false,
      message: 'Enter a domain such as example.com.',
    });
    expect(normalizeBlockValue('card', '   ')).toEqual({ ok: false, message: 'Enter a value.' });
  });

  it('keeps the 15 digits of an IMEI and refuses anything else with the console words', () => {
    expect(normalizeBlockValue('imei', '35 389011-884201 9')).toEqual({ ok: true, value: '353890118842019' });
    expect(normalizeBlockValue('imei', '3538901188420')).toEqual({ ok: false, message: 'An IMEI has 15 digits.' });
    expect(normalizeBlockValue('imei', '35389011884201a')).toEqual({ ok: false, message: 'An IMEI has 15 digits.' });
  });

  it('upper-cases a country and bounds a card fingerprint', () => {
    expect(normalizeBlockValue('country', 'gb')).toEqual({ ok: true, value: 'GB' });
    expect(normalizeBlockValue('country', 'GBR').ok).toBe(false);
    expect(normalizeBlockValue('card', 'x'.repeat(201)).ok).toBe(false);
    expect(normalizeBlockValue('card', ' fp_9f2c1a ')).toEqual({ ok: true, value: 'fp_9f2c1a' });
  });
});

describe('blockHashInput', () => {
  it('hashes an email as its text (the recipe feature 14b already uses), an IMEI like the IMEI check, the rest behind the kind', () => {
    expect(blockHashInput('email', 'a@b.co')).toBe('a@b.co');
    expect(blockHashInput('imei', '353890118842019')).toBe('imei:353890118842019');
    expect(blockHashInput('card', 'fp_1')).toBe('card:fp_1');
    expect(blockHashInput('domain', 'x.com')).toBe('domain:x.com');
    expect(blockHashInput('country', 'GB')).toBe('country:GB');
  });
});

describe('blockDisplay', () => {
  it('masks an email, groups an IMEI and shortens a card fingerprint', () => {
    expect(blockDisplay('email', 'jack.turner@tempbox.example')).toBe('ja****@tempbox.example');
    expect(blockDisplay('imei', '353890118842019')).toBe('35 389011 884201 9');
    expect(blockDisplay('card', 'fp_9f2c1a77b3d4e5')).toBe('Card fingerprint fp_9f2…4e5');
    expect(blockDisplay('card', 'fp_short')).toBe('Card fingerprint fp_short');
    expect(blockDisplay('domain', 'tempbox.example')).toBe('tempbox.example');
    expect(blockDisplay('country', 'GB')).toBe('GB');
  });
});

describe('auditBlockLabel', () => {
  it('names an IMEI entry by its TAC and a mask, and leaves the other kinds as they are shown', () => {
    expect(auditBlockLabel({ kind: 'imei', display: '35 389011 884201 9' })).toBe('imei 35389011•••••••');
    expect(auditBlockDisplay({ kind: 'imei', display: '35 389011 884201 9' })).toBe('35389011•••••••');
    expect(auditBlockLabel({ kind: 'email', display: 'ja****@tempbox.example' })).toBe('email ja****@tempbox.example');
    expect(auditBlockLabel({ kind: 'domain', display: 'tempbox.example' })).toBe('domain tempbox.example');
    expect(auditBlockLabel({ kind: 'card', display: 'Card fingerprint fp_9f2…4e5' })).toBe(
      'card Card fingerprint fp_9f2…4e5',
    );
  });
});
