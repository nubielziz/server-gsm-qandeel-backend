// Unit tests of the access handler table (decision 018, decision 064): every access kind has an entry, the placeholders fail closed (with
// the Dhru wording on the Dhru surface), the session kinds pass the contract's stages on, the one account handler applies the default-deny
// rank gate, and a kind can be replaced.
import { describe, expect, it } from 'bun:test';
import type { ExecutionContext } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ACCESS_KINDS, type AnyRouteContract, defineRoute } from '@src/common/contract';
import { AppError } from '@src/common/errors';
import type { MetricsAccessGuard } from '@src/infra/metrics';
import {
  type AccessHandler,
  AccessHandlers,
  PLACEHOLDER_ACCESS_KINDS,
} from '@src/modules/identity/security/access-handlers';
import type { SessionAuthenticator } from '@src/modules/identity/security/session-authenticator';

const request = {} as FastifyRequest;
const context = {} as ExecutionContext;
const fakeContract = (over: Partial<AnyRouteContract>) =>
  ({ surface: 'admin', sessionStages: ['active'], ...over }) as AnyRouteContract;

/** The error a handler refuses a request with (the placeholders refuse synchronously). */
function refusalOf(handler: AccessHandler, contract: AnyRouteContract): unknown {
  try {
    void handler.authenticate(request, contract, context);
  } catch (error) {
    return error;
  }
  throw new Error('expected a refusal');
}

interface AuthenticateCall {
  readonly subject: string;
  readonly stages: readonly string[];
}
function table() {
  const calls: AuthenticateCall[] = [];
  const authenticator = {
    authenticate(subject: string, _request: FastifyRequest, options: { stages: readonly string[] }) {
      calls.push({ subject, stages: options.stages });
      // An account view carries the rank the resolver read; the rank gate of the account handler passes it for the default contract.
      const subjectView = subject === 'account' ? { rank: { id: 3, kind: 'merchant' } } : {};
      return Promise.resolve({ view: { id: 1, subject: subjectView }, principal: { kind: 'staff', staffId: 9 } });
    },
  } as unknown as SessionAuthenticator;
  let metricsChecked = 0;
  const metrics = {
    canActivate() {
      metricsChecked += 1;
      return true;
    },
  } as unknown as MetricsAccessGuard;
  return { handlers: new AccessHandlers(authenticator, metrics), calls, metricsChecked: () => metricsChecked };
}

describe('AccessHandlers', () => {
  it('has a handler for every access kind', () => {
    const { handlers } = table();
    for (const kind of ACCESS_KINDS) expect(handlers.handlerFor(kind), kind).toBeDefined();
  });

  it('lets a public route through without a principal', async () => {
    expect(await table().handlers.handlerFor('public').authenticate(request, fakeContract({}), context)).toEqual({});
  });

  it('authenticates the session kinds by subject type, with the stages of the contract', async () => {
    const { handlers, calls } = table();
    const stages = ['pending_totp', 'pending_totp_setup'] as const;
    const result = await handlers
      .handlerFor('staff-session')
      .authenticate(request, fakeContract({ sessionStages: stages }), context);
    expect(result).toMatchObject({ principal: { kind: 'staff', staffId: 9 }, session: { id: 1 } });
    await handlers.handlerFor('staff-permission').authenticate(request, fakeContract({}), context);
    await handlers
      .handlerFor('merchant-session')
      .authenticate(request, fakeContract({ access: 'merchant-session', rank: 'merchant' }), context);
    await handlers
      .handlerFor('customer-session')
      .authenticate(request, fakeContract({ access: 'customer-session', rank: 'any' }), context);
    // Both account access kinds authenticate the one subject `account` (decision 064): there is no customer subject any more.
    expect(calls).toEqual([
      { subject: 'staff', stages: [...stages] },
      { subject: 'staff', stages: ['active'] },
      { subject: 'account', stages: ['active'] },
      { subject: 'account', stages: ['active'] },
    ]);
  });

  it('asks the metrics guard for internal-or-token', async () => {
    const { handlers, metricsChecked } = table();
    expect(
      await handlers
        .handlerFor('internal-or-token')
        .authenticate(request, fakeContract({ surface: 'system' }), context),
    ).toEqual({});
    expect(metricsChecked()).toBe(1);
  });

  it('refuses every request of the kinds P2.5c builds with 401 UNAUTHORIZED', () => {
    const { handlers } = table();
    expect<string[]>([...PLACEHOLDER_ACCESS_KINDS].sort()).toEqual(
      [
        'checkout-token',
        'dhru-credentials',
        'gateway-signature',
        'link-token',
        'tracking-token',
        'ticket-token',
        'url-secret',
      ].sort(),
    );
    for (const kind of PLACEHOLDER_ACCESS_KINDS) {
      expect(handlers.isPlaceholder(kind), kind).toBe(true);
      const error = refusalOf(handlers.handlerFor(kind), fakeContract({ surface: 'store' }));
      expect(error, kind).toBeInstanceOf(AppError);
      expect(error, kind).toMatchObject({ code: 'UNAUTHORIZED', status: 401, detail: undefined });
    }
  });

  it('says Authentication Failed on the Dhru surface', () => {
    const error = refusalOf(table().handlers.handlerFor('dhru-credentials'), fakeContract({ surface: 'dhru' }));
    expect(error).toMatchObject({ code: 'UNAUTHORIZED', detail: 'Authentication Failed' });
  });

  it('keeps the session kinds and public out of the placeholders', () => {
    const { handlers } = table();
    for (const kind of [
      'public',
      'staff-session',
      'staff-permission',
      'merchant-session',
      'customer-session',
      'internal-or-token',
    ] as const) {
      expect(handlers.isPlaceholder(kind), kind).toBe(false);
    }
  });

  it('lets a later feature replace a placeholder', async () => {
    const { handlers } = table();
    handlers.replace('url-secret', { authenticate: () => ({ principal: undefined }) });
    expect(handlers.isPlaceholder('url-secret')).toBe(false);
    expect(await handlers.handlerFor('url-secret').authenticate(request, fakeContract({}), context)).toEqual({
      principal: undefined,
    });
    expect(handlers.isPlaceholder('link-token')).toBe(true);
  });

  it('covers a contract defined with every access kind', () => {
    // defineRoute accepts exactly the kinds the table handles: a new kind in ACCESS_KINDS shows up here.
    let counter = 0;
    for (const kind of ACCESS_KINDS) {
      const spec = {
        key: `GET /store/v1/spec/handlers-${(counter += 1)}`,
        summary: 'A route',
        tags: ['spec'],
        surface: 'store',
        access: kind,
        ...(kind === 'staff-permission' ? { permission: 'staff:read' } : {}),
        success: { status: 200, schema: z.object({}) },
        errors: [],
      };
      expect(defineRoute(spec as never).access).toBe(kind);
    }
  });
});

describe('the rank gate of the account handler (decision 064)', () => {
  type RankKind = 'merchant' | 'retail';
  /** A table whose authenticator finds a live account session of the given rank (`undefined`: a view without a rank), or refuses. */
  function tableFor(rank: RankKind | undefined, refusal?: AppError) {
    const authenticator = {
      authenticate: () =>
        refusal
          ? Promise.reject(refusal)
          : Promise.resolve({
              view: {
                id: 1,
                subjectType: 'account',
                subject: { state: 'ok', ...(rank ? { rank: { id: 3, kind: rank } } : {}) },
              },
              principal: { kind: 'account', accountId: 5, clientId: 5 },
            }),
    } as unknown as SessionAuthenticator;
    return new AccessHandlers(authenticator, { canActivate: () => true } as unknown as MetricsAccessGuard);
  }
  const route = (access: 'merchant-session' | 'customer-session', rank?: 'merchant' | 'retail' | 'any') =>
    fakeContract({ surface: 'client', access, ...(rank ? { rank } : {}) });
  /** What a handler threw, synchronously or as a rejection (a handler may answer either way). */
  async function refusalOfRun(run: () => unknown): Promise<unknown> {
    try {
      await run();
    } catch (error) {
      return error;
    }
    return undefined;
  }
  const call = (handlers: AccessHandlers, contract: AnyRouteContract) =>
    handlers.handlerFor(contract.access).authenticate(request, contract, context);

  it('refuses a retail session on a merchant route with 403 RANK_NOT_ALLOWED', async () => {
    const error = await refusalOfRun(() => call(tableFor('retail'), route('merchant-session', 'merchant')));
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({
      code: 'RANK_NOT_ALLOWED',
      status: 403,
      detail: 'This is available to merchant accounts.',
    });
  });

  it('refuses a merchant session on a retail route with 403 RANK_NOT_ALLOWED', async () => {
    const error = await refusalOfRun(() => call(tableFor('merchant'), route('customer-session', 'retail')));
    expect(error).toMatchObject({
      code: 'RANK_NOT_ALLOWED',
      status: 403,
      detail: 'This is available to shop accounts.',
    });
  });

  it('serves the rank of the route', async () => {
    expect(await call(tableFor('merchant'), route('merchant-session', 'merchant'))).toMatchObject({
      session: { id: 1 },
    });
    expect(await call(tableFor('retail'), route('customer-session', 'retail'))).toMatchObject({ session: { id: 1 } });
  });

  it('refuses a view without a rank on every route that names one (fail closed)', async () => {
    for (const contract of [route('merchant-session', 'merchant'), route('customer-session', 'retail')]) {
      const error = await refusalOfRun(() => call(tableFor(undefined), contract));
      expect(error, contract.access).toMatchObject({ code: 'RANK_NOT_ALLOWED', status: 403 });
    }
  });

  it('lets every rank through a route marked rank: any, and nothing else does', async () => {
    for (const kind of ['merchant', 'retail'] as const) {
      expect(await call(tableFor(kind), route('merchant-session', 'any')), kind).toMatchObject({ session: { id: 1 } });
      expect(await call(tableFor(kind), route('customer-session', 'any')), kind).toMatchObject({ session: { id: 1 } });
    }
  });

  it('falls back to the default rank of the access kind when a contract carries no rank (never to open)', async () => {
    const merchantRoute = fakeContract({ surface: 'client', access: 'merchant-session' });
    const retailRoute = fakeContract({ surface: 'store', access: 'customer-session' });
    expect(await call(tableFor('merchant'), merchantRoute)).toMatchObject({ session: { id: 1 } });
    expect(await refusalOfRun(() => call(tableFor('retail'), merchantRoute))).toMatchObject({
      code: 'RANK_NOT_ALLOWED',
    });
    expect(await call(tableFor('retail'), retailRoute)).toMatchObject({ session: { id: 1 } });
    expect(await refusalOfRun(() => call(tableFor('merchant'), retailRoute))).toMatchObject({
      code: 'RANK_NOT_ALLOWED',
    });
  });

  it('judges the session before the rank: a pending step or a suspension is answered first', async () => {
    const unauthorized = new AppError('UNAUTHORIZED');
    const suspended = new AppError('ACCOUNT_SUSPENDED');
    for (const refusal of [unauthorized, suspended]) {
      // A retail view on a merchant route would be a rank refusal; the authenticator's refusal wins.
      const error = await refusalOfRun(() => call(tableFor('retail', refusal), route('merchant-session', 'merchant')));
      expect(error).toBe(refusal);
    }
  });

  it('does not apply to staff: a staff session has no rank and passes a route without one', async () => {
    const authenticator = {
      authenticate: () => Promise.resolve({ view: { id: 1, subject: {} }, principal: { kind: 'staff', staffId: 9 } }),
    } as unknown as SessionAuthenticator;
    const handlers = new AccessHandlers(authenticator, { canActivate: () => true } as unknown as MetricsAccessGuard);
    const staffRoute = fakeContract({ surface: 'admin', access: 'staff-permission', rank: null });
    expect(await call(handlers, staffRoute)).toMatchObject({ principal: { kind: 'staff' } });
  });

  it('ignores pendingMerchant: the contract field no longer decides anything', async () => {
    const contract = { ...route('merchant-session', 'merchant'), pendingMerchant: 'deny' } as AnyRouteContract;
    expect(await call(tableFor('merchant'), contract)).toMatchObject({ session: { id: 1 } });
  });
});
