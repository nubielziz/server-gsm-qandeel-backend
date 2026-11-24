// Unit tests of the naming rules of a service's custom fields (decision 065): the key a Name suggests, a free key and a free Name in a
// service, and the comparison form of a Name. Characters that are not Latin are written with escapes only (decision 039).
import { describe, expect, it } from 'bun:test';
import {
  FIELD_KEY_MAX,
  FIELD_NAME_MAX,
  fieldKeyBase,
  fieldNameKey,
  freeFieldKey,
  freeFieldName,
} from '@src/common/field-names';

/** A Name in Arabic script (the words for "serial number"). */
const ARABIC_NAME = '\u0627\u0644\u0631\u0642\u0645 \u0627\u0644\u062a\u0633\u0644\u0633\u0644\u064a';

describe('fieldKeyBase', () => {
  it('makes lower snake case from a Name', () => {
    expect(fieldKeyBase('Serial Number')).toBe('serial_number');
    expect(fieldKeyBase('  E-mail (account)  ')).toBe('e_mail_account');
    expect(fieldKeyBase('IMEI')).toBe('imei');
    expect(fieldKeyBase('Lock code #2')).toBe('lock_code_2');
  });

  it('answers field when nothing is left, as for a Name in Arabic script', () => {
    expect(fieldKeyBase(ARABIC_NAME)).toBe('field');
    expect(fieldKeyBase('---')).toBe('field');
    expect(fieldKeyBase('')).toBe('field');
  });

  it('keeps the Latin part of a mixed Name', () => {
    expect(fieldKeyBase(`${ARABIC_NAME} IMEI`)).toBe('imei');
  });

  it('is at most 60 characters', () => {
    const base = fieldKeyBase('a'.repeat(100));
    expect(FIELD_KEY_MAX).toBe(60);
    expect(base).toBe('a'.repeat(60));
  });
});

describe('freeFieldKey', () => {
  it('answers the base when it is free', () => {
    expect(freeFieldKey('email', new Set(['username']))).toBe('email');
  });

  it('appends _2, _3, ... on a clash, the first that is free', () => {
    expect(freeFieldKey('email', new Set(['email']))).toBe('email_2');
    expect(freeFieldKey('email', new Set(['email', 'email_2', 'email_4']))).toBe('email_3');
  });

  it('cuts the base so the key stays at most 60 characters', () => {
    const base = 'b'.repeat(60);
    expect(freeFieldKey(base, new Set([base]))).toBe(`${'b'.repeat(58)}_2`);
    const taken = new Set([base, ...Array.from({ length: 8 }, (_, i) => `${'b'.repeat(58)}_${i + 2}`)]);
    expect(freeFieldKey(base, taken)).toBe(`${'b'.repeat(57)}_10`);
    expect(freeFieldKey('c'.repeat(70), new Set())).toHaveLength(60);
  });
});

describe('fieldNameKey', () => {
  it('trims and lower-cases', () => {
    expect(fieldNameKey('  Email ')).toBe('email');
    expect(fieldNameKey('IMEI')).toBe(fieldNameKey('imei'));
  });

  it('keeps a Name in Arabic script as it is', () => {
    expect(fieldNameKey(` ${ARABIC_NAME} `)).toBe(ARABIC_NAME);
  });
});

describe('freeFieldName', () => {
  it('answers the trimmed Name when it is free', () => {
    expect(freeFieldName('  Username ', new Set(['email']))).toBe('Username');
  });

  it('appends " 2", " 3", ... when the Name is taken in any case', () => {
    expect(freeFieldName('Email', new Set(['email']))).toBe('Email 2');
    expect(freeFieldName('email', new Set(['email', 'email 2']))).toBe('email 3');
    expect(freeFieldName('Username', new Set(['username', 'username 3']))).toBe('Username 2');
  });

  it('keeps a Name in Arabic script, and numbers it on a clash', () => {
    expect(freeFieldName(ARABIC_NAME, new Set())).toBe(ARABIC_NAME);
    expect(freeFieldName(ARABIC_NAME, new Set([fieldNameKey(ARABIC_NAME)]))).toBe(`${ARABIC_NAME} 2`);
  });

  it('keeps a free Name whole and cuts a numbered one so it stays at most 120 characters', () => {
    expect(FIELD_NAME_MAX).toBe(120);
    const long = 'n'.repeat(150);
    expect(freeFieldName(long, new Set())).toBe(long);
    const name = 'N'.repeat(120);
    expect(freeFieldName(name, new Set([fieldNameKey(name)]))).toBe(`${'N'.repeat(118)} 2`);
  });

  it('never leaves half of a surrogate pair at the cut', () => {
    const name = `${'x'.repeat(117)}\u{1F600}`;
    const free = freeFieldName(name, new Set([fieldNameKey(name)]));
    expect(free).toBe(`${'x'.repeat(117)} 2`);
    expect(free.length).toBeLessThanOrEqual(120);
  });
});
