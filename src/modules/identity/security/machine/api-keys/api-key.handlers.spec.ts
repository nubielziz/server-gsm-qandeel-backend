// Unit tests of the credential readers of the API key handlers: the Bearer header (REST v1) and username + apiaccesskey (Dhru).
import { describe, expect, it } from 'bun:test';
import type { FastifyRequest } from 'fastify';
import type { AnyRouteContract } from '../../../../../common/contract';
import { AppError } from '../../../../../common/errors';
import type { ApiKeyAuthenticator, ApiKeyCredentials } from './api-key.authenticator';
import { ApiKeyAccessHandler, DhruCredentialsAccessHandler, bearerKeyOf, dhruCredentialsOf } from './api-key.handlers';
import { rejectionOf } from '../../../../../../test/support/rejection';

describe('bearerKeyOf', () => {
  it('reads the key of a Bearer header, whatever the case of the scheme', () => {
    expect(bearerKeyOf('Bearer gsm_abc123')).toBe('gsm_abc123');
    expect(bearerKeyOf('bearer gsm_abc123')).toBe('gsm_abc123');
    expect(bearerKeyOf('BEARER   gsm_abc123  ')).toBe('gsm_abc123');
  });

  it('reads nothing from another scheme, an empty key or extra words', () => {
    for (const header of [undefined, '', 'Bearer', 'Bearer ', 'Basic abc', 'Token abc', 'Bearer a b', 'gsm_abc123']) {
      expect(bearerKeyOf(header), String(header)).toBeUndefined();
    }
  });
});

describe('dhruCredentialsOf', () => {
  it('reads username and apiaccesskey, trimmed', () => {
    expect(dhruCredentialsOf({ username: ' acme ', apiaccesskey: ' KEY ', action: 'accountinfo' })).toEqual({
      username: 'acme',
      apiAccessKey: 'KEY',
    });
  });

  it('reads nothing when a credential is missing, empty, repeated or not text', () => {
    for (const body of [
      undefined,
      null,
      'username=a&apiaccesskey=b',
      [],
      {},
      { username: 'a' },
      { apiaccesskey: 'b' },
      { username: '', apiaccesskey: 'b' },
      { username: 'a', apiaccesskey: '  ' },
      { username: ['a', 'b'], apiaccesskey: 'b' },
      { username: 'a', apiaccesskey: 12345 },
    ]) {
      expect(dhruCredentialsOf(body), JSON.stringify(body)).toBeUndefined();
    }
  });
});

/** An authenticator that records what the handlers ask it. */
function recorder() {
  const calls: ApiKeyCredentials[] = [];
  const authenticator = {
    authenticate(_request: FastifyRequest, credentials: ApiKeyCredentials) {
      calls.push(credentials);
      return Promise.resolve({ kind: 'api-key', clientId: 1, keyId: 2, scopes: [], ip: '1.2.3.4' });
    },
  } as unknown as ApiKeyAuthenticator;
  return { authenticator, calls };
}

describe('ApiKeyAccessHandler', () => {
  it('asks for the Bearer key with the contract permission as the scope', async () => {
    const { authenticator, calls } = recorder();
    const request = { headers: { authorization: 'Bearer gsm_key' } } as unknown as FastifyRequest;
    const contract = { permission: 'orders:write', surface: 'v1' } as AnyRouteContract;
    const state = await new ApiKeyAccessHandler(authenticator).authenticate(request, contract);
    expect(state.principal).toMatchObject({ kind: 'api-key', keyId: 2 });
    expect(calls).toEqual([{ key: 'gsm_key', scope: 'orders:write', surface: 'v1' }]);
  });

  it('asks for a scope no key has when the contract names none (a route without one cannot exist)', async () => {
    const { authenticator, calls } = recorder();
    const request = { headers: {} } as unknown as FastifyRequest;
    await new ApiKeyAccessHandler(authenticator).authenticate(request, {
      permission: null,
      surface: 'v1',
    } as AnyRouteContract);
    expect(calls[0]).toEqual({ key: undefined, scope: '', surface: 'v1' });
  });
});

describe('DhruCredentialsAccessHandler', () => {
  it('asks for the dhru scope with the username and key of the body', async () => {
    const { authenticator, calls } = recorder();
    const request = { body: { username: 'acme', apiaccesskey: 'KEY' } } as unknown as FastifyRequest;
    await new DhruCredentialsAccessHandler(authenticator).authenticate(request, {
      surface: 'dhru',
    } as AnyRouteContract);
    expect(calls).toEqual([{ key: 'KEY', username: 'acme', scope: 'dhru', surface: 'dhru' }]);
  });

  it('presents no key at all when either credential is missing', async () => {
    const { authenticator, calls } = recorder();
    const request = { body: { username: 'acme' } } as unknown as FastifyRequest;
    await new DhruCredentialsAccessHandler(authenticator).authenticate(request, {
      surface: 'dhru',
    } as AnyRouteContract);
    expect(calls[0]).toEqual({ key: undefined, username: undefined, scope: 'dhru', surface: 'dhru' });
  });

  it("lets the authenticator's refusal through", async () => {
    const authenticator = {
      authenticate: () => Promise.reject(new AppError('UNAUTHORIZED', { detail: 'Authentication Failed' })),
    } as unknown as ApiKeyAuthenticator;
    const request = { body: {} } as unknown as FastifyRequest;
    const refusal = new DhruCredentialsAccessHandler(authenticator).authenticate(request, {
      surface: 'dhru',
    } as AnyRouteContract);
    expect(await rejectionOf(refusal)).toMatchObject({ code: 'UNAUTHORIZED' });
  });
});
