// Unit tests of the API key authenticator with a fake key directory and a fake rate limiter: the order of the steps, what is
// counted against which budget, and that a failed "last used" write never fails the request.
import { describe, expect, it } from 'bun:test';
import type { FastifyRequest } from 'fastify';
import { AppError } from '../../../../../common/errors';
import type { RateLimitService } from '../../../../../infra/rate-limit';
import type { ApiKeyDirectory } from './api-key.directory';
import { ApiKeyAuthenticator } from './api-key.authenticator';
import type { ApiKeyView } from './api-key.rules';
import { TestClock } from '../../../../../../test/support/clock';
import { rejectionOf } from '../../../../../../test/support/rejection';

const view = (over: Partial<ApiKeyView> = {}): ApiKeyView => ({
  id: 7,
  keyHash: 'h'.repeat(64),
  clientId: 3,
  scopes: ['orders:read', 'dhru'],
  allowedIps: [],
  rateLimitPerMin: 25,
  lastUsedAtMs: null,
  expiresAtMs: null,
  revokedAtMs: null,
  client: { username: 'Acme', name: 'Acme Trading', status: 'active' },
  ...over,
});
const request = (ip = '203.0.113.9') => ({ ip }) as unknown as FastifyRequest;

interface Setup {
  readonly authenticator: ApiKeyAuthenticator;
  readonly lookups: string[];
  readonly consumed: { name: string; key: string; points: number }[];
  readonly enforced: { name: string; key: string; options: unknown }[];
  readonly touches: string[];
}

function setup(found: ApiKeyView | undefined, options: { failureAllowed?: boolean; touchFails?: boolean } = {}): Setup {
  const lookups: string[] = [];
  const consumed: Setup['consumed'] = [];
  const enforced: Setup['enforced'] = [];
  const touches: string[] = [];
  const directory = {
    findByKey: (key: string) => {
      lookups.push(key);
      return Promise.resolve(found);
    },
    touch: (_view: ApiKeyView, ip: string) => {
      touches.push(ip);
      return options.touchFails ? Promise.reject(new Error('database is down')) : Promise.resolve(true);
    },
  } as unknown as ApiKeyDirectory;
  const limits = {
    consume: (name: string, key: string, points = 1) => {
      consumed.push({ name, key, points });
      return Promise.resolve({
        allowed: options.failureAllowed ?? true,
        remaining: 0,
        limit: 300,
        retryAfterSeconds: 42,
      });
    },
    enforce: (name: string, key: string, _points: number, opts: unknown) => {
      enforced.push({ name, key, options: opts });
      return Promise.resolve({ allowed: true, remaining: 1, limit: 25, retryAfterSeconds: 0 });
    },
  } as unknown as RateLimitService;
  return {
    authenticator: new ApiKeyAuthenticator(directory, limits, new TestClock('2026-11-01T10:00:00.000Z')),
    lookups,
    consumed,
    enforced,
    touches,
  };
}

const asking = { scope: 'orders:read', surface: 'v1' } as const;

describe('ApiKeyAuthenticator', () => {
  it("returns the principal and counts the call against the key's own limit", async () => {
    const s = setup(view());
    const principal = await s.authenticator.authenticate(request(), { ...asking, key: 'the-key' });
    expect(principal).toEqual({
      kind: 'api-key',
      clientId: 3,
      clientName: 'Acme Trading',
      keyId: 7,
      scopes: ['orders:read', 'dhru'],
      ip: '203.0.113.9',
    });
    expect(s.enforced).toEqual([{ name: 'api-key', key: '7', options: { limit: 25 } }]);
    expect(s.consumed).toEqual([]);
    expect(s.touches).toEqual(['203.0.113.9']);
  });

  it('refuses a request without a key without a lookup and without charging anything', async () => {
    const s = setup(view());
    expect(await rejectionOf(s.authenticator.authenticate(request(), { ...asking, key: undefined }))).toMatchObject({
      code: 'UNAUTHORIZED',
    });
    expect(s.lookups).toEqual([]);
    expect(s.consumed).toEqual([]);
  });

  it('charges the address for an unknown key, under a key of its own, and refuses with 401', async () => {
    const s = setup(undefined);
    expect(await rejectionOf(s.authenticator.authenticate(request(), { ...asking, key: 'nope' }))).toMatchObject({
      code: 'UNAUTHORIZED',
      status: 401,
    });
    expect(s.consumed).toEqual([{ name: 'ip', key: 'api-key-failures:203.0.113.9', points: 1 }]);
    expect(s.enforced).toEqual([]);
  });

  it('answers 429 with the wait when the address has used up its budget of unknown keys', async () => {
    const s = setup(undefined, { failureAllowed: false });
    const refusal: unknown = await s.authenticator
      .authenticate(request(), { ...asking, key: 'nope' })
      .catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(AppError);
    expect(refusal).toMatchObject({ code: 'RATE_LIMITED', status: 429, retryAfterSeconds: 42 });
  });

  it('charges the address of an IPv6 client by its /64, like the per-IP limiter', async () => {
    const s = setup(undefined);
    await s.authenticator
      .authenticate(request('2001:db8:1:2:aaaa::1'), { ...asking, key: 'nope' })
      .catch(() => undefined);
    expect(s.consumed[0]?.key).toBe('api-key-failures:2001:db8:1:2::/64');
  });

  it("counts a Dhru username that is not the key's as a failure, and compares it case-insensitively", async () => {
    const wrong = setup(view());
    expect(
      await rejectionOf(
        wrong.authenticator.authenticate(request(), { key: 'k', username: 'other', scope: 'dhru', surface: 'dhru' }),
      ),
    ).toMatchObject({ code: 'UNAUTHORIZED', detail: 'Authentication Failed' });
    expect(wrong.consumed).toHaveLength(1);
    expect(wrong.enforced).toEqual([]);

    const right = setup(view());
    await right.authenticator.authenticate(request(), { key: 'k', username: ' aCME ', scope: 'dhru', surface: 'dhru' });
    expect(right.consumed).toEqual([]);
    expect(right.enforced).toHaveLength(1);
  });

  it("does not charge the failure budget, nor the key's limit, for a known key that is refused", async () => {
    for (const [found, code] of [
      [view({ revokedAtMs: 1 }), 'UNAUTHORIZED'],
      [view({ scopes: [] }), 'FORBIDDEN'],
      [view({ allowedIps: ['10.0.0.0/8'] }), 'IP_NOT_ALLOWED'],
      [view({ client: { username: 'Acme', name: 'Acme Trading', status: 'suspended' } }), 'ACCOUNT_SUSPENDED'],
    ] as const) {
      const s = setup(found);
      expect(await rejectionOf(s.authenticator.authenticate(request(), { ...asking, key: 'k' }))).toMatchObject({
        code,
      });
      expect(s.consumed, code).toEqual([]);
      expect(s.enforced, code).toEqual([]);
      expect(s.touches, code).toEqual([]);
    }
  });

  it("uses the limiter's default when the stored limit is not a positive whole number", async () => {
    for (const rateLimitPerMin of [0, -5, 1.5, Number.NaN]) {
      const s = setup(view({ rateLimitPerMin }));
      await s.authenticator.authenticate(request(), { ...asking, key: 'k' });
      expect(s.enforced[0]?.options, String(rateLimitPerMin)).toEqual({});
    }
  });

  it('prints the address the way a person writes it when it records the use', async () => {
    const s = setup(view());
    await s.authenticator.authenticate(request('::ffff:203.0.113.9'), { ...asking, key: 'k' });
    expect(s.touches).toEqual(['203.0.113.9']);
  });

  it('does not fail the request when recording the use fails', async () => {
    const s = setup(view(), { touchFails: true });
    expect(await s.authenticator.authenticate(request(), { ...asking, key: 'k' })).toMatchObject({ keyId: 7 });
  });
});
