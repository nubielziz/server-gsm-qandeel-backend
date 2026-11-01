// Unit tests of the access handler table (decision 018): every access kind has an entry, the placeholders fail closed (with
// the Dhru wording on the Dhru surface), the session kinds pass the contract's stages on, and a kind can be replaced.
import { describe, expect, it } from 'bun:test';
import type { ExecutionContext } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ACCESS_KINDS, type AnyRouteContract, defineRoute } from '../../../common/contract';
import { AppError } from '../../../common/errors';
import type { MetricsAccessGuard } from '../../../infra/metrics';
import { type AccessHandler, AccessHandlers, PLACEHOLDER_ACCESS_KINDS } from './access-handlers';
import type { SessionAuthenticator } from './session-authenticator';

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
      return Promise.resolve({ view: { id: 1 }, principal: { kind: 'staff', staffId: 9 } });
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
    await handlers.handlerFor('merchant-session').authenticate(request, fakeContract({}), context);
    await handlers.handlerFor('customer-session').authenticate(request, fakeContract({}), context);
    expect(calls).toEqual([
      { subject: 'staff', stages: [...stages] },
      { subject: 'staff', stages: ['active'] },
      { subject: 'client', stages: ['active'] },
      { subject: 'customer', stages: ['active'] },
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
        'api-key',
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
      const error = refusalOf(handlers.handlerFor(kind), fakeContract({ surface: 'v1' }));
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
    handlers.replace('api-key', { authenticate: () => ({ principal: undefined }) });
    expect(handlers.isPlaceholder('api-key')).toBe(false);
    expect(await handlers.handlerFor('api-key').authenticate(request, fakeContract({}), context)).toEqual({
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
        ...(kind === 'staff-permission' || kind === 'api-key' ? { permission: 'staff:read' } : {}),
        success: { status: 200, schema: z.object({}) },
        errors: [],
      };
      expect(defineRoute(spec as never).access).toBe(kind);
    }
  });
});
