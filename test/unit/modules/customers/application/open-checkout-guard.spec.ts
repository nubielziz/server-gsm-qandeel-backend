// Unit tests of the open_checkout check of the rank change (decision 064): what it asks of the database and what it answers,
// with a fake transaction. The real rows (a signed-in checkout, a paid one, an expired one, a guest's) are proved on Postgres in
// test/integration/customers/checkout-accounts.test.ts.
import { describe, expect, it } from 'bun:test';
import { TestClock } from '../../../../support/clock';
import type { Transaction } from '@src/infra/db';
import { RankChangeGuards } from '@src/modules/money';
import { OPEN_CHECKOUT_GUARD, OpenCheckoutGuard } from '@src/modules/customers/application/open-checkout-guard';

const clock = new TestClock('2026-11-10T12:00:00.000Z');

/** A transaction whose one read answers with `rows`. */
function fakeTransaction(rows: Array<{ id: number }>) {
  const select = { from: () => select, where: () => select, limit: () => Promise.resolve(rows) };
  return { select: () => select } as unknown as Transaction;
}

describe('OpenCheckoutGuard', () => {
  it('registers with the rank change under the name open_checkout', () => {
    const registry = new RankChangeGuards();
    new OpenCheckoutGuard(registry, clock).onModuleInit();
    expect(OPEN_CHECKOUT_GUARD).toBe('open_checkout');
    expect(registry.names()).toEqual(['open_checkout']);
  });

  it('answers open_checkout when the account has a signed-in checkout that is neither paid nor expired, and nothing otherwise', async () => {
    const guard = new OpenCheckoutGuard(new RankChangeGuards(), clock);
    expect(await guard.check(fakeTransaction([{ id: 9 }]), 4)).toEqual(['open_checkout']);
    expect(await guard.check(fakeTransaction([]), 4)).toEqual([]);
  });

  it('is run by the rank change with the other checks, each code once', async () => {
    const registry = new RankChangeGuards();
    new OpenCheckoutGuard(registry, clock).onModuleInit();
    expect(await registry.blockersOf(fakeTransaction([{ id: 9 }]), 4)).toEqual(['open_checkout']);
    expect(await registry.blockersOf(fakeTransaction([]), 4)).toEqual([]);
  });
});
