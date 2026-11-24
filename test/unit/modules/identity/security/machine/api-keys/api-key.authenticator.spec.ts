// Unit tests of the API key authenticator with a fake key directory and a fake rate limiter: the order of the steps, what is
// counted against which budget, and that a failed "last used" write never fails the request.
import { describe, expect, it } from 'bun:test';
import type { FastifyRequest } from 'fastify';
import { AppError } from '@src/common/errors';
import type { RateLimitService } from '@src/infra/rate-limit';
import type { ApiKeyDirectory } from '@src/modules/identity/security/machine/api-keys/api-key.directory';
import { ApiKeyAuthenticator } from '@src/modules/identity/security/machine/api-keys/api-key.authenticator';
import type { ApiKeyView } from '@src/modules/identity/security/machine/api-keys/api-key.rules';
import { TestClock } from '../../../../../../support/clock';
import { rejectionOf } from '../../../../../../support/rejection';

const view = (over: Partial<ApiKeyView> = {}): ApiKeyView => ({
  id: 7,
  keyHash: 'h'.repeat(64),
  clientId: 3,
  allowedIps: [],
  rateLimitPerMin: 25,
  lastUsedAtMs: null,
  expiresAtMs: null,
  revokedAtMs: null,
  client: { username: 'Acme', name: 'Acme Trading', status: 'active', rankKind: 'merchant' },
  ...over,
});
const request = (ip = '203.0.113.9') => ({ ip }) as unknown as FastifyRequest;

interface Setup {
  readonly authenticator: ApiKeyAuthenticator;
  readonly lookups: string[];
  readonly cachedLookups: string[];
  readonly consumed: { name: string; key: string; points: number }[];
  readonly enforced: { name: string; key: string; points: number; options: unknown }[];
  readonly peeked: { name: string; key: string }[];
  readonly touches: string[];
}

function setup(
  found: ApiKeyView | undefined,
  options: {
    failureAllowed?: boolean;
    keyAllowed?: boolean;
    touchFails?: boolean;
    peekAllowed?: boolean;
    cached?: ApiKeyView;
  } = {},
): Setup {
  const lookups: string[] = [];
  const cachedLookups: string[] = [];
  const consumed: Setup['consumed'] = [];
  const enforced: Setup['enforced'] = [];
  const peeked: Setup['peeked'] = [];
  const touches: string[] = [];
  const directory = {
    findByKey: (key: string) => {
      lookups.push(key);
      return Promise.resolve(found);
    },
    // The cache alone: what an address that used up its budget is answered from (decision 053).
    findCached: (key: string) => {
      cachedLookups.push(key);
      return Promise.resolve(options.cached);
    },
    touch: (_view: ApiKeyView, ip: string) => {
      touches.push(ip);
      return options.touchFails ? Promise.reject(new Error('database is down')) : Promise.resolve(true);
    },
  } as unknown as ApiKeyDirectory;
  const limits = {
    // Decision 053: the unknown-key budget of the address is read before the key is looked up.
    peek: (name: string, key: string) => {
      peeked.push({ name, key });
      return Promise.resolve({
        allowed: options.peekAllowed ?? true,
        remaining: 300,
        limit: 300,
        retryAfterSeconds: options.peekAllowed === false ? 33 : 0,
        resetSeconds: 33,
      });
    },
    consume: (name: string, key: string, points = 1, opts?: unknown) => {
      // The key's own limit (`api-key`) is counted after every check passed; the `ip` limiter counts unknown keys.
      if (name === 'api-key') {
        enforced.push({ name, key, points, options: opts });
        return Promise.resolve({
          allowed: options.keyAllowed ?? true,
          remaining: 1,
          limit: 25,
          retryAfterSeconds: options.keyAllowed === false ? 17 : 0,
          resetSeconds: 17,
        });
      }
      consumed.push({ name, key, points });
      return Promise.resolve({
        allowed: options.failureAllowed ?? true,
        remaining: 0,
        limit: 300,
        retryAfterSeconds: 42,
        resetSeconds: 42,
      });
    },
  } as unknown as RateLimitService;
  return {
    authenticator: new ApiKeyAuthenticator(directory, limits, new TestClock('2026-11-01T10:00:00.000Z')),
    lookups,
    cachedLookups,
    consumed,
    enforced,
    peeked,
    touches,
  };
}

describe('ApiKeyAuthenticator', () => {
  it("answers 429 with Retry-After when the key's own limit refuses the call, and does not record it as a use of the key", async () => {
    const s = setup(view(), { keyAllowed: false });
    const error = await rejectionOf(s.authenticator.authenticate(request(), { key: 'the-key' }));
    expect(error).toMatchObject({ code: 'RATE_LIMITED', status: 429, retryAfterSeconds: 17 });
    expect(s.touches).toEqual([]);
  });

  it("returns the principal and counts the call against the key's own limit", async () => {
    const s = setup(view());
    const principal = await s.authenticator.authenticate(request(), { key: 'the-key' });
    expect(principal).toEqual({
      kind: 'api-key',
      clientId: 3,
      clientName: 'Acme Trading',
      keyId: 7,
      ip: '203.0.113.9',
    });
    expect(s.enforced).toEqual([{ name: 'api-key', key: '7', points: 1, options: { limit: 25 } }]);
    expect(s.consumed).toEqual([]);
    expect(s.touches).toEqual(['203.0.113.9']);
  });

  it('answers 429 before the lookup once the address used its unknown-key budget and the cache holds no view of the key (decision 053)', async () => {
    const s = setup(view(), { peekAllowed: false });
    const error = await rejectionOf(s.authenticator.authenticate(request(), { key: 'the-key' }));
    expect(error).toMatchObject({ code: 'RATE_LIMITED', status: 429, retryAfterSeconds: 33 });
    expect(s.peeked).toEqual([{ name: 'ip', key: 'api-key-failures:203.0.113.9' }]);
    // No database lookup, only the cache, and nothing is charged for the refused call.
    expect(s.lookups).toEqual([]);
    expect(s.cachedLookups).toEqual(['the-key']);
    expect(s.consumed).toEqual([]);
    expect(s.enforced).toEqual([]);
  });

  it('serves a key whose view is cached while the address has used up its unknown-key budget, without a database lookup', async () => {
    const s = setup(undefined, { peekAllowed: false, cached: view() });
    const principal = await s.authenticator.authenticate(request(), { key: 'the-key' });
    expect(principal).toMatchObject({ kind: 'api-key', clientId: 3, keyId: 7 });
    expect(s.lookups).toEqual([]);
    expect(s.cachedLookups).toEqual(['the-key']);
    // The key's own limit still counts the call, and its use is recorded.
    expect(s.enforced).toEqual([{ name: 'api-key', key: '7', points: 1, options: { limit: 25 } }]);
    expect(s.consumed).toEqual([]);
    expect(s.touches).toEqual(['203.0.113.9']);
  });

  it('judges a cached key like a looked-up one while the budget is used up: its refusals stay', async () => {
    const s = setup(undefined, { peekAllowed: false, cached: view({ revokedAtMs: 1 }) });
    expect(await rejectionOf(s.authenticator.authenticate(request(), { key: 'k' }))).toMatchObject({
      code: 'UNAUTHORIZED',
    });
    expect(s.consumed).toEqual([]);
  });

  it("charges a Dhru username that is not the cached key's while the budget is used up, and answers 429", async () => {
    const s = setup(undefined, { peekAllowed: false, failureAllowed: false, cached: view() });
    const error = await rejectionOf(s.authenticator.authenticate(request(), { key: 'k', username: 'other' }));
    expect(error).toMatchObject({ code: 'RATE_LIMITED', status: 429, retryAfterSeconds: 42 });
    expect(s.consumed).toEqual([{ name: 'ip', key: 'api-key-failures:203.0.113.9', points: 1 }]);
    expect(s.enforced).toEqual([]);
  });

  it('looks a key up in the database, not the cache alone, while the address has budget left', async () => {
    const s = setup(view(), { cached: view() });
    await s.authenticator.authenticate(request(), { key: 'the-key' });
    expect(s.lookups).toEqual(['the-key']);
    expect(s.cachedLookups).toEqual([]);
  });

  it('reads the budget of an address by its /64 network before the lookup, and a call without a key reads nothing', async () => {
    const s = setup(view());
    await s.authenticator.authenticate(request('2001:db8:1:2:aaaa::1'), { key: 'the-key' });
    expect(s.peeked).toEqual([{ name: 'ip', key: 'api-key-failures:2001:db8:1:2::/64' }]);
    const none = setup(view());
    await rejectionOf(none.authenticator.authenticate(request(), { key: undefined }));
    expect(none.peeked).toEqual([]);
  });

  it("charges the points of a bulk placement in one count, at most the key's own limit (decision 053)", async () => {
    const eight = setup(view());
    await eight.authenticator.authenticate(request(), { key: 'k', points: 8 });
    expect(eight.enforced[0]).toMatchObject({ points: 8, options: { limit: 25 } });
    const over = setup(view());
    await over.authenticator.authenticate(request(), { key: 'k', points: 100 });
    expect(over.enforced[0]?.points).toBe(25);
    const defaulted = setup(view({ rateLimitPerMin: 0 }));
    await defaulted.authenticator.authenticate(request(), { key: 'k', points: 100 });
    // A stored limit of 0 is a data error: the limiter's default (60) is the cap.
    expect(defaulted.enforced[0]?.points).toBe(60);
    for (const points of [undefined, 0, -3, Number.NaN]) {
      const s = setup(view());
      await s.authenticator.authenticate(request(), { key: 'k', points });
      expect(s.enforced[0]?.points, String(points)).toBe(1);
    }
  });

  it('refuses a request without a key without a lookup and without charging anything', async () => {
    const s = setup(view());
    expect(await rejectionOf(s.authenticator.authenticate(request(), { key: undefined }))).toMatchObject({
      code: 'UNAUTHORIZED',
    });
    expect(s.lookups).toEqual([]);
    expect(s.consumed).toEqual([]);
  });

  it('charges the address for an unknown key, under a key of its own, and refuses with 401', async () => {
    const s = setup(undefined);
    expect(await rejectionOf(s.authenticator.authenticate(request(), { key: 'nope' }))).toMatchObject({
      code: 'UNAUTHORIZED',
      status: 401,
    });
    expect(s.consumed).toEqual([{ name: 'ip', key: 'api-key-failures:203.0.113.9', points: 1 }]);
    expect(s.enforced).toEqual([]);
  });

  it('answers 429 with the wait when the address has used up its budget of unknown keys', async () => {
    const s = setup(undefined, { failureAllowed: false });
    const refusal: unknown = await s.authenticator.authenticate(request(), { key: 'nope' }).catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(AppError);
    expect(refusal).toMatchObject({ code: 'RATE_LIMITED', status: 429, retryAfterSeconds: 42 });
  });

  it('charges the address of an IPv6 client by its /64, like the per-IP limiter', async () => {
    const s = setup(undefined);
    await s.authenticator.authenticate(request('2001:db8:1:2:aaaa::1'), { key: 'nope' }).catch(() => undefined);
    expect(s.consumed[0]?.key).toBe('api-key-failures:2001:db8:1:2::/64');
  });

  it("counts a Dhru username that is not the key's as a failure, and compares it case-insensitively", async () => {
    const wrong = setup(view());
    expect(
      await rejectionOf(wrong.authenticator.authenticate(request(), { key: 'k', username: 'other' })),
    ).toMatchObject({ code: 'UNAUTHORIZED', detail: 'Authentication Failed' });
    expect(wrong.consumed).toHaveLength(1);
    expect(wrong.enforced).toEqual([]);

    const right = setup(view());
    await right.authenticator.authenticate(request(), { key: 'k', username: ' aCME ' });
    expect(right.consumed).toEqual([]);
    expect(right.enforced).toHaveLength(1);
  });

  it("does not charge the failure budget, nor the key's limit, for a known key that is refused", async () => {
    for (const [found, code] of [
      [view({ revokedAtMs: 1 }), 'UNAUTHORIZED'],
      [view({ allowedIps: ['10.0.0.0/8'] }), 'IP_NOT_ALLOWED'],
      [
        view({ client: { username: 'Acme', name: 'Acme Trading', status: 'suspended', rankKind: 'merchant' } }),
        'ACCOUNT_SUSPENDED',
      ],
      [
        view({ client: { username: 'Acme', name: 'Acme Trading', status: 'blocked', rankKind: 'merchant' } }),
        'ACCOUNT_SUSPENDED',
      ],
      [
        view({ client: { username: 'Acme', name: 'Acme Trading', status: 'anonymized', rankKind: 'merchant' } }),
        'UNAUTHORIZED',
      ],
      [
        view({ client: { username: 'Acme', name: 'Acme Trading', status: 'active', rankKind: 'retail' } }),
        'UNAUTHORIZED',
      ],
    ] as const) {
      const s = setup(found);
      expect(await rejectionOf(s.authenticator.authenticate(request(), { key: 'k' }))).toMatchObject({
        code,
      });
      expect(s.consumed, code).toEqual([]);
      expect(s.enforced, code).toEqual([]);
      expect(s.touches, code).toEqual([]);
    }
  });

  it('refuses a key of an account that is not of a merchant rank in the Authentication Failed envelope, and charges nothing', async () => {
    const s = setup(view({ client: { username: 'Acme', name: 'Acme Trading', status: 'active', rankKind: 'retail' } }));
    expect(await rejectionOf(s.authenticator.authenticate(request(), { key: 'k', username: 'Acme' }))).toMatchObject({
      code: 'UNAUTHORIZED',
      status: 401,
      detail: 'Authentication Failed',
    });
    expect(s.consumed).toEqual([]);
    expect(s.enforced).toEqual([]);
    expect(s.touches).toEqual([]);
  });

  it('refuses every username for an account that has none (a retail account), charged like an unknown key', async () => {
    const s = setup(view({ client: { username: null, name: 'Retail Buyer', status: 'active', rankKind: 'retail' } }));
    for (const username of ['', ' ', 'null', 'Acme']) {
      expect(await rejectionOf(s.authenticator.authenticate(request(), { key: 'k', username }))).toMatchObject({
        code: 'UNAUTHORIZED',
        detail: 'Authentication Failed',
      });
    }
    expect(s.consumed).toHaveLength(4);
    expect(s.enforced).toEqual([]);
  });

  it("uses the limiter's default when the stored limit is not a positive whole number", async () => {
    for (const rateLimitPerMin of [0, -5, 1.5, Number.NaN]) {
      const s = setup(view({ rateLimitPerMin }));
      await s.authenticator.authenticate(request(), { key: 'k' });
      expect(s.enforced[0]?.options, String(rateLimitPerMin)).toEqual({});
    }
  });

  it('prints the address the way a person writes it when it records the use', async () => {
    const s = setup(view());
    await s.authenticator.authenticate(request('::ffff:203.0.113.9'), { key: 'k' });
    expect(s.touches).toEqual(['203.0.113.9']);
  });

  it('does not fail the request when recording the use fails', async () => {
    const s = setup(view(), { touchFails: true });
    expect(await s.authenticator.authenticate(request(), { key: 'k' })).toMatchObject({ keyId: 7 });
  });
});
