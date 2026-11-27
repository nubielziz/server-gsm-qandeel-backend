// Unit tests of the dispatch job's processor (decision 075): an order inside its cancel window moves the job to `delayed` until the window
// ends and ends the run with DelayedError; every other outcome is the job's result, as before.
import { describe, expect, it, mock } from 'bun:test';
import { DelayedError, type Job, UnrecoverableError } from '@src/infra/queues';
import type { OutboxJobData } from '@src/modules/platform';
import type { DispatchOutcome, SupplierDispatch } from '@src/modules/suppliers/application/supplier-dispatch';
import { SupplierDispatchProcessor } from '@src/modules/suppliers/jobs/supplier-dispatch.processor';

const UNTIL = new Date('2026-11-27T10:02:00.000Z');

function setup(outcome: DispatchOutcome, job: { attemptsMade?: number; orderId?: number | undefined } = {}) {
  const run = mock(() => Promise.resolve(outcome));
  const moveToDelayed = mock(() => Promise.resolve());
  const processor = new SupplierDispatchProcessor({ run } as unknown as SupplierDispatch);
  const fake = {
    data: { payload: 'orderId' in job ? { orderId: job.orderId } : { orderId: 77 } },
    opts: { attempts: 3 },
    attemptsMade: job.attemptsMade ?? 0,
    moveToDelayed,
  } as unknown as Job<OutboxJobData, DispatchOutcome, string>;
  return { processor, fake, run, moveToDelayed };
}

describe('SupplierDispatchProcessor', () => {
  it('moves the job to delayed until the end of the cancel window with its lock token, then ends the run with DelayedError', async () => {
    const { processor, fake, run, moveToDelayed } = setup({ status: 'deferred', until: UNTIL });
    let thrown: unknown;
    try {
      await processor.process(fake, 'worker-1:7');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(DelayedError);
    expect(moveToDelayed).toHaveBeenCalledTimes(1);
    expect(moveToDelayed).toHaveBeenCalledWith(UNTIL.getTime(), 'worker-1:7');
    expect(run).toHaveBeenCalledWith(77, { lastAttempt: false });
  });

  it('returns every other outcome as the job result and never moves the job', async () => {
    for (const outcome of [
      { status: 'sent', reference: 'R-1' },
      { status: 'needs_attention', reason: 'refused' },
      { status: 'skipped', reason: 'not_pending' },
    ] as const) {
      const { processor, fake, moveToDelayed } = setup(outcome);
      expect(await processor.process(fake, 'worker-1:8')).toEqual(outcome);
      expect(moveToDelayed).not.toHaveBeenCalled();
    }
  });

  it('tells the dispatch when the queue will not retry it again', async () => {
    const { processor, fake, run } = setup({ status: 'skipped', reason: 'not_pending' }, { attemptsMade: 2 });
    await processor.process(fake, 'worker-1:9');
    expect(run).toHaveBeenCalledWith(77, { lastAttempt: true });
  });

  it('refuses a payload without an order id for good', async () => {
    const { processor, fake, run } = setup({ status: 'skipped', reason: 'not_found' }, { orderId: undefined });
    let thrown: unknown;
    try {
      await processor.process(fake, 'worker-1:10');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(UnrecoverableError);
    expect(run).not.toHaveBeenCalled();
  });
});
