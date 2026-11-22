// Unit tests of the transaction helper (decisions 022, 024, 037) with a fake database: when afterCommit and onCommit callbacks run.
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { Logger } from '@nestjs/common';
import {
  type TransactionContext,
  type TransactionRunner,
  onCommit,
  runInTransaction,
  runOrDiscard,
} from '@src/infra/db/transaction';
import { rejectionOf } from '../../../support/rejection';

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

/** A runner whose `transaction` also offers savepoints: `tx.transaction(fn)` runs `fn` and rolls only it back on a throw. */
function savepointRunner() {
  const events: string[] = [];
  const tx = {
    transaction: async (fn: (savepoint: unknown) => Promise<unknown>) => {
      events.push('savepoint');
      try {
        return await fn(tx);
      } catch (error) {
        events.push('rollback to savepoint');
        throw error;
      }
    },
  };
  const runner = {
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      const result = await fn(tx);
      events.push('commit');
      return result;
    },
  } as unknown as TransactionRunner;
  return { runner, events };
}

describe('onCommit (decision 037)', () => {
  it('runs after the commit, in order with afterCommit, from anywhere in the async context', async () => {
    const { runner, events } = fakeRunner();
    const deep = async () => {
      await Promise.resolve();
      onCommit(() => void events.push('doorbell'));
    };
    await runInTransaction(runner, async ({ afterCommit }) => {
      afterCommit(() => void events.push('cache'));
      await deep();
      events.push('work');
    });
    expect(events).toEqual(['begin', 'work', 'commit', 'cache', 'doorbell']);
  });

  it('runs nothing after a rollback or a failed commit', async () => {
    for (const commitFails of [false, true]) {
      const { runner, events } = fakeRunner({ commitFails });
      await rejectionOf(
        runInTransaction(runner, () => {
          onCommit(() => void events.push('doorbell'));
          return commitFails ? Promise.resolve() : Promise.reject(new Error('boom'));
        }),
      );
      expect(events).not.toContain('doorbell');
    }
  });

  it('runs at once without a transaction', () => {
    const events: string[] = [];
    onCommit(() => void events.push('now'));
    expect(events).toEqual(['now']);
  });

  it('shares the list with a savepoint, even one that rolled back', async () => {
    const { runner, events } = savepointRunner();
    await runInTransaction(runner, async ({ tx }) => {
      const savepoints = tx as unknown as { transaction: (fn: () => Promise<void>) => Promise<void> };
      await savepoints.transaction(() => {
        onCommit(() => void events.push('kept'));
        return Promise.resolve();
      });
      await rejectionOf(
        savepoints.transaction(() => {
          onCommit(() => void events.push('rolled back savepoint'));
          return Promise.reject(new Error('one item failed'));
        }),
      );
    });
    expect(events).toEqual([
      'savepoint',
      'savepoint',
      'rollback to savepoint',
      'commit',
      'kept',
      'rolled back savepoint',
    ]);
  });

  it('keeps the lists of nested transactions apart', async () => {
    const outer = fakeRunner();
    const inner = fakeRunner();
    const events: string[] = [];
    await rejectionOf(
      runInTransaction(outer.runner, async () => {
        onCommit(() => void events.push('outer'));
        await runInTransaction(inner.runner, () => {
          onCommit(() => void events.push('inner'));
          return Promise.resolve();
        });
        expect(events).toEqual(['inner']);
        throw new Error('the outer one rolls back');
      }),
    );
    expect(events).toEqual(['inner']);
  });

  it('runs a callback registered after the commit at once, and drops one registered after a rollback', async () => {
    const events: string[] = [];
    let late: Promise<void> | undefined;
    await runInTransaction(fakeRunner().runner, () => {
      late = (async () => {
        await new Promise((resolve) => setImmediate(resolve));
        onCommit(() => void events.push('late after commit'));
      })();
      return Promise.resolve();
    });
    await late;
    await rejectionOf(
      runInTransaction(fakeRunner().runner, () => {
        late = (async () => {
          await new Promise((resolve) => setImmediate(resolve));
          onCommit(() => void events.push('late after rollback'));
        })();
        return Promise.reject(new Error('boom'));
      }),
    );
    await late;
    expect(events).toEqual(['late after commit']);
  });

  it('logs a failing callback, thrown or rejected, and never throws to the caller', async () => {
    onCommit(() => {
      throw new Error('redis down');
    });
    onCommit(() => Promise.reject(new Error('publish failed')));
    await new Promise((resolve) => setImmediate(resolve));
    expect(logged).toEqual(['afterCommit callback failed: redis down', 'afterCommit callback failed: publish failed']);
  });
});

describe('runOrDiscard (decision 052)', () => {
  it('commits a run that answers true, runs its afterCommit callbacks and returns true', async () => {
    const { runner, events } = fakeRunner();
    const kept = await runOrDiscard(runner, ({ afterCommit }) => {
      afterCommit(() => void events.push('callback'));
      events.push('work');
      return Promise.resolve(true);
    });
    expect(kept).toBe(true);
    expect(events).toEqual(['begin', 'work', 'commit', 'callback']);
  });

  it('rolls back a run that answers false, runs no callback and returns false', async () => {
    const { runner, events } = fakeRunner();
    const kept = await runOrDiscard(runner, ({ afterCommit }) => {
      afterCommit(() => void events.push('callback'));
      onCommit(() => void events.push('on commit'));
      events.push('work');
      return Promise.resolve(false);
    });
    expect(kept).toBe(false);
    expect(events).toEqual(['begin', 'work', 'rollback']);
  });

  it('rethrows an error of the work (the transaction is rolled back too)', async () => {
    const { runner, events } = fakeRunner();
    const error = await rejectionOf(runOrDiscard(runner, () => Promise.reject(new Error('boom'))));
    expect((error as Error).message).toBe('boom');
    expect(events).toEqual(['begin', 'rollback']);
  });

  it('rethrows the error of a commit that fails after a true answer', async () => {
    const { runner } = fakeRunner({ commitFails: true });
    const error = await rejectionOf(runOrDiscard(runner, () => Promise.resolve(true)));
    expect((error as Error).message).toBe('commit failed');
  });
});
