// Unit tests of the live_order check of the rank change (decision 064): it registers under its own name with the money module's
// registry, and it answers the blocker only when the account has an order in flight. The query itself is proved against a database in
// test/integration/orders/orders-account-buyer.test.ts.
import { describe, expect, it } from 'bun:test';
import type { Transaction } from '@src/infra/db';
import { RankChangeGuards } from '@src/modules/money/ports/rank-change-guards';
import { LIVE_ORDERS_GUARD, LiveOrdersGuard } from '@src/modules/orders/application/live-orders-guard';

/** A transaction whose one select answers the given rows. */
const answering = (rows: Array<{ id: number }>): Transaction =>
  ({ select: () => ({ from: () => ({ where: () => ({ limit: () => Promise.resolve(rows) }) }) }) }) as never;

describe('LiveOrdersGuard', () => {
  it('registers the check under the name live_order, once', () => {
    const guards = new RankChangeGuards();
    const guard = new LiveOrdersGuard(guards);
    guard.onModuleInit();
    expect(LIVE_ORDERS_GUARD).toBe('live_order');
    expect(guards.names()).toEqual(['live_order']);
    expect(() => guard.onModuleInit()).toThrow('already registered');
  });

  it('answers the live_order blocker when the account has an order in flight and nothing otherwise', async () => {
    const guard = new LiveOrdersGuard(new RankChangeGuards());
    expect(await guard.blockersOf(answering([{ id: 9 }]), 5)).toEqual(['live_order']);
    expect(await guard.blockersOf(answering([]), 5)).toEqual([]);
  });

  it('is what the rank change collects through the registry', async () => {
    const guards = new RankChangeGuards();
    new LiveOrdersGuard(guards).onModuleInit();
    expect(await guards.blockersOf(answering([{ id: 9 }]), 5)).toEqual(['live_order']);
    expect(await guards.blockersOf(answering([]), 5)).toEqual([]);
  });
});
