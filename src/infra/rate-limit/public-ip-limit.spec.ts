// Unit tests of the per-IP limiter classification: which public requests are counted, and against which limiter.
import { describe, expect, it } from 'bun:test';
import type { AccessKind } from '../../common/contract';
import { LARGE_BODY_BYTES, isLargeBody, publicLimiterFor } from './public-ip-limit';

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
    // The 2FA steps run on a pending session but are still counted per address (guessing codes).
    expect(publicLimiterFor('/admin/auth/2fa', 'staff-session')).toBe('ip');
    expect(publicLimiterFor('/admin/auth/2fa/setup', 'staff-session')).toBe('ip');
    expect(publicLimiterFor('/client/auth/password/set', 'public')).toBe('ip');
    expect(publicLimiterFor('/client/orders', 'merchant-session')).toBeUndefined();
    expect(publicLimiterFor('/admin/nope', undefined)).toBeUndefined();
  });

  it('counts a large body on Dhru, REST v1 and the merchant portal per IP, before the credentials are read', () => {
    expect(publicLimiterFor('/api/index.php', 'dhru-credentials', true)).toBe('upload');
    expect(publicLimiterFor('/v1/files', 'api-key', true)).toBe('upload');
    expect(publicLimiterFor('/client/files', 'merchant-session', true)).toBe('upload');
    // The public routes keep their own limiter; webhooks and probes are never counted per IP.
    expect(publicLimiterFor('/client/auth/login', 'public', true)).toBe('ip');
    expect(publicLimiterFor('/webhooks/payments/:gateway', 'gateway-signature', true)).toBeUndefined();
    expect(publicLimiterFor('/admin/staff', 'staff-permission', true)).toBeUndefined();
  });

  it('calls a body large when it is multipart, longer than 1 MiB, or of an unreadable length', () => {
    expect(isLargeBody('multipart/form-data; boundary=x', '100')).toBe(true);
    expect(isLargeBody('application/x-www-form-urlencoded', String(LARGE_BODY_BYTES + 1))).toBe(true);
    expect(isLargeBody('application/x-www-form-urlencoded', String(LARGE_BODY_BYTES))).toBe(false);
    expect(isLargeBody('application/json', 'abc')).toBe(true);
    expect(isLargeBody('application/json', undefined)).toBe(false);
    expect(isLargeBody(undefined, undefined)).toBe(false);
  });

  it('calls a form body without a length large on a route with a raised form limit (the Dhru endpoint), and no other body', () => {
    expect(isLargeBody('application/x-www-form-urlencoded', undefined, true)).toBe(true);
    // A body that declares a small length is bounded by it, whatever the route.
    expect(isLargeBody('application/x-www-form-urlencoded', '100', true)).toBe(false);
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
