// Unit tests of the credential reader of the API key handler: username + apiaccesskey (Dhru).
import { describe, expect, it } from 'bun:test';
import type { FastifyRequest } from 'fastify';
import type { AnyRouteContract } from '@src/common/contract';
import { AppError } from '@src/common/errors';
import type {
  ApiKeyAuthenticator,
  ApiKeyCredentials,
} from '@src/modules/identity/security/machine/api-keys/api-key.authenticator';
import {
  DhruCredentialsAccessHandler,
  dhruCredentialsOf,
} from '@src/modules/identity/security/machine/api-keys/api-key.handlers';
import { rejectionOf } from '../../../../../../support/rejection';

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
      return Promise.resolve({ kind: 'api-key', clientId: 1, clientName: 'Acme', keyId: 2, ip: '1.2.3.4' });
    },
  } as unknown as ApiKeyAuthenticator;
  return { authenticator, calls };
}

describe('DhruCredentialsAccessHandler', () => {
  it('asks for the username and key of the body', async () => {
    const { authenticator, calls } = recorder();
    const request = { body: { username: 'acme', apiaccesskey: 'KEY' } } as unknown as FastifyRequest;
    await new DhruCredentialsAccessHandler(authenticator).authenticate(request, {
      surface: 'dhru',
    } as AnyRouteContract);
    expect(calls).toEqual([{ key: 'KEY', username: 'acme', points: 1 }]);
  });

  it('asks for one point per item of a placement bulk, and one for a read bulk (decision 053)', async () => {
    const { authenticator, calls } = recorder();
    const parameters = Buffer.from(JSON.stringify({ a: {}, b: {}, c: {} })).toString('base64');
    const handler = new DhruCredentialsAccessHandler(authenticator);
    const contract = { key: 'POST /api/index.php', surface: 'dhru' } as unknown as AnyRouteContract;
    const call = (action: string) =>
      handler.authenticate(
        { body: { username: 'acme', apiaccesskey: 'KEY', action, parameters } } as unknown as FastifyRequest,
        contract,
      );
    await call('placeimeiorderbulk');
    await call('getimeiorderbulk');
    expect(calls.map((entry) => entry.points)).toEqual([3, 1]);
  });

  it('presents no key at all when either credential is missing', async () => {
    const { authenticator, calls } = recorder();
    const request = { body: { username: 'acme' } } as unknown as FastifyRequest;
    await new DhruCredentialsAccessHandler(authenticator).authenticate(request, {
      surface: 'dhru',
    } as AnyRouteContract);
    expect(calls[0]).toEqual({ key: undefined, username: undefined, points: 1 });
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
