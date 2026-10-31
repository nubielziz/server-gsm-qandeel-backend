// Unit tests of the per-IP limiter classification: which public requests are counted, and against which limiter.
import { describe, expect, it } from 'bun:test';
import type { AccessKind } from '../../common/contract';
import { publicLimiterFor } from './public-ip-limit';

describe('publicLimiterFor', () => {
  it('counts every storefront request against the ip limiter, matched or not', () => {
    expect(publicLimiterFor('/store/v1/services', 'public')).toBe('ip');
    expect(publicLimiterFor('/store/v1/me', 'customer-session')).toBe('ip');
    expect(publicLimiterFor('/store/v1/nope', undefined)).toBe('ip');
  });

  it('counts token routes against the stricter token limiter', () => {
    for (const access of ['checkout-token', 'tracking-token', 'ticket-token', 'link-token'] as const) {
      expect(publicLimiterFor('/store/v1/orders/:token', access), access).toBe('token');
    }
  });

  it('counts only the public routes of the admin console and the merchant portal (sign-in, registration, password)', () => {
    expect(publicLimiterFor('/admin/auth/login', 'public')).toBe('ip');
    expect(publicLimiterFor('/client/auth/register', 'public')).toBe('ip');
    expect(publicLimiterFor('/admin/staff', 'staff-permission')).toBeUndefined();
    expect(publicLimiterFor('/admin/auth/me', 'staff-session')).toBeUndefined();
    expect(publicLimiterFor('/client/orders', 'merchant-session')).toBeUndefined();
    expect(publicLimiterFor('/admin/nope', undefined)).toBeUndefined();
  });

  it('leaves REST v1, Dhru, webhooks and the system routes to their own limits', () => {
    const accesses: Array<AccessKind | undefined> = [
      'public',
      'api-key',
      'dhru-credentials',
      'gateway-signature',
      undefined,
    ];
    for (const access of accesses) {
      for (const path of [
        '/v1/orders',
        '/api/index.php',
        '/webhooks/payments/:gateway',
        '/health',
        '/metrics',
        '/docs',
      ]) {
        expect(publicLimiterFor(path, access), `${path} ${String(access)}`).toBeUndefined();
      }
    }
  });
});
