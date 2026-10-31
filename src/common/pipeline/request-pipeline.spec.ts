// Unit tests of the request pipeline registry: the stage order is fixed, hooks run in that order whatever the registration
// order, a refusal stops the chain and is answered by the exception filter, and misuse fails loudly.
import { describe, expect, it } from 'bun:test';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { AppError, type ProblemExceptionFilter } from '../errors';
import { PIPELINE_STAGES, type PipelinePhase, RequestPipeline } from './request-pipeline';

type Hook = (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;

/** A Fastify stand-in that keeps the hooks it is given. */
function fakeFastify() {
  const hooks: Array<{ phase: string; run: Hook }> = [];
  const instance = { addHook: (phase: string, run: Hook) => hooks.push({ phase, run }) } as unknown as FastifyInstance;
  return { instance, hooks };
}

/** A filter stand-in that records what it was asked to answer. */
function fakeFilter() {
  const answered: unknown[] = [];
  const filter = { handle: (error: unknown) => answered.push(error) } as unknown as ProblemExceptionFilter;
  return { filter, answered };
}

const request = {} as FastifyRequest;
const reply = (sent = false) => ({ sent }) as unknown as FastifyReply;

describe('PIPELINE_STAGES', () => {
  it('is the order of decision 018: IP rules, maintenance, per-IP rate limit', () => {
    expect<string[]>([...PIPELINE_STAGES]).toEqual(['ip-rules', 'maintenance', 'rate-limit']);
  });
});

describe('RequestPipeline', () => {
  it('installs one hook per phase and runs the stages in pipeline order whatever the registration order', async () => {
    const { filter } = fakeFilter();
    const pipeline = new RequestPipeline(filter);
    const ran: string[] = [];
    // Registered in the "wrong" order on purpose.
    pipeline.register('rate-limit', () => void ran.push('rate-limit'));
    pipeline.register('ip-rules', () => void ran.push('ip-rules'));
    pipeline.register('maintenance', () => void ran.push('maintenance'));
    const fastify = fakeFastify();
    pipeline.install(fastify.instance);
    expect(fastify.hooks.map((hook) => hook.phase)).toEqual(['onRequest', 'preValidation']);
    await fastify.hooks[0]!.run(request, reply());
    expect(ran).toEqual(['ip-rules', 'maintenance', 'rate-limit']);
    expect(pipeline.stagesWithHandlers()).toEqual(['ip-rules', 'maintenance', 'rate-limit']);
  });

  it('keeps the two phases apart', async () => {
    const pipeline = new RequestPipeline(fakeFilter().filter);
    const ran: string[] = [];
    pipeline.register('maintenance', () => void ran.push('request'));
    pipeline.register('maintenance', () => void ran.push('validation'), 'preValidation');
    const fastify = fakeFastify();
    pipeline.install(fastify.instance);
    await fastify.hooks.find((hook) => hook.phase === 'preValidation')!.run(request, reply());
    expect(ran).toEqual(['validation']);
    expect(pipeline.stagesWithHandlers('preValidation')).toEqual(['maintenance']);
  });

  it('looks handlers up per request, so a stage registered after install still runs', async () => {
    const pipeline = new RequestPipeline(fakeFilter().filter);
    const fastify = fakeFastify();
    pipeline.install(fastify.instance);
    const ran: string[] = [];
    pipeline.register('ip-rules', () => void ran.push('late'));
    await fastify.hooks[0]!.run(request, reply());
    expect(ran).toEqual(['late']);
  });

  it('stops at the first refusal, answers it through the exception filter and returns the reply', async () => {
    const { filter, answered } = fakeFilter();
    const pipeline = new RequestPipeline(filter);
    const ran: string[] = [];
    const refusal = new AppError('IP_NOT_ALLOWED');
    pipeline.register('ip-rules', () => {
      throw refusal;
    });
    pipeline.register('maintenance', () => void ran.push('maintenance'));
    const fastify = fakeFastify();
    pipeline.install(fastify.instance);
    const response = reply();
    const result = await fastify.hooks[0]!.run(request, response);
    expect(answered).toEqual([refusal]);
    expect(ran).toEqual([]);
    expect(result).toBe(response);
  });

  it('refuses an unexpected error too (the filter turns it into a 500), and awaits async handlers', async () => {
    const { filter, answered } = fakeFilter();
    const pipeline = new RequestPipeline(filter);
    const boom = new Error('redis exploded');
    pipeline.register('maintenance', async () => {
      await Promise.resolve();
      throw boom;
    });
    const fastify = fakeFastify();
    pipeline.install(fastify.instance);
    await fastify.hooks[0]!.run(request, reply());
    expect(answered).toEqual([boom]);
  });

  it('stops when a handler already sent the reply', async () => {
    const pipeline = new RequestPipeline(fakeFilter().filter);
    const ran: string[] = [];
    pipeline.register('ip-rules', () => void ran.push('first'));
    pipeline.register('maintenance', () => void ran.push('second'));
    const fastify = fakeFastify();
    pipeline.install(fastify.instance);
    await fastify.hooks[0]!.run(request, reply(true));
    expect(ran).toEqual(['first']);
  });

  it('refuses a second handler for one stage and phase, and a second install', () => {
    const pipeline = new RequestPipeline(fakeFilter().filter);
    pipeline.register('ip-rules', () => undefined);
    expect(() => pipeline.register('ip-rules', () => undefined)).toThrow(/already has a onRequest handler/);
    expect(() => pipeline.register('ip-rules', () => undefined, 'preValidation' satisfies PipelinePhase)).not.toThrow();
    pipeline.install(fakeFastify().instance);
    expect(() => pipeline.install(fakeFastify().instance)).toThrow(/already installed/);
  });
});
