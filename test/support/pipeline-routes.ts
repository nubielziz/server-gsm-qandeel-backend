// Sample routes and a stand-in "authentication" guard for the request pipeline tests (IP rules, maintenance, per-IP limit).
// The routes sit on the public surfaces under /t/ paths so their keys never meet a real route; the guard answers 401 to
// every sample route unless the request carries `x-test-auth`, which lets a test prove a hook ran before authentication.
import { randomInt } from 'node:crypto';
import { type CanActivate, Controller, Injectable, type ExecutionContext } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { type ParamsOf, type ResultOf, Route, defineRoute, zJsonObject } from '../../src/common/contract';
import { AppError } from '../../src/common/errors';

const ok = z.object({ ok: z.boolean() });

/** A public storefront route. */
export const storePing = defineRoute({
  key: 'GET /store/v1/t/ping',
  summary: 'Public storefront sample',
  tags: ['test'],
  surface: 'store',
  access: 'public',
  success: { status: 200, schema: ok },
  errors: ['UNAUTHORIZED'],
});

/** A storefront route reached with a capability token (the stricter `token` limiter). */
export const storeToken = defineRoute({
  key: 'GET /store/v1/t/orders/:token',
  summary: 'Tracking-token storefront sample',
  tags: ['test'],
  surface: 'store',
  access: 'tracking-token',
  params: z.object({ token: z.string() }),
  success: { status: 200, schema: ok },
  errors: ['UNAUTHORIZED'],
});

/** A public sign-in route of the admin console (counted per IP). */
export const adminSignIn = defineRoute({
  key: 'POST /admin/t/sign-in',
  summary: 'Public admin sample',
  tags: ['test'],
  surface: 'admin',
  access: 'public',
  body: zJsonObject,
  success: { status: 200, schema: ok },
  errors: [],
});

/** A session-authenticated admin route (not counted per IP). */
export const adminSession = defineRoute({
  key: 'GET /admin/t/session',
  summary: 'Session admin sample',
  tags: ['test'],
  surface: 'admin',
  access: 'staff-session',
  success: { status: 200, schema: ok },
  errors: ['UNAUTHORIZED'],
});

/** A merchant portal route. */
export const clientPing = defineRoute({
  key: 'GET /client/t/ping',
  summary: 'Merchant portal sample',
  tags: ['test'],
  surface: 'client',
  access: 'merchant-session',
  success: { status: 200, schema: ok },
  errors: ['UNAUTHORIZED'],
});

/** A REST v1 route. */
export const v1Ping = defineRoute({
  key: 'GET /v1/t/ping',
  summary: 'REST v1 sample',
  tags: ['test'],
  surface: 'v1',
  access: 'api-key',
  success: { status: 200, schema: ok },
  errors: ['UNAUTHORIZED'],
});

/** An incoming webhook route. */
export const hookPing = defineRoute({
  key: 'POST /webhooks/t/ping',
  summary: 'Incoming webhook sample',
  tags: ['test'],
  surface: 'hooks',
  access: 'gateway-signature',
  body: zJsonObject,
  success: { status: 200, schema: ok },
  errors: ['UNAUTHORIZED'],
});

/** Handlers of the sample routes; each answers `{ ok: true }`. */
@Controller()
export class PipelineTestController {
  @Route(storePing)
  storePing(): ResultOf<typeof storePing> {
    return { ok: true };
  }

  @Route(storeToken)
  storeToken(): ResultOf<typeof storeToken> {
    return { ok: true };
  }

  @Route(adminSignIn)
  adminSignIn(): ResultOf<typeof adminSignIn> {
    return { ok: true };
  }

  @Route(adminSession)
  adminSession(): ResultOf<typeof adminSession> {
    return { ok: true };
  }

  @Route(clientPing)
  clientPing(): ResultOf<typeof clientPing> {
    return { ok: true };
  }

  @Route(v1Ping)
  v1Ping(): ResultOf<typeof v1Ping> {
    return { ok: true };
  }

  @Route(hookPing)
  hookPing(): ResultOf<typeof hookPing> {
    return { ok: true };
  }
}

/** The params of the token sample, for typing in tests. */
export type StoreTokenParams = ParamsOf<typeof storeToken>;

/**
 * Stands in for authentication: answers 401 to every `/t/` sample route unless the request has `x-test-auth`.
 *
 * Why: the pipeline hooks must run before any guard; a guard that always refuses shows which answer came first.
 */
@Injectable()
export class TestAuthGuard implements CanActivate {
  /**
   * @param context the request context
   * @returns true when the request carries `x-test-auth`
   * @throws {AppError} `UNAUTHORIZED` for a sample route without it
   */
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const template = request.routeOptions?.url ?? '';
    if (!template.includes('/t/')) return true;
    if (request.headers['x-test-auth']) return true;
    throw new AppError('UNAUTHORIZED', { detail: 'No session (test guard).' });
  }
}

const RUN = randomInt(0, 256);
let counter = 0;

/**
 * A client address nobody else uses in this test run.
 *
 * Why: per-address counters (rate limits, hit counts) live 60 seconds in Redis, so tests give every request its own address
 * out of the benchmarking range 198.18.0.0/15 instead of sharing 127.0.0.1.
 *
 * @returns an IPv4 address such as `198.18.37.5`
 */
export function freshClientIp(): string {
  counter = (counter % 250) + 1;
  return `198.18.${RUN}.${counter}`;
}

/**
 * The first four groups of an IPv6 /64 network nobody else uses in this test run (append `::1` or any interface id).
 *
 * @returns for example `2001:db8:25:7`
 */
export function freshClientPrefix(): string {
  counter = (counter % 250) + 1;
  return `2001:db8:${RUN.toString(16)}:${counter}`;
}
