// Unit tests of the transaction helper (decisions 022, 024) with a fake database: when afterCommit callbacks run.
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { Logger } from '@nestjs/common';
import { type TransactionContext, type TransactionRunner, runInTransaction } from './transaction';
import { rejectionOf } from '../../../test/support/rejection';

/** A runner whose `transaction` behaves like Drizzle's: run the callback, then commit (or fail to). */
function fakeRunner(options: { commitFails?: boolean } = {}) {
  const configs: unknown[] = [];
  const events: string[] = [];
  const runner = {
    transaction: async (fn: (tx: unknown) => Promise<unknown>, config?: unknown) => {
      configs.push(config);
      events.push('begin');
      try {
        const result = await fn({ fake: 'tx' });
        if (options.commitFails) throw new Error('commit failed');
        events.push('commit');
        return result;
      } catch (error) {
        events.push('rollback');
        throw error;
      }
    },
  } as unknown as TransactionRunner;
  return { runner, configs, events };
}

let logged: string[];
beforeEach(() => {
  logged = [];
  spyOn(Logger.prototype, 'error').mockImplementation((message: unknown) => {
    logged.push(String(message));
  });
});
afterEach(() => {
  (Logger.prototype.error as unknown as { mockRestore: () => void }).mockRestore();
});

describe('runInTransaction', () => {
  it('returns the result and runs afterCommit callbacks in order after the commit', async () => {
    const { runner, events } = fakeRunner();
    const result = await runInTransaction(runner, ({ afterCommit }) => {
      afterCommit(() => void events.push('first'));
      afterCommit(async () => {
        await Promise.resolve();
        events.push('second');
      });
      events.push('work');
      return Promise.resolve(42);
    });
    expect(result).toBe(42);
    expect(events).toEqual(['begin', 'work', 'commit', 'first', 'second']);
  });

  it('hands the callback the transaction handle', async () => {
    const { runner } = fakeRunner();
    let seen: TransactionContext['tx'] | undefined;
    await runInTransaction(runner, ({ tx }) => {
      seen = tx;
      return Promise.resolve();
    });
    expect(seen).toEqual({ fake: 'tx' } as never);
  });

  it('runs no callback when the work throws, and rethrows', async () => {
    const { runner, events } = fakeRunner();
    const error = await rejectionOf(
      runInTransaction(runner, ({ afterCommit }) => {
        afterCommit(() => void events.push('callback'));
        return Promise.reject(new Error('boom'));
      }),
    );
    expect(String(error)).toContain('boom');
    expect(events).toEqual(['begin', 'rollback']);
  });

  it('runs no callback when the commit itself fails', async () => {
    const { runner, events } = fakeRunner({ commitFails: true });
    const error = await rejectionOf(
      runInTransaction(runner, ({ afterCommit }) => {
        afterCommit(() => void events.push('callback'));
        return Promise.resolve();
      }),
    );
    expect(String(error)).toContain('commit failed');
    expect(events).not.toContain('callback');
  });

  it('logs a failing callback and still runs the rest, keeping the result', async () => {
    const { runner, events } = fakeRunner();
    const result = await runInTransaction(runner, ({ afterCommit }) => {
      afterCommit(() => {
        throw new Error('cache down');
      });
      afterCommit(() => void events.push('after the failure'));
      return Promise.resolve('ok');
    });
    expect(result).toBe('ok');
    expect(events).toContain('after the failure');
    expect(logged).toEqual(['afterCommit callback failed: cache down']);
  });

  it('refuses afterCommit once the transaction has ended', async () => {
    const { runner } = fakeRunner();
    let late: TransactionContext['afterCommit'] | undefined;
    await runInTransaction(runner, ({ afterCommit }) => {
      late = afterCommit;
      return Promise.resolve();
    });
    expect(() => late!(() => undefined)).toThrow('after the transaction ended');
  });

  it('passes the isolation level to the driver, and nothing by default', async () => {
    const { runner, configs } = fakeRunner();
    await runInTransaction(runner, () => Promise.resolve());
    await runInTransaction(runner, () => Promise.resolve(), { isolation: 'serializable' });
    expect(configs).toEqual([undefined, { isolationLevel: 'serializable' }]);
  });

  it('passes read only to the driver, alone or with an isolation level', async () => {
    const { runner, configs } = fakeRunner();
    await runInTransaction(runner, () => Promise.resolve(), { readOnly: true });
    await runInTransaction(runner, () => Promise.resolve(), { isolation: 'repeatable read', readOnly: true });
    expect(configs).toEqual([
      { accessMode: 'read only' },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    ]);
  });
});
