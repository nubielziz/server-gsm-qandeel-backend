// Unit tests of the addresses the account mails point at (decision 064): one shop for every rank, and the signed-in area under /account.
import { describe, expect, it } from 'bun:test';
import {
  ACCOUNT_AREA_PATH,
  ACCOUNT_LINK_PATHS,
  MAX_LIVE_PUBLIC_LINKS,
  NO_ACCOUNT_ID,
  accountAreaUrl,
  accountMailLink,
} from '@src/modules/identity/domain/public-links';

describe('accountMailLink', () => {
  const store = 'https://shop.example.com';

  it('points every mail at the shop, whatever the rank of the account', () => {
    expect(accountMailLink(store, 'magic_link', 'tok')).toBe('https://shop.example.com/sign-in?token=tok');
    expect(accountMailLink(store, 'password_reset', 'tok')).toBe('https://shop.example.com/set-password?token=tok');
    expect(accountMailLink(store, 'invited', 'tok')).toBe('https://shop.example.com/set-password?token=tok');
    expect(accountMailLink(store, 'email_verification', 'tok')).toBe('https://shop.example.com/verify-email?token=tok');
  });

  it('names no merchant page: the old /merchant pages only redirect', () => {
    for (const path of Object.values(ACCOUNT_LINK_PATHS)) expect(path.startsWith('/merchant')).toBe(false);
  });

  it('encodes the token', () => {
    expect(accountMailLink(store, 'invited', 'a b&c')).toBe('https://shop.example.com/set-password?token=a%20b%26c');
  });
});

describe('accountAreaUrl', () => {
  it('builds the pages of the signed-in area under /account', () => {
    expect(ACCOUNT_AREA_PATH).toBe('/account');
    expect(accountAreaUrl('https://shop.example.com')).toBe('https://shop.example.com/account');
    expect(accountAreaUrl('https://shop.example.com', '/wallet')).toBe('https://shop.example.com/account/wallet');
  });
});

describe('the limits of the links a visitor asks for', () => {
  it('lets three work at once, and names an id no account has', () => {
    expect(MAX_LIVE_PUBLIC_LINKS).toBe(3);
    expect(Number.isSafeInteger(NO_ACCOUNT_ID)).toBe(true);
    expect(NO_ACCOUNT_ID).toBeGreaterThan(0);
  });
});
