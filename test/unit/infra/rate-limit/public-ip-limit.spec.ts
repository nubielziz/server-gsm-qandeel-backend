// Unit tests of the per-IP limiter classification: which public requests are counted, and against which limiter.
import { describe, expect, it } from 'bun:test';
import type { AccessKind } from '@src/common/contract';
import { LARGE_BODY_BYTES, isLargeBody, publicLimiterFor } from '@src/infra/rate-limit/public-ip-limit';

describe('publicLimiterFor', () => {
  it('counts every storefront request against the ip limiter, matched or not', () => {
    expect(publicLimiterFor('/store/v1/services', 'public')).toBe('ip');
    expect(publicLimiterFor('/store/v1/me', 'customer-session')).toBe('ip');
    expect(publicLimiterFor('/store/v1/nope', undefined)).toBe('ip');
    // Feature 21: a multipart or large body on the store (the receipt upload) costs an upload point instead.
    expect(publicLimiterFor('/store/v1/files', 'customer-session', true)).toBe('upload');
    expect(publicLimiterFor('/store/v1/files', 'customer-session')).toBe('ip');
  });

  it('counts token routes against the stricter token limiter', () => {
    for (const access of ['checkout-token', 'tracking-token', 'ticket-token', 'link-token'] as const) {
      expect(publicLimiterFor('/store/v1/orders/:token', access), access).toBe('token');
    }
  });

  it('counts the typing pings and read marks of a ticket page against ticket-chat, never against token (feature 28)', () => {
    expect(publicLimiterFor('/store/v1/tickets/:token/typing', 'ticket-token')).toBe('ticket-chat');
    expect(publicLimiterFor('/store/v1/tickets/:token/read', 'ticket-token')).toBe('ticket-chat');
    expect(publicLimiterFor('/store/v1/tickets/:token', 'ticket-token')).toBe('token');
    expect(publicLimiterFor('/store/v1/tickets/:token/messages', 'ticket-token')).toBe('token');
    expect(publicLimiterFor('/store/v1/tickets/:token/stream', 'ticket-token')).toBe('token');
    // Only a ticket-token route: an unknown path that looks like one is a plain store request.
    expect(publicLimiterFor('/store/v1/tickets/abc/typing', undefined)).toBe('ip');
    // The attachment upload is multipart: it costs an upload point like any large body.
    expect(publicLimiterFor('/store/v1/tickets/:token/files', 'ticket-token', true)).toBe('upload');
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
    // The public routes keep their own limiter.
    expect(publicLimiterFor('/client/auth/login', 'public', true)).toBe('ip');
  });

  it('counts every incoming webhook against webhook-intake, matched or not', () => {
    for (const largeBody of [false, true]) {
      expect(publicLimiterFor('/webhooks/payments/:gateway', 'gateway-signature', largeBody)).toBe('webhook-intake');
      expect(publicLimiterFor('/webhooks/disputes/:gateway', 'gateway-signature', largeBody)).toBe('webhook-intake');
      expect(publicLimiterFor('/webhooks/telegram/:secret', 'url-secret', largeBody)).toBe('webhook-intake');
      expect(publicLimiterFor('/webhooks/nope', undefined, largeBody)).toBe('webhook-intake');
      expect(publicLimiterFor('/webhooks', undefined, largeBody)).toBe('webhook-intake');
    }
    expect(publicLimiterFor('/webhooksx/nope', undefined)).toBeUndefined();
  });

  it('counts a large body on an admin session route (the service picture upload) against upload', () => {
    expect(publicLimiterFor('/admin/service-listings/:id/image', 'staff-permission', true)).toBe('upload');
    expect(publicLimiterFor('/admin/staff', 'staff-permission', true)).toBe('upload');
    expect(publicLimiterFor('/admin/service-listings/:id/image', 'staff-permission', false)).toBeUndefined();
  });

  it('counts the search-as-you-type route against its own limiter and the results route against ip', () => {
    expect(publicLimiterFor('/store/v1/search/suggest', 'public')).toBe('search-suggest');
    expect(publicLimiterFor('/store/v1/search/suggest', undefined)).toBe('search-suggest');
    expect(publicLimiterFor('/store/v1/search', 'public')).toBe('ip');
    expect(publicLimiterFor('/store/v1/search/suggestions', 'public')).toBe('ip');
  });

  it('counts the public pictures against their own media limiter, matched or not', () => {
    expect(publicLimiterFor('/store/v1/media/:name', 'public')).toBe('media');
    expect(publicLimiterFor('/store/v1/media/../../kyc', undefined)).toBe('media');
    expect(publicLimiterFor('/store/v1/mediax', 'public')).toBe('ip');
  });

  it('calls a body large when it is multipart, longer than 1 MiB, or of an unreadable length', () => {
    expect(isLargeBody('multipart/form-data; boundary=x', '100')).toBe(true);
    expect(isLargeBody('application/x-www-form-urlencoded', String(LARGE_BODY_BYTES + 1))).toBe(true);
    expect(isLargeBody('application/x-www-form-urlencoded', String(LARGE_BODY_BYTES))).toBe(false);
    expect(isLargeBody('application/json', 'abc')).toBe(true);
    expect(isLargeBody('application/json', undefined)).toBe(false);
    expect(isLargeBody(undefined, undefined)).toBe(false);
  });

  it('reads a multipart type the way the body parser does: leading whitespace does not hide it', () => {
    // A chunked body of a type that starts with U+00A0 is still read by the multipart parser, up to 25 MiB.
    expect(isLargeBody('\u00a0multipart/form-data; boundary=x', undefined)).toBe(true);
    expect(isLargeBody('\u000b\u00a0Multipart/Form-Data', undefined)).toBe(true);
    expect(isLargeBody('\u00a0application/json', undefined)).toBe(false);
  });

  it('calls a form body without a length large on a route with a raised form limit (the Dhru endpoint), and no other body', () => {
    expect(isLargeBody('application/x-www-form-urlencoded', undefined, true)).toBe(true);
    // A body that declares a small length is bounded by it, whatever the route.
    expect(isLargeBody('application/x-www-form-urlencoded', '100', true)).toBe(false);
  });

  it('leaves REST v1, Dhru and the system routes to their own limits', () => {
    const accesses: Array<AccessKind | undefined> = [
      'public',
      'api-key',
      'dhru-credentials',
      'gateway-signature',
      undefined,
    ];
    for (const access of accesses) {
      for (const path of ['/v1/orders', '/api/index.php', '/health', '/metrics', '/docs']) {
        expect(publicLimiterFor(path, access), `${path} ${String(access)}`).toBeUndefined();
      }
    }
  });
});
