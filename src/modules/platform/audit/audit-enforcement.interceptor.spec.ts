// Unit tests of the audit enforcement (decision 018): a successful staff mutation without an audit row fails in development
// and tests and is only logged in production; reads, opted-out routes and other callers are not checked.
import { beforeEach, describe, expect, it } from 'bun:test';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { lastValueFrom, of, throwError } from 'rxjs';
import { z } from 'zod';
import { CONTRACT_METADATA, type RouteKey, defineRoute } from '../../../common/contract';
import { AppError } from '../../../common/errors';
import { countAuditRecord, runInRequestContext, setRequestActor } from '../../../common/request-context';
import { type AppConfig, parseEnv } from '../../../config';
import { AuditEnforcementInterceptor } from './audit-enforcement.interceptor';

let counter = 0;
function contractFor(method: 'GET' | 'POST', over: Record<string, unknown> = {}) {
  return defineRoute({
    key: `${method} /admin/spec/enforce-${(counter += 1)}` as RouteKey,
    summary: 'A route',
    tags: ['spec'],
    surface: 'admin',
    access: 'staff-session',
    success: { status: 200, schema: z.object({}) },
    errors: [],
    ...over,
  } as never);
}

function contextOf(contract: ReturnType<typeof contractFor>): ExecutionContext {
  const handler = () => undefined;
  Reflect.defineMetadata(CONTRACT_METADATA, contract, handler);
  return { getType: () => 'http', getHandler: () => handler } as unknown as ExecutionContext;
}
const handle = (value: unknown): CallHandler => ({ handle: () => of(value) });
const config = (env: 'test' | 'production'): AppConfig => ({
  ...parseEnv({ NODE_ENV: 'test' }),
  isProduction: env === 'production',
});

/** The error lines the interceptor logged, so the tests stay quiet and can assert on them. */
let logged: string[] = [];

/** Runs the interceptor inside a request whose caller is a staff member who has written `rows` audit rows. */
async function run(options: {
  contract: ReturnType<typeof contractFor>;
  env?: 'test' | 'production';
  actor?: 'staff' | 'client' | undefined;
  rows?: number;
  next?: CallHandler;
}): Promise<unknown> {
  const interceptor = new AuditEnforcementInterceptor(config(options.env ?? 'test'));
  Object.assign(interceptor, { logger: { error: (message: string) => logged.push(message) } });
  return runInRequestContext('req-enforce', async () => {
    if (options.actor) setRequestActor({ type: options.actor, id: 3, name: 'Test Actor' }, '10.0.0.1');
    for (let i = 0; i < (options.rows ?? 0); i++) countAuditRecord();
    return lastValueFrom(interceptor.intercept(contextOf(options.contract), options.next ?? handle({ ok: true })));
  });
}

describe('AuditEnforcementInterceptor', () => {
  beforeEach(() => {
    logged = [];
  });

  it('fails a staff mutation that wrote no audit row, naming the route, outside production', async () => {
    const contract = contractFor('POST');
    try {
      await run({ contract, actor: 'staff' });
      throw new Error('expected a failure');
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect(error).toMatchObject({ code: 'INTERNAL_ERROR', status: 500 });
      expect((error as AppError).detail).toContain(contract.key);
      expect((error as AppError).detail).toContain('AuditService.record');
      expect(logged).toHaveLength(1);
      expect(logged[0]).toContain(contract.key);
    }
  });

  it('lets the answer through in production, where the change is already committed (the error is logged)', async () => {
    const contract = contractFor('POST');
    expect(await run({ contract, actor: 'staff', env: 'production' })).toEqual({ ok: true });
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain('wrote no audit row');
  });

  it('lets a mutation through that wrote an audit row, however many', async () => {
    expect(await run({ contract: contractFor('POST'), actor: 'staff', rows: 1 })).toEqual({ ok: true });
    expect(await run({ contract: contractFor('POST'), actor: 'staff', rows: 3 })).toEqual({ ok: true });
    expect(logged).toHaveLength(0);
  });

  it('does not check reads, opted-out routes, other callers or anonymous requests', async () => {
    expect(await run({ contract: contractFor('GET'), actor: 'staff' })).toEqual({ ok: true });
    const optedOut = contractFor('POST', { audit: false, description: 'A sign-in step: nothing to audit.' });
    expect(await run({ contract: optedOut, actor: 'staff' })).toEqual({ ok: true });
    expect(await run({ contract: contractFor('POST'), actor: 'client' })).toEqual({ ok: true });
    expect(await run({ contract: contractFor('POST'), actor: undefined })).toEqual({ ok: true });
    expect(logged).toHaveLength(0);
  });

  it('does not hide a failure of the handler: no audit row is expected then', async () => {
    const failing: CallHandler = { handle: () => throwError(() => new AppError('CONFLICT')) };
    try {
      await run({ contract: contractFor('POST'), actor: 'staff', next: failing });
      throw new Error('expected a failure');
    } catch (error) {
      expect(error).toMatchObject({ code: 'CONFLICT' });
    }
  });

  it('ignores handlers without a contract and non-HTTP contexts', async () => {
    const interceptor = new AuditEnforcementInterceptor(config('test'));
    const bare = { getType: () => 'http', getHandler: () => () => undefined } as unknown as ExecutionContext;
    expect(await lastValueFrom(interceptor.intercept(bare, handle(1)))).toBe(1);
    const rpc = { getType: () => 'rpc', getHandler: () => () => undefined } as unknown as ExecutionContext;
    expect(await lastValueFrom(interceptor.intercept(rpc, handle(2)))).toBe(2);
  });
});
