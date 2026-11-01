// Unit test of the actor a principal stands for in the request context (the audit log reads it).
import { describe, expect, it } from 'bun:test';
import { actorOf } from './access-state';
import type { Principal, SessionPrincipal } from './principal';

const session = {} as SessionPrincipal['session'];

describe('actorOf', () => {
  it('names the account behind a session principal', () => {
    expect(
      actorOf({ kind: 'staff', staffId: 4, roleId: 1, permissions: [], stage: 'active', ip: 'x', session }),
    ).toEqual({
      type: 'staff',
      id: 4,
    });
    expect(actorOf({ kind: 'merchant', clientId: 5, stage: 'active', ip: 'x', session })).toEqual({
      type: 'client',
      id: 5,
    });
    expect(actorOf({ kind: 'customer', customerId: 6, stage: 'active', ip: 'x', session })).toEqual({
      type: 'customer',
      id: 6,
    });
  });

  it('names the merchant behind an API key', () => {
    const principal: Principal = { kind: 'api-key', clientId: 8, keyId: 2, scopes: ['dhru'], ip: 'x' };
    expect(actorOf(principal)).toEqual({ type: 'client', id: 8 });
  });

  it('names nobody for the holder of a capability token or a gateway webhook: they are not accounts', () => {
    expect(actorOf({ kind: 'capability', access: 'tracking-token', resourceId: 3, ip: 'x' })).toBeUndefined();
    expect(
      actorOf({ kind: 'webhook', gateway: 'stripe', eventId: 'e', timestamp: 1, duplicate: false, ip: 'x' }),
    ).toBeUndefined();
  });
});
