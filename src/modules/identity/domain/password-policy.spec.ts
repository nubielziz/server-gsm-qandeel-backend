// Unit tests of the staff password policy: length, trivial passwords, and the account's own email and name.
import { describe, expect, it } from 'bun:test';
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH, checkPasswordPolicy } from './password-policy';

const context = { email: 'rami.khalil@gsm-supply.example', name: 'Rami Khalil' };

describe('checkPasswordPolicy', () => {
  it('accepts a long, varied password', () => {
    expect(checkPasswordPolicy('a-brand-new-passphrase', context)).toBeUndefined();
    expect(checkPasswordPolicy('x9!Kd#2qLm', context)).toBeUndefined();
  });

  it('refuses fewer than 10 characters and counts characters, not bytes', () => {
    expect(MIN_PASSWORD_LENGTH).toBe(10);
    expect(checkPasswordPolicy('abc123XY!')?.message).toContain('at least 10');
    expect(checkPasswordPolicy('كلمةسرطويلة')).toBeUndefined();
    expect(checkPasswordPolicy('كلمة')?.message).toContain('at least 10');
  });

  it('refuses a very long password', () => {
    expect(checkPasswordPolicy('a1'.repeat(MAX_PASSWORD_LENGTH))?.message).toContain('at most');
  });

  it('refuses passwords made of a few repeated characters', () => {
    expect(checkPasswordPolicy('1111111111')).toBeDefined();
    expect(checkPasswordPolicy('abababababab')).toBeDefined();
  });

  it('refuses digit runs and common words with digits or symbols around them', () => {
    for (const weak of [
      '1234567890',
      '0123456789',
      '9876543210',
      'password',
      'Password123!',
      'QWERTYUIOP12',
      'letmein2024!',
    ]) {
      expect(checkPasswordPolicy(weak), weak).toBeDefined();
    }
  });

  it('refuses a password that holds the email name or the person name', () => {
    expect(checkPasswordPolicy('rami.khalil-2026-x', context)?.message).toContain('email');
    expect(checkPasswordPolicy('Khalil-is-here-77', { name: 'Rami Khalil' })?.message).toContain('name');
    // Short name parts are too common to forbid.
    expect(checkPasswordPolicy('xx-bo-is-fine-123', { name: 'Bo Li' })).toBeUndefined();
  });
});
