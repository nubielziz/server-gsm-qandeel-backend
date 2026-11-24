// Unit tests of the unsubscribe token (feature 23, plan section 9.6; decision 064): a round trip under the account prefix, an old customer
// token read as an old customer number (never as an account id), a new token that differs from the old token of the same number, a
// tampered MAC, another id, junk and a stable value.
import { describe, expect, it } from 'bun:test';
import type { TokenService } from '@src/infra/crypto';
import { hashToken } from '@src/infra/crypto/tokens';
import {
  marketingUnsubscribeToken,
  parseMarketingUnsubscribeToken,
} from '@src/modules/platform/notifications/campaigns/unsubscribe-token';

const tokens = (pepper: string) =>
  ({
    lookupHash: (text: string) => hashToken(pepper, text),
    equals: (a: string, b: string) => a === b,
  }) as TokenService;
const PEPPER = 'pepper-one-0123456789-0123456789';
const service = tokens(PEPPER);

/** The token a customer's mail carried before the accounts were merged: the same format under the old prefix. */
const oldCustomerToken = (id: number): string =>
  `${id.toString(36)}.${hashToken(PEPPER, `marketing-unsubscribe:customer:${id}`).slice(0, 32)}`;

describe('marketingUnsubscribeToken', () => {
  it('round-trips an account id and is stable', () => {
    for (const id of [1, 35, 36, 1234567, 2 ** 40]) {
      const token = marketingUnsubscribeToken(service, id);
      expect(token).toMatch(/^[0-9a-z]{1,13}\.[0-9a-f]{32}$/);
      expect(parseMarketingUnsubscribeToken(service, token)).toEqual({ kind: 'account', id });
      expect(marketingUnsubscribeToken(service, id)).toBe(token);
    }
  });

  it('signs the account prefix: the new token of account 7 is not the old token of customer 7', () => {
    const fresh = marketingUnsubscribeToken(service, 7);
    const old = oldCustomerToken(7);
    expect(fresh).not.toBe(old);
    // Same format, so only the MAC tells them apart, and each parses to its own subject.
    expect(old).toMatch(/^[0-9a-z]{1,13}\.[0-9a-f]{32}$/);
    expect(parseMarketingUnsubscribeToken(service, fresh)).toEqual({ kind: 'account', id: 7 });
    expect(parseMarketingUnsubscribeToken(service, old)).toEqual({ kind: 'customer', id: 7 });
  });

  it('reads an old customer token as an old customer number, never as an account id', () => {
    for (const id of [1, 57, 100_000]) {
      expect(parseMarketingUnsubscribeToken(service, oldCustomerToken(id))).toEqual({ kind: 'customer', id });
    }
    // The MAC of customer 7 does not open account 7, and the MAC of account 7 does not open customer 7.
    const [, oldMac] = oldCustomerToken(7).split('.') as [string, string];
    const [, freshMac] = marketingUnsubscribeToken(service, 7).split('.') as [string, string];
    expect(parseMarketingUnsubscribeToken(service, `${(7).toString(36)}.${oldMac}`)?.kind).toBe('customer');
    expect(parseMarketingUnsubscribeToken(service, `${(7).toString(36)}.${freshMac}`)?.kind).toBe('account');
  });

  it('refuses an old customer token made with another server key', () => {
    expect(
      parseMarketingUnsubscribeToken(tokens('pepper-two-0123456789-0123456789'), oldCustomerToken(7)),
    ).toBeUndefined();
  });

  it('refuses a tampered MAC, another account’s id with this MAC, another server key, and junk', () => {
    const token = marketingUnsubscribeToken(service, 42);
    const [id, mac] = token.split('.') as [string, string];
    expect(parseMarketingUnsubscribeToken(service, `${id}.${'0'.repeat(32)}`)).toBeUndefined();
    expect(
      parseMarketingUnsubscribeToken(service, `${id}.${mac.slice(0, 31)}${mac.endsWith('0') ? '1' : '0'}`),
    ).toBeUndefined();
    expect(parseMarketingUnsubscribeToken(service, `${(43).toString(36)}.${mac}`)).toBeUndefined();
    const letter = marketingUnsubscribeToken(service, 35);
    expect(parseMarketingUnsubscribeToken(service, letter.toUpperCase())).toBeUndefined();
    expect(parseMarketingUnsubscribeToken(tokens('pepper-two-0123456789-0123456789'), token)).toBeUndefined();
    for (const junk of [
      '',
      '.',
      'abc',
      `${id}.`,
      `.${mac}`,
      `${id}.${mac}.x`,
      `0.${mac}`,
      `-1.${mac}`,
      `zzzzzzzzzzzzzz.${mac}`,
    ]) {
      expect(parseMarketingUnsubscribeToken(service, junk), junk).toBeUndefined();
    }
  });
});
