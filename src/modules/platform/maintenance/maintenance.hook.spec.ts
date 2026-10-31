// Unit tests of the maintenance hook with a fake state: the two phases, the Dhru action, and that an unreadable state lets
// requests through.
import { describe, expect, it } from 'bun:test';
import type { FastifyRequest } from 'fastify';
import { AppError } from '../../../common/errors';
import type { PipelineHandler, PipelinePhase, PipelineStage, RequestPipeline } from '../../../common/pipeline';
import { expectRejection } from '../../../../test/support/rejection';
import { MaintenanceHook } from './maintenance.hook';
import type { MaintenanceService } from './maintenance.service';
import { MAINTENANCE_OFF, type MaintenanceState } from './maintenance-state';

const ON_ALL: MaintenanceState = { ...MAINTENANCE_OFF, enabled: true, scope: 'all', message: 'Back at noon.' };

function hookWith(state: MaintenanceState | Error) {
  const registered = new Map<string, PipelineHandler>();
  const pipeline = {
    register: (stage: PipelineStage, handler: PipelineHandler, phase: PipelinePhase = 'onRequest') =>
      void registered.set(`${phase}:${stage}`, handler),
  } as unknown as RequestPipeline;
  const service = { state: () => (state instanceof Error ? Promise.reject(state) : Promise.resolve(state)) };
  const hook = new MaintenanceHook(pipeline, service as unknown as MaintenanceService);
  hook.onModuleInit();
  const run = (phase: PipelinePhase, request: Partial<FastifyRequest>) =>
    Promise.resolve(registered.get(`${phase}:maintenance`)?.(request as FastifyRequest, {} as never));
  return { registered, run };
}

const req = (method: string, url: string, body?: unknown, template?: string): Partial<FastifyRequest> => ({
  method,
  url,
  body,
  routeOptions: template
    ? ({ url: template } as FastifyRequest['routeOptions'])
    : ({} as FastifyRequest['routeOptions']),
});

describe('MaintenanceHook', () => {
  it('registers the maintenance stage in both phases', () => {
    const { registered } = hookWith(MAINTENANCE_OFF);
    expect([...registered.keys()].sort()).toEqual(['onRequest:maintenance', 'preValidation:maintenance']);
  });

  it('refuses a request of the scope in onRequest, with the message', async () => {
    const { run } = hookWith(ON_ALL);
    const refusal = (await expectRejection(run('onRequest', req('GET', '/store/v1/services')))) as AppError;
    expect(refusal.code).toBe('MAINTENANCE');
    expect(refusal.detail).toBe('Back at noon.');
    await expectRejection(run('onRequest', req('POST', '/v1/orders')));
  });

  it('lets everything else through in onRequest, and leaves the Dhru endpoint to the second phase', async () => {
    const { run } = hookWith(ON_ALL);
    await run('onRequest', req('GET', '/admin/staff', undefined, '/admin/staff'));
    await run('onRequest', req('GET', '/health', undefined, '/health'));
    await run('onRequest', req('POST', '/api/index.php', { action: 'placeimeiorder' }, '/api/index.php'));
  });

  it('refuses a Dhru order placement once the body is parsed, and lets the other actions through', async () => {
    const { run } = hookWith(ON_ALL);
    const refusal = (await expectRejection(
      run('preValidation', req('POST', '/api/index.php', { action: 'placeimeiorder' }, '/api/index.php')),
    )) as AppError;
    expect(refusal.code).toBe('MAINTENANCE');
    await run('preValidation', req('POST', '/api/index.php', { action: 'getimeiorder' }, '/api/index.php'));
    await run('preValidation', req('POST', '/api/index.php', undefined, '/api/index.php'));
  });

  it('does nothing in the second phase for any other path', async () => {
    const { run } = hookWith(ON_ALL);
    await run('preValidation', req('POST', '/v1/orders', { action: 'placeimeiorder' }));
  });

  it('lets requests through when the state cannot be read', async () => {
    const { run } = hookWith(new Error('settings unreachable'));
    await run('onRequest', req('GET', '/store/v1/services'));
    await run('preValidation', req('POST', '/api/index.php', { action: 'placeimeiorder' }, '/api/index.php'));
  });
});
