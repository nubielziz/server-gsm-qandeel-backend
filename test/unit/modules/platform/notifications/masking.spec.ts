// Unit tests of the recipient masks of the notification log (feature 12a), the cleaning of a provider's refusal text and the hidden
// payload of a caller without notifications:* (decision 054).
import { describe, expect, it } from 'bun:test';
import { HIDDEN_VALUE, hiddenPayload } from '@src/modules/platform/notifications/notification-log-admin.service';
import {
  cleanProviderText,
  maskEmail,
  maskTelegram,
  redactAddresses,
} from '@src/modules/platform/notifications/masking';

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

describe('cleanProviderText (decision 054)', () => {
  it("cleans a provider's text of addresses, links and token-like strings", () => {
    const text = cleanProviderText(
      '550 rejected https://shop.example.com/sign-in?token=AbCdEfGhIjKlMnOpQrStUvWx for r@x.io',
    );
    expect(text).not.toContain('https://');
    expect(text).not.toContain('AbCdEfGhIjKlMnOpQrStUvWx');
    expect(text).toContain('r***@x.io');
    expect(text).toBe('550 rejected [link] for r***@x.io');
  });

  it('replaces a bare token-like run and keeps ordinary words and codes', () => {
    expect(cleanProviderText('Bad Request: secret AbCdEfGhIjKlMnOpQrStUvWx was refused (5.7.1)')).toBe(
      'Bad Request: secret [token] was refused (5.7.1)',
    );
  });

  it('collapses white space, cuts to the limit and reads a bounded part of a long text', () => {
    expect(cleanProviderText('  a\n\n b  ')).toBe('a b');
    const long = cleanProviderText('word '.repeat(10_000), 200);
    expect(long.length).toBe(200);
    expect(long.endsWith('…')).toBe(true);
  });
});

describe('hiddenPayload (decision 054)', () => {
  it('hides every text and number and keeps booleans, null, keys and the shape, at any depth', () => {
    expect(
      hiddenPayload({
        event: 'support.reply',
        variables: { customerName: 'Rania', ticketNumber: 'T-1042', count: 3, urgent: true, note: null },
        list: ['a', 1, false, { inner: 'x' }],
        chatId: '@1***',
      }),
    ).toEqual({
      event: HIDDEN_VALUE,
      variables: {
        customerName: HIDDEN_VALUE,
        ticketNumber: HIDDEN_VALUE,
        count: HIDDEN_VALUE,
        urgent: true,
        note: null,
      },
      list: [HIDDEN_VALUE, HIDDEN_VALUE, false, { inner: HIDDEN_VALUE }],
      chatId: HIDDEN_VALUE,
    });
  });
});
