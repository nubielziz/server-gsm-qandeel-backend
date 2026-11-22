// Unit tests of the unsubscribe token (feature 23, plan section 9.6): a round trip, a tampered MAC, another id, junk and a stable value.
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
const service = tokens('pepper-one-0123456789-0123456789');

describe('marketingUnsubscribeToken', () => {
  it('round-trips a customer id and is stable', () => {
    for (const id of [1, 35, 36, 1234567, 2 ** 40]) {
      const token = marketingUnsubscribeToken(service, id);
      expect(token).toMatch(/^[0-9a-z]{1,13}\.[0-9a-f]{32}$/);
      expect(parseMarketingUnsubscribeToken(service, token)).toBe(id);
      expect(marketingUnsubscribeToken(service, id)).toBe(token);
    }
  });

  it('refuses a tampered MAC, another customer’s id with this MAC, another server key, and junk', () => {
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
