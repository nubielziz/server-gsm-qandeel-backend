// Unit tests of the DhruGateway (decision 026): the action lookup, the parameter checks, the success shaping and the per-item answers of a bulk call.
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { Logger } from '@nestjs/common';
import { z } from 'zod';
import type { MetricsService } from '../../infra/metrics/metrics.service';
import { AppError } from '../errors';
import type { AnyDhruAction } from './define-dhru-action';
import { DHRU_MAX_BULK_ITEMS, DhruGateway, type DhruCaller, type DhruExecution } from './dhru-gateway';

const caller: DhruCaller = { clientId: 7, clientName: 'Cairo GSM Lab', keyId: 3 };

/** A contract built by hand: `defineDhruAction` would register it in the process-wide registry. */
function contract(action: string, overrides: Partial<AnyDhruAction> = {}): AnyDhruAction {
  return {
    key: `DHRU ${action}`,
    action,
    summary: action,
    description: undefined,
    bulk: false,
    params: z.object({ ID: z.coerce.number().int().positive() }),
    success: z.object({ STATUS: z.number(), CODE: z.string() }),
    errors: [],
    examples: { request: undefined, response: undefined },
    ...overrides,
  };
}

/** A gateway with a metrics stub that records the failures it is told about. */
function gateway() {
  const recorded: Array<Record<string, string>> = [];
  const metrics = {
    recordApiError: (labels: Record<string, string>) => recorded.push(labels),
  } as unknown as MetricsService;
  return { gateway: new DhruGateway(metrics), recorded };
}

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
const call = (action: string, parameters: unknown): DhruExecution => ({ action, parameters, files: [], caller });

/** The error a run throws. */
async function refusal(run: Promise<unknown>): Promise<AppError> {
  try {
    await run;
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

describe('DhruGateway.execute (a single action)', () => {
  it('runs the handler with the validated parameters and wraps its entry in the SUCCESS envelope', async () => {
    const { gateway: g } = gateway();
    const seen: unknown[] = [];
    g.bind(contract('getthing'), (c) => {
      seen.push(c.params, c.caller, c.itemId);
      return { STATUS: 4, CODE: 'done', extra: 'stripped' };
    });
    const answer = await g.execute(call('GetThing', b64({ ID: '12' })));
    expect(answer).toEqual({ SUCCESS: [{ STATUS: 4, CODE: 'done' }], apiversion: '6.1' });
    // The text id was coerced to a number, the caller is passed on and a single call has no item id.
    expect(seen).toEqual([{ ID: 12 }, caller, null]);
    expect(g.boundActions()).toEqual(['getthing']);
  });

  it('answers "Invalid Action" for an action nobody owns, and refuses to bind an action twice', async () => {
    const { gateway: g } = gateway();
    const error = await refusal(g.execute(call('nope', undefined)));
    expect(error).toMatchObject({ code: 'BAD_REQUEST', detail: 'Invalid Action' });
    g.bind(contract('once'), () => ({ STATUS: 0, CODE: '' }));
    expect(() => g.bind(contract('once'), () => ({ STATUS: 0, CODE: '' }))).toThrow('already has a handler');
  });

  it('names the first field that does not fit as the message, and shapes nothing the handler got wrong', async () => {
    const { gateway: g } = gateway();
    g.bind(contract('strict'), () => ({ STATUS: 'bad' }));
    const invalid = await refusal(g.execute(call('strict', b64({ ID: 'x' }))));
    expect(invalid.code).toBe('VALIDATION_FAILED');
    expect(invalid.detail).toBe('ID: Invalid input: expected number, received NaN');
    const missing = await refusal(g.execute(call('strict', undefined)));
    expect(missing.detail).toMatch(/^ID: /);
    // A handler whose entry does not satisfy the success schema is a bug of ours, not of the caller.
    const broken = await refusal(g.execute(call('strict', b64({ ID: 1 }))));
    expect(broken.code).toBe('RESPONSE_CONTRACT_VIOLATION');
  });

  it('runs an action without parameters with undefined params', async () => {
    const { gateway: g } = gateway();
    let params: unknown = 'unset';
    g.bind(contract('noparams', { params: undefined, success: z.object({ ok: z.boolean() }) }), (c) => {
      params = c.params;
      return { ok: true };
    });
    expect(await g.execute(call('noparams', undefined))).toEqual({ SUCCESS: [{ ok: true }], apiversion: '6.1' });
    expect(params).toBeUndefined();
  });
});

describe('DhruGateway.execute (a bulk action)', () => {
  const bulk = () => contract('getmany', { bulk: true });
  const spies: Array<{ mockRestore(): void }> = [];

  // A refused item is logged on purpose; the tests keep the output quiet.
  beforeEach(() => {
    spies.push(
      spyOn(Logger.prototype, 'log').mockImplementation(() => {}),
      spyOn(Logger.prototype, 'error').mockImplementation(() => {}),
    );
  });
  afterEach(() => {
    for (const spy of spies.splice(0)) spy.mockRestore();
  });

  it('answers each request id on its own, in the order sent, with apiversion last', async () => {
    const { gateway: g, recorded } = gateway();
    const seen: Array<string | null> = [];
    g.bind(bulk(), (c) => {
      seen.push(c.itemId);
      // The test contract is built as AnyDhruAction, so the params are typed unknown here.
      const { ID } = c.params as { ID: number };
      if (ID === 2) throw new AppError('NOT_FOUND', { detail: 'Order not found' });
      return { STATUS: 4, CODE: `r${ID}` };
    });
    const answer = await g.execute(
      call('getmany', b64({ first: { ID: 1 }, second: { ID: 2 }, third: { ID: 'x' }, fourth: { ID: 4 } })),
    );
    expect(Object.keys(answer)).toEqual(['first', 'second', 'third', 'fourth', 'apiversion']);
    expect(answer.first).toEqual({ SUCCESS: [{ STATUS: 4, CODE: 'r1' }] });
    expect(answer.second).toEqual({ ERROR: [{ MESSAGE: 'Order not found' }] });
    expect(answer.third).toEqual({ ERROR: [{ MESSAGE: expect.stringMatching(/^ID: /) }] });
    expect(answer.fourth).toEqual({ SUCCESS: [{ STATUS: 4, CODE: 'r4' }] });
    expect(seen).toEqual(['first', 'second', 'fourth']);
    // A refused item is counted under its catalog code like any refusal.
    expect(recorded.map((labels) => labels.code)).toEqual(['NOT_FOUND', 'VALIDATION_FAILED']);
    expect(recorded[0]).toMatchObject({ surface: 'dhru', method: 'POST', route: '/api/index.php', status: '404' });
  });

  it('answers an item that fails unexpectedly with the catalog text and never the error message', async () => {
    const { gateway: g, recorded } = gateway();
    g.bind(bulk(), () => {
      throw new Error('connection to 10.0.0.5 refused');
    });
    const answer = await g.execute(call('getmany', b64({ a: { ID: 1 } })));
    expect(JSON.stringify(answer)).not.toContain('10.0.0.5');
    expect(recorded[0]).toMatchObject({ code: 'INTERNAL_ERROR', status: '500' });
  });

  it('refuses a call with no items, more than the limit, and the reserved id apiversion', async () => {
    const { gateway: g } = gateway();
    g.bind(bulk(), () => ({ STATUS: 0, CODE: '' }));
    expect((await refusal(g.execute(call('getmany', b64({}))))).detail).toBe('Send at least one item.');
    const many = Object.fromEntries(
      Array.from({ length: DHRU_MAX_BULK_ITEMS + 1 }, (_, index) => [`r${index}`, { ID: 1 }]),
    );
    expect((await refusal(g.execute(call('getmany', b64(many))))).detail).toBe(
      `At most ${DHRU_MAX_BULK_ITEMS} items per call.`,
    );
    expect((await refusal(g.execute(call('getmany', b64({ apiversion: { ID: 1 } }))))).detail).toBe(
      'apiversion is not a valid item id.',
    );
    const exact = Object.fromEntries(
      Array.from({ length: DHRU_MAX_BULK_ITEMS }, (_, index) => [`r${index}`, { ID: 1 }]),
    );
    expect(Object.keys(await g.execute(call('getmany', b64(exact)))).length).toBe(DHRU_MAX_BULK_ITEMS + 1);
  });
});
