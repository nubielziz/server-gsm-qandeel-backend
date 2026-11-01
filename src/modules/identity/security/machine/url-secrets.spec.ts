// Unit tests of the URL secret guard: a secret stored as a hash or as plain text, a missing configuration, a route nobody
// registered a source for, and a parameter that is not a usable secret.
import { describe, expect, it } from 'bun:test';
import type { FastifyRequest } from 'fastify';
import type { AnyRouteContract } from '../../../../common/contract';
import { TokenService } from '../../../../infra/crypto';
import { parseEnv } from '../../../../config';
import { type StoredUrlSecret, UrlSecretAccessHandler, UrlSecretVerifiers } from './url-secrets';
import { rejectionOf } from '../../../../../test/support/rejection';

const tokens = new TokenService(parseEnv({ NODE_ENV: 'test' }));
const KEY = 'POST /webhooks/telegram/:secret';
const SECRET = 'tg-secret-0123456789-abcdefghij';
const contract = { key: KEY } as unknown as AnyRouteContract;
const requestWith = (params: unknown) => ({ params }) as unknown as FastifyRequest;

function handlerFor(stored: StoredUrlSecret | null | undefined, param?: string) {
  const sources = new UrlSecretVerifiers();
  sources.register({ routeKey: KEY, ...(param ? { param } : {}), load: () => stored });
  return new UrlSecretAccessHandler(sources, tokens);
}

describe('UrlSecretAccessHandler', () => {
  it('accepts the secret kept as a keyed hash, and refuses another', async () => {
    const handler = handlerFor({ form: 'hash', value: tokens.hash(SECRET) });
    expect(await handler.authenticate(requestWith({ secret: SECRET }), contract)).toEqual({});
    expect(await rejectionOf(handler.authenticate(requestWith({ secret: `${SECRET}x` }), contract))).toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });

  it('accepts the secret kept in its decrypted form, and refuses another', async () => {
    const handler = handlerFor({ form: 'secret', value: SECRET });
    expect(await handler.authenticate(requestWith({ secret: SECRET }), contract)).toEqual({});
    expect(
      await rejectionOf(handler.authenticate(requestWith({ secret: SECRET.toUpperCase() }), contract)),
    ).toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });

  it('does not take the stored hash for the secret', async () => {
    const hash = tokens.hash(SECRET);
    expect(
      await rejectionOf(
        handlerFor({ form: 'hash', value: hash }).authenticate(requestWith({ secret: hash }), contract),
      ),
    ).toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });

  it('refuses everything when nothing is configured, even the text it compares against internally', async () => {
    for (const stored of [null, undefined]) {
      const handler = handlerFor(stored);
      for (const secret of [SECRET, '', 'no-secret-is-configured-for-this-route']) {
        expect(
          await rejectionOf(handler.authenticate(requestWith({ secret }), contract)),
          String(secret),
        ).toMatchObject({
          code: 'UNAUTHORIZED',
        });
      }
    }
  });

  it('refuses a parameter that is missing, empty, too long or not text', async () => {
    const handler = handlerFor({ form: 'secret', value: '' });
    for (const secret of [undefined, '', 'x'.repeat(257), 12, ['a']]) {
      expect(
        await rejectionOf(handler.authenticate(requestWith({ secret }), contract)),
        JSON.stringify(secret),
      ).toMatchObject({
        code: 'UNAUTHORIZED',
      });
    }
    expect(await rejectionOf(handler.authenticate(requestWith(undefined), contract))).toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });

  it('reads the secret from the parameter the source names', async () => {
    const handler = handlerFor({ form: 'secret', value: SECRET }, 'key');
    expect(await handler.authenticate(requestWith({ key: SECRET }), contract)).toEqual({});
    expect(await rejectionOf(handler.authenticate(requestWith({ secret: SECRET }), contract))).toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });

  it('refuses a route nobody registered a source for', async () => {
    const handler = new UrlSecretAccessHandler(new UrlSecretVerifiers(), tokens);
    expect(await rejectionOf(handler.authenticate(requestWith({ secret: SECRET }), contract))).toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });
});

describe('UrlSecretVerifiers', () => {
  it('keeps one source per route', () => {
    const sources = new UrlSecretVerifiers();
    sources.register({ routeKey: KEY, load: () => null });
    expect(sources.get(KEY)?.routeKey).toBe(KEY);
    expect(sources.get('POST /webhooks/other/:secret')).toBeUndefined();
    expect(() => sources.register({ routeKey: KEY, load: () => null })).toThrow(/already registered/);
  });
});
