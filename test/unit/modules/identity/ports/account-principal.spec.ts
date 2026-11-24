// Unit test of the account principal's helpers (decision 064): the actor of a write and the decorator that hands the principal to a handler.
import { describe, expect, it } from 'bun:test';
import type { ExecutionContext } from '@nestjs/common';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import type { FastifyRequest } from 'fastify';
import { AppError } from '@src/common/errors';
import { type AccountPrincipal, CurrentAccount, actorOf } from '@src/modules/identity/ports/account-principal';
import { setAccessState } from '@src/modules/identity/security/access-state';
import type { Principal } from '@src/modules/identity/security/principal';
import type { SessionView } from '@src/modules/identity/security/session.types';

/** A handler with the decorator, so the test can ask Nest which factory it registered. */
class Probe {
  handle(@CurrentAccount() account: AccountPrincipal): AccountPrincipal {
    return account;
  }
}

/**
 * Runs the decorator's factory the way Nest does for one request.
 *
 * @param request the fake request, with or without access state
 * @returns what the handler would receive
 */
function received(request: FastifyRequest): unknown {
  const metadata = Reflect.getMetadata(ROUTE_ARGS_METADATA, Probe, 'handle') as Record<
    string,
    { factory: (data: unknown, context: ExecutionContext) => unknown }
  >;
  const entry = Object.values(metadata)[0];
  if (!entry) throw new Error('the decorator registered no parameter');
  const context = { switchToHttp: () => ({ getRequest: () => request }) } as unknown as ExecutionContext;
  return entry.factory(undefined, context);
}

const session = { subject: { state: 'ok', name: 'Rami K.' } } as SessionView;
const principal: AccountPrincipal = {
  kind: 'account',
  accountId: 12,
  clientId: 12,
  rank: { id: 4, kind: 'retail' },
  stage: 'active',
  ip: '203.0.113.5',
  session,
};

describe('actorOf', () => {
  it('names an account with the one stored word `account`, its id and its name', () => {
    expect(actorOf({ id: 12, name: 'Rami K.' })).toEqual({ type: 'account', id: 12, name: 'Rami K.' });
  });

  it('keeps an empty name as it is: history keeps what was known', () => {
    expect(actorOf({ id: 3, name: '' })).toEqual({ type: 'account', id: 3, name: '' });
  });
});

describe('CurrentAccount', () => {
  it('hands the handler the account principal the guards stored on the request', () => {
    const request = {} as FastifyRequest;
    setAccessState(request, { principal: principal });
    expect(received(request)).toBe(principal);
  });

  it('carries the same id as accountId and clientId, so merchant controllers written before the merge compile unchanged', () => {
    const request = {} as FastifyRequest;
    setAccessState(request, { principal: principal });
    const account = received(request) as AccountPrincipal;
    expect(account.clientId).toBe(account.accountId);
  });

  it('refuses a request no guard authenticated', () => {
    expect(() => received({} as FastifyRequest)).toThrow(AppError);
    try {
      received({} as FastifyRequest);
    } catch (error) {
      expect((error as AppError).code).toBe('UNAUTHORIZED');
    }
  });

  it("refuses a principal that is not an account's (a staff member, a key, a capability)", () => {
    const staff = { kind: 'staff', staffId: 1, roleId: 1, permissions: [], stage: 'active', ip: 'x', session };
    const request = {} as FastifyRequest;
    setAccessState(request, { principal: staff as unknown as Principal });
    expect(() => received(request)).toThrow(AppError);
  });
});
