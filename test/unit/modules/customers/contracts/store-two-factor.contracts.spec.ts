// Unit tests of the two-step sign-in routes of a retail account (decision 064): three routes on the store family for the retail rank,
// and the same code shape as the merchant routes.
import { describe, expect, it } from 'bun:test';
import {
  storeDisableTwoFactor,
  storeEnableTwoFactor,
  storeSetupTwoFactor,
} from '@src/modules/customers/contracts/store-two-factor.contracts';

describe('the store two-step routes', () => {
  it('are the three keys of the map additions, for the retail rank', () => {
    expect(storeSetupTwoFactor.key).toBe('POST /store/v1/me/2fa/setup');
    expect(storeEnableTwoFactor.key).toBe('POST /store/v1/me/2fa/enable');
    expect(storeDisableTwoFactor.key).toBe('POST /store/v1/me/2fa/disable');
    for (const route of [storeSetupTwoFactor, storeEnableTwoFactor, storeDisableTwoFactor]) {
      expect(route.access, route.key).toBe('customer-session');
      expect(route.surface, route.key).toBe('store');
      expect(route.rank, route.key).toBe('retail');
      expect(route.errors, route.key).toContain('CONFLICT');
      expect(route.errors, route.key).toContain('RANK_NOT_ALLOWED');
    }
  });

  it('answer the secret, the link and the QR code on setup, and nothing on enable and disable', () => {
    expect(storeSetupTwoFactor.success.status).toBe(200);
    expect(storeSetupTwoFactor.success.schema.safeParse(storeSetupTwoFactor.examples.response).success).toBe(true);
    expect(storeEnableTwoFactor.success.status).toBe(204);
    expect(storeDisableTwoFactor.success.status).toBe(204);
  });

  it('take a six-digit code on enable and disable', () => {
    for (const route of [storeEnableTwoFactor, storeDisableTwoFactor]) {
      expect(route.body.safeParse({ code: '123456' }).success, route.key).toBe(true);
      expect(route.body.safeParse({ code: '12345' }).success, route.key).toBe(false);
      expect(route.body.safeParse({ code: 'abcdef' }).success, route.key).toBe(false);
    }
  });
});
