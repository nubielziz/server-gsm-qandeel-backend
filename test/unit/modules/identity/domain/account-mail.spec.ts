// Unit tests of the account-mail limiter key (feature 20).
import { describe, expect, it } from 'bun:test';
import { accountMailKey } from '@src/modules/identity/domain/account-mail';

describe('accountMailKey', () => {
  it('is stable and a 32-character hex key', () => {
    expect(accountMailKey('client', 7, 'verification')).toMatch(/^[0-9a-f]{32}$/);
    expect(accountMailKey('client', 7, 'verification')).toBe(accountMailKey('client', 7, 'verification'));
  });

  it('tells apart the subject type, the id and the kind', () => {
    const base = accountMailKey('client', 7, 'password_link');
    expect(accountMailKey('staff', 7, 'password_link')).not.toBe(base);
    expect(accountMailKey('client', 8, 'password_link')).not.toBe(base);
    expect(accountMailKey('client', 7, 'verification')).not.toBe(base);
    expect(accountMailKey('client', 7, 'email_change')).not.toBe(base);
  });

  it('keeps the mails a visitor asks for apart from the ones staff send, and customers apart from merchants', () => {
    const staffLink = accountMailKey('client', 7, 'password_link');
    const keys = new Set([
      staffLink,
      accountMailKey('client', 7, 'forgot_password'),
      accountMailKey('customer', 7, 'forgot_password'),
      accountMailKey('customer', 7, 'sign_in_link'),
      accountMailKey('customer', 7, 'password_link'),
    ]);
    expect(keys.size).toBe(5);
  });
});
