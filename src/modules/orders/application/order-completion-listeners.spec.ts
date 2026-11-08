// Unit tests of the order completion listener registry (feature 11): which money moves reach the listeners, in which order, and that a
// failing listener fails the call (its rows belong to the order's transaction).
import { describe, expect, it } from 'bun:test';
import type { DbExecutor } from '../../../infra/db';
import type { Order } from '../db/schema';
import { type OrderCompletionListener, OrderCompletionListeners } from './order-completion-listeners';

const tx = {} as DbExecutor;
const order = { id: 7 } as Order;
const actor = { type: 'staff', id: 3 } as const;

function recorder(name: string, log: string[]): OrderCompletionListener {
  return {
    orderCompleted: (_tx, o, who) => {
      log.push(`${name}:completed:${o.id}:${who.type}`);
      return Promise.resolve();
    },
    orderReversed: (_tx, o, reason) => {
      log.push(`${name}:reversed:${o.id}:${reason}`);
      return Promise.resolve();
    },
  };
}

describe('OrderCompletionListeners.afterMove', () => {
  it('tells the listeners, in the order they registered, about a settlement', async () => {
    const log: string[] = [];
    const registry = new OrderCompletionListeners();
    registry.add(recorder('a', log));
    registry.add(recorder('b', log));
    await registry.afterMove(tx, order, 'complete', actor);
    await registry.afterMove(tx, order, 'b2c_deliver', actor);
    expect(log).toEqual(['a:completed:7:staff', 'b:completed:7:staff', 'a:completed:7:staff', 'b:completed:7:staff']);
  });

  it('tells them about a reopen and a refund as reversals with their reason', async () => {
    const log: string[] = [];
    const registry = new OrderCompletionListeners();
    registry.add(recorder('a', log));
    await registry.afterMove(tx, order, 'reopen', actor);
    await registry.afterMove(tx, order, 'refund', actor);
    expect(log).toEqual(['a:reversed:7:reopen', 'a:reversed:7:refund']);
  });

  it('says nothing about the moves that are not a settlement or a reversal', async () => {
    const log: string[] = [];
    const registry = new OrderCompletionListeners();
    registry.add(recorder('a', log));
    for (const move of ['reject', 'b2c_refund', null] as const) await registry.afterMove(tx, order, move, actor);
    expect(log).toEqual([]);
  });

  it('lets a listener fail the call, so the transition rolls back', async () => {
    const registry = new OrderCompletionListeners();
    registry.add({
      orderCompleted: () => Promise.reject(new Error('accrual failed')),
      orderReversed: () => Promise.resolve(),
    });
    const outcome = await registry.afterMove(tx, order, 'complete', actor).then(
      () => 'resolved',
      (error: Error) => error.message,
    );
    expect(outcome).toBe('accrual failed');
  });

  it('is fine with no listener at all', async () => {
    await new OrderCompletionListeners().afterMove(tx, order, 'complete', actor);
  });
});

describe('OrderCompletionListeners.beforeMove', () => {
  const locker = (log: string[]): OrderCompletionListener => ({
    orderCompleted: () => Promise.resolve(),
    orderReversed: () => Promise.resolve(),
    lockForReversal: (_tx, o) => {
      log.push(`lock:${o.id}`);
      return Promise.resolve();
    },
  });

  it('asks the listeners to lock before a reopen or a refund is posted, and only then', async () => {
    const log: string[] = [];
    const registry = new OrderCompletionListeners();
    registry.add(locker(log));
    for (const move of ['reopen', 'refund'] as const) await registry.beforeMove(tx, order, move);
    expect(log).toEqual(['lock:7', 'lock:7']);
    log.length = 0;
    for (const move of ['complete', 'b2c_deliver', 'reject', 'b2c_refund', null] as const) {
      await registry.beforeMove(tx, order, move);
    }
    expect(log).toEqual([]);
  });

  it('is fine with a listener that has no hook, and with no listener at all', async () => {
    const log: string[] = [];
    const registry = new OrderCompletionListeners();
    await registry.beforeMove(tx, order, 'refund');
    registry.add(recorder('a', log));
    await registry.beforeMove(tx, order, 'refund');
    expect(log).toEqual([]);
  });

  it('lets a listener fail the call, so the transition rolls back before anything is posted', async () => {
    const registry = new OrderCompletionListeners();
    registry.add({
      orderCompleted: () => Promise.resolve(),
      orderReversed: () => Promise.resolve(),
      lockForReversal: () => Promise.reject(new Error('lock failed')),
    });
    const outcome = await registry.beforeMove(tx, order, 'refund').then(
      () => 'resolved',
      (error: Error) => error.message,
    );
    expect(outcome).toBe('lock failed');
  });
});
