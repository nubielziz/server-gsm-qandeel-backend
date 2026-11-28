// Unit tests of the rules of a shop sign-up with details (decision 079 and its fix round): the names, the phone, the full name and its
// limit, the hidden characters, and the decision the exchange of a sign-up link takes (apply the form, keep it pending, or drop it).
import { describe, expect, it } from 'bun:test';
import {
  SIGN_UP_FINISH_SESSION_MAX_AGE_MS,
  SIGN_UP_FULL_NAME_MAX_LENGTH,
  SIGN_UP_NAME_MAX_LENGTH,
  cleanSignUpName,
  cleanSignUpPhone,
  signUpFullName,
  signUpFinishSessionFresh,
  signUpFullNameProblem,
  signUpNameProblem,
  signUpOutcome,
  signUpPhoneProblem,
} from '@src/modules/identity/domain/sign-up';

describe('the names of a sign-up', () => {
  it('are trimmed and keep everything else as typed', () => {
    expect(cleanSignUpName('  Daniel  ')).toBe('Daniel');
    expect(cleanSignUpName(' Mary  Ann ')).toBe('Mary  Ann');
  });

  it('accept 1 to 60 characters of any script, counted as characters', () => {
    expect(signUpNameProblem('D', 'first')).toBeUndefined();
    expect(signUpNameProblem('x'.repeat(SIGN_UP_NAME_MAX_LENGTH), 'last')).toBeUndefined();
    // An Arabic name is data (decision 039), written here as escapes.
    expect(signUpNameProblem('\u0645\u062d\u0645\u062f', 'first')).toBeUndefined();
    // A letter outside the Basic Multilingual Plane is one character, though it is two UTF-16 units.
    expect(signUpNameProblem('\u{1d4d0}'.repeat(SIGN_UP_NAME_MAX_LENGTH), 'first')).toBeUndefined();
  });

  it('refuse an empty name with a sentence for its field', () => {
    expect(signUpNameProblem('', 'first')).toBe('Enter your first name.');
    expect(signUpNameProblem('', 'last')).toBe('Enter your last name.');
  });

  it('refuse more than 60 characters', () => {
    expect(signUpNameProblem('x'.repeat(SIGN_UP_NAME_MAX_LENGTH + 1), 'first')).toBe('Use at most 60 characters.');
  });

  it('refuse a control character: a line break, a tab, a C1 control', () => {
    for (const name of ['Dan\niel', 'Dan\tiel', 'Dan\u0085iel', 'Dan\u007fiel']) {
      expect(signUpNameProblem(name, 'first'), JSON.stringify(name)).toBe(
        'Remove the line breaks, tabs and invisible characters.',
      );
    }
  });

  it('refuse every invisible direction mark and override (the review of decision 079, S4)', () => {
    const marks = [
      '\u200e',
      '\u200f',
      '\u202a',
      '\u202b',
      '\u202c',
      '\u202d',
      '\u202e',
      '\u2066',
      '\u2067',
      '\u2068',
      '\u2069',
    ];
    for (const mark of marks) {
      expect(signUpNameProblem(`Dan${mark}iel`, 'last'), JSON.stringify(mark)).toBe(
        'Remove the line breaks, tabs and invisible characters.',
      );
    }
    // The joiners Arabic and other scripts need are letters' business, not marks: they stay.
    expect(signUpNameProblem('\u0644\u200d\u0627', 'first')).toBeUndefined();
  });

  it('refuse the Arabic letter mark and the line and paragraph separators (the re-review of decision 079)', () => {
    for (const mark of ['\u061c', '\u2028', '\u2029']) {
      expect(signUpNameProblem(`Dan${mark}iel`, 'first'), JSON.stringify(mark)).toBe(
        'Remove the line breaks, tabs and invisible characters.',
      );
    }
    // Arabic letters around the place of the mark stay data (decision 039).
    expect(signUpNameProblem('\u0645\u062d\u0645\u062f \u0639\u0644\u064a', 'last')).toBeUndefined();
  });

  it('make the account name of the first name, one space and the last name', () => {
    expect(signUpFullName('Daniel', 'Whitmore')).toBe('Daniel Whitmore');
  });

  it('together fit the 120 characters of an account name: the sentence is for the last name', () => {
    expect(SIGN_UP_FULL_NAME_MAX_LENGTH).toBe(120);
    // 60 + 1 + 59 = 120 fits; 60 + 1 + 60 = 121 does not, although each name alone is allowed.
    expect(signUpFullNameProblem('x'.repeat(60), 'y'.repeat(59))).toBeUndefined();
    expect(signUpNameProblem('y'.repeat(60), 'last')).toBeUndefined();
    expect(signUpFullNameProblem('x'.repeat(60), 'y'.repeat(60))).toBe(
      'Your first and last name together can have at most 119 characters.',
    );
  });
});

describe('the phone of a sign-up', () => {
  it('loses its spaces, dashes, dots and brackets', () => {
    expect(cleanSignUpPhone('+44 (0) 7700-900.123')).toBe('+4407700900123');
    expect(cleanSignUpPhone('+962\u00a079\u2013123\u20104567')).toBe('+962791234567');
    expect(cleanSignUpPhone('0791234567')).toBe('0791234567');
  });

  it('keeps tabs, line breaks and invisible marks, and refuses them (the review of decision 079, S4)', () => {
    for (const typed of [
      '+44\t7700900123',
      '+447700\n900123',
      '+44\u200e7700900123',
      '+44\u202e7700900123',
      '+44\u061c7700900123',
      '+44\u20287700900123',
      '+44\u20297700900123',
    ]) {
      const cleaned = cleanSignUpPhone(typed);
      expect(cleaned, JSON.stringify(typed)).not.toMatch(/^\+?[0-9]+$/);
      expect(signUpPhoneProblem(cleaned), JSON.stringify(typed)).toBe(
        'Remove the line breaks, tabs and invisible characters.',
      );
    }
  });

  it('accepts an optional leading + and 7 to 15 digits', () => {
    for (const phone of ['1234567', '+1234567', '123456789012345', '+962791234567']) {
      expect(signUpPhoneProblem(phone), phone).toBeUndefined();
    }
  });

  it('refuses too few or too many digits, a + that does not lead, letters and other signs', () => {
    for (const phone of [
      '',
      '123456',
      '+123456',
      '1234567890123456',
      '12+34567',
      '++1234567',
      '12345a7',
      '1234567#',
      '+',
    ]) {
      expect(signUpPhoneProblem(phone), phone).toBe(
        'Enter a phone number of 7 to 15 digits, with the country code (+962 79 123 4567).',
      );
    }
  });

  it('refuses digits of another script: the stored number is ASCII', () => {
    expect(signUpPhoneProblem('\u0660\u0667\u0669\u0661\u0662\u0663\u0664\u0665')).toBeDefined();
  });
});

describe('signUpFinishSessionFresh', () => {
  const NOW = Date.parse('2026-11-28T10:00:00.000Z');

  it('is 60 minutes', () => {
    expect(SIGN_UP_FINISH_SESSION_MAX_AGE_MS).toBe(60 * 60 * 1000);
  });

  it('accepts a session opened at most 60 minutes ago and refuses an older one (the re-review of decision 079)', () => {
    expect(signUpFinishSessionFresh(NOW, NOW)).toBe(true);
    expect(signUpFinishSessionFresh(NOW - SIGN_UP_FINISH_SESSION_MAX_AGE_MS, NOW)).toBe(true);
    expect(signUpFinishSessionFresh(NOW - SIGN_UP_FINISH_SESSION_MAX_AGE_MS - 1, NOW)).toBe(false);
    expect(signUpFinishSessionFresh(NOW - 7 * 24 * 60 * 60 * 1000, NOW)).toBe(false);
  });
});

describe('signUpOutcome', () => {
  it('applies the form when this exchange made the account in the browser that sent it', () => {
    expect(signUpOutcome({ madeHere: true, requestedHere: true })).toBe('apply');
  });

  it('applies nothing in another browser and keeps the form pending for the owner of the mailbox (a stranger may have sent it)', () => {
    expect(signUpOutcome({ madeHere: true, requestedHere: false })).toBe('pending');
  });

  it('drops the form for an account that already had its login, in any browser', () => {
    expect(signUpOutcome({ madeHere: false, requestedHere: true })).toBe('discard');
    expect(signUpOutcome({ madeHere: false, requestedHere: false })).toBe('discard');
  });
});
