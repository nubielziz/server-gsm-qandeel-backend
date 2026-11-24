// Unit tests of the IP audience mapping: which rule scopes reach which path, and the probe paths nothing judges.
import { describe, expect, it } from 'bun:test';
import { SHARED_SIGN_IN_PATHS, ipAudienceOf } from '@src/modules/identity/security/ip-rules/ip-audience';

describe('ipAudienceOf', () => {
  it('maps each surface to the audience of the rule scopes', () => {
    expect(ipAudienceOf('/admin/staff/:id')).toBe('admin');
    expect(ipAudienceOf('/admin')).toBe('admin');
    expect(ipAudienceOf('/store/v1/checkout-sessions/:token/pay')).toBe('store');
    expect(ipAudienceOf('/api/index.php')).toBe('api');
    // The retired REST API v1 left no audience of its own.
    expect(ipAudienceOf('/v1/orders')).toBe('other');
  });

  it('leaves the merchant portal and the documentation to the "all" rules', () => {
    expect(ipAudienceOf('/client/orders')).toBe('other');
    expect(ipAudienceOf('/docs')).toBe('other');
    expect(ipAudienceOf('/openapi.json')).toBe('other');
    expect(ipAudienceOf('/reference/openapi.json')).toBe('other');
    expect(ipAudienceOf('/nope')).toBe('other');
  });

  it('gives the eight sign-in routes every account shares both audiences, store and other (decision 064)', () => {
    expect(SHARED_SIGN_IN_PATHS).toHaveLength(8);
    expect([...SHARED_SIGN_IN_PATHS].sort()).toEqual(
      [
        '/client/auth/2fa',
        '/client/auth/login',
        '/client/auth/logout',
        '/client/auth/password/change',
        '/client/auth/password/forgot',
        '/client/auth/password/reset',
        '/client/auth/sign-in',
        '/client/auth/verify-email',
      ].sort(),
    );
    for (const path of SHARED_SIGN_IN_PATHS) expect(ipAudienceOf(path), path).toEqual(['store', 'other']);
  });

  it('leaves the other routes of the merchant portal, also under /client/auth, to the "all" rules', () => {
    for (const path of [
      '/client/auth/me',
      '/client/auth/verify-email/resend',
      '/client/auth/sign-in/extra',
      '/client/security/password',
      '/client/auth',
    ]) {
      expect(ipAudienceOf(path), path).toBe('other');
    }
  });

  it('never judges signed incoming webhooks (B118)', () => {
    expect(ipAudienceOf('/webhooks/payments/:gateway')).toBeUndefined();
  });

  it('does not mistake a longer name for a surface', () => {
    expect(ipAudienceOf('/administrator')).toBe('other');
    expect(ipAudienceOf('/store/v10/x')).toBe('other');
    expect(ipAudienceOf('/v1x/orders')).toBe('other');
  });

  it('never judges the probes', () => {
    expect(ipAudienceOf('/health')).toBeUndefined();
    expect(ipAudienceOf('/metrics')).toBeUndefined();
    expect(ipAudienceOf('/health/deep')).toBe('other');
  });
});
