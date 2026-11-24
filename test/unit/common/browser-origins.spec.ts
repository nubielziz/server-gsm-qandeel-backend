// Unit tests for the origins each surface trusts (decision 045): the audience of a path, and the CORS decision of one request.
import { describe, expect, it } from 'bun:test';
import {
  CORS_ALLOWED_HEADERS,
  CORS_EXPOSED_HEADERS,
  CORS_METHODS,
  audienceOfPath,
  audienceOfSurface,
  corsDecision,
  originsOf,
} from '@src/common/browser-origins';

const CONSOLE = 'https://console.example.com';
const SHOP = 'https://shop.example.com';
const lists = { consoleOrigins: [CONSOLE], shopOrigins: [SHOP] };

describe('audienceOfPath', () => {
  it('maps the staff paths to the console, the merchant and shop paths to the shop, and every other path to nobody', () => {
    for (const path of [
      '/admin',
      '/admin/auth/me',
      '/admin/queues',
      '/admin/queues/api/queues',
      '/admin/stream',
      '/reference',
      '/reference/openapi.json',
    ]) {
      expect(audienceOfPath(path), path).toBe('console');
    }
    for (const path of ['/client/auth/me', '/client/stream', '/store/v1/me', '/store/v1/auth/verify']) {
      expect(audienceOfPath(path), path).toBe('shop');
    }
    for (const path of [
      '/api/index.php',
      '/webhooks/stripe',
      '/health',
      '/metrics',
      '/docs',
      '/openapi.json',
      '/t/items',
      '/referencex',
      '/administrator',
      '/store/v2/x',
      '/',
      '',
    ]) {
      expect(audienceOfPath(path), path).toBeUndefined();
    }
  });

  it('maps contract surfaces the same way', () => {
    expect(audienceOfSurface('admin')).toBe('console');
    expect(audienceOfSurface('client')).toBe('shop');
    expect(audienceOfSurface('store')).toBe('shop');
    for (const surface of ['dhru', 'hooks', 'system'] as const) expect(audienceOfSurface(surface)).toBeUndefined();
  });
});

describe('originsOf', () => {
  it('picks the list of the audience, and nothing for no audience', () => {
    expect(originsOf(lists, 'console')).toEqual([CONSOLE]);
    expect(originsOf(lists, 'shop')).toEqual([SHOP]);
    expect(originsOf(lists, undefined)).toEqual([]);
  });
});

describe('corsDecision', () => {
  it('grants exactly a listed origin of the path audience, with credentials, the methods, the headers, the exposed headers and the cache time', () => {
    expect(corsDecision(lists, '/admin/auth/me', CONSOLE)).toEqual({
      origin: CONSOLE,
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
      allowedHeaders: ['Content-Type', 'X-CSRF-Token', 'Idempotency-Key', 'Accept'],
      exposedHeaders: ['x-total-count', 'x-request-id', 'x-csrf-token', 'retry-after', 'content-disposition'],
      maxAge: 600,
      strictPreflight: false,
    });
    expect(corsDecision(lists, '/store/v1/me', SHOP)).toEqual({
      origin: SHOP,
      credentials: true,
      methods: [...CORS_METHODS],
      allowedHeaders: [...CORS_ALLOWED_HEADERS],
      exposedHeaders: [...CORS_EXPOSED_HEADERS],
      maxAge: 600,
      strictPreflight: false,
    });
    expect(corsDecision(lists, '/reference', CONSOLE)).toMatchObject({ origin: CONSOLE });
    expect(corsDecision(lists, '/client/auth/me', SHOP)).toMatchObject({ origin: SHOP });
  });

  it('refuses everything else', () => {
    const refused = { origin: false } as const;
    expect(corsDecision(lists, '/admin/auth/me', SHOP)).toEqual(refused);
    expect(corsDecision(lists, '/reference', SHOP)).toEqual(refused);
    expect(corsDecision(lists, '/client/auth/me', CONSOLE)).toEqual(refused);
    expect(corsDecision(lists, '/store/v1/me', CONSOLE)).toEqual(refused);
    for (const path of ['/health', '/webhooks/x', '/api/index.php', '/docs']) {
      expect(corsDecision(lists, path, CONSOLE), path).toEqual(refused);
      expect(corsDecision(lists, path, SHOP), path).toEqual(refused);
    }
    for (const origin of [
      'https://evil.example',
      'null',
      `${CONSOLE}/`,
      `${CONSOLE}.evil.example`,
      'http://console.example.com',
      '',
    ]) {
      expect(corsDecision(lists, '/admin/auth/me', origin), origin).toEqual(refused);
    }
    expect(corsDecision(lists, '/admin/auth/me', undefined)).toEqual(refused);
  });

  it('grants nothing to an audience without origins', () => {
    const none = { consoleOrigins: [], shopOrigins: [] };
    for (const path of ['/admin/auth/me', '/reference', '/client/auth/me', '/store/v1/me', '/health']) {
      expect(corsDecision(none, path, CONSOLE), path).toEqual({ origin: false });
      expect(corsDecision(none, path, SHOP), path).toEqual({ origin: false });
    }
  });
});
