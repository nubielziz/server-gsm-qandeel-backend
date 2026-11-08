// Unit tests of the recipient masks of the notification log (feature 12a).
import { describe, expect, it } from 'bun:test';
import { maskEmail, maskTelegram, redactAddresses } from './masking';

describe('maskEmail', () => {
  it('keeps the first letter and the domain', () => {
    expect(maskEmail('rami.haddad@example.com')).toBe('r***@example.com');
    expect(maskEmail('x@y.io')).toBe('x***@y.io');
  });

  it('hides everything that is not an address', () => {
    for (const bad of ['', 'no-at', '@example.com']) expect(maskEmail(bad)).toBe('***');
  });
});

describe('maskTelegram', () => {
  it('shows an at sign and the first character of the chat id', () => {
    expect(maskTelegram('123456789')).toBe('@1***');
    expect(maskTelegram(null)).toBe('@***');
    expect(maskTelegram(' ')).toBe('@***');
  });
});

describe('redactAddresses', () => {
  it('masks every address in a provider message and cuts it short', () => {
    expect(
      redactAddresses('550 5.1.1 <ali.hassan@example.com>: Recipient address rejected; copy to boss@corp.example.org'),
    ).toBe('550 5.1.1 <a***@example.com>: Recipient address rejected; copy to b***@corp.example.org');
    expect(redactAddresses('x'.repeat(400))).toHaveLength(300);
  });
});
