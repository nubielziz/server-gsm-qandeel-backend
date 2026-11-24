// Unit test of the registry of rank change checks (decision 064): it collects every blocker before the rank change writes anything.
import { describe, expect, it } from 'bun:test';
import type { Transaction } from '@src/infra/db';
import { RankChangeGuards } from '@src/modules/money/ports/rank-change-guards';

const tx = {} as Transaction;

describe('RankChangeGuards', () => {
  it('finds no blocker when nothing is registered', async () => {
    expect(await new RankChangeGuards().blockersOf(tx, 3)).toEqual([]);
  });

  it('runs every check with the transaction and the account, in registration order', async () => {
    const guards = new RankChangeGuards();
    const calls: string[] = [];
    guards.register('live_order', (_tx, accountId) => {
      calls.push(`live_order:${accountId}`);
      return Promise.resolve(['live_order']);
    });
    guards.register('open_checkout', (given, accountId) => {
      calls.push(`open_checkout:${accountId}:${given === tx}`);
      return Promise.resolve(['open_checkout']);
    });
    expect(await guards.blockersOf(tx, 9)).toEqual(['live_order', 'open_checkout']);
    expect(calls).toEqual(['live_order:9', 'open_checkout:9:true']);
    expect(guards.names()).toEqual(['live_order', 'open_checkout']);
  });

  it('collects the blockers of all checks, not only the first one that finds any, and names each code once', async () => {
    const guards = new RankChangeGuards();
    guards.register('a', () => Promise.resolve(['live_order', 'frozen']));
    guards.register('b', () => Promise.resolve([]));
    guards.register('c', () => Promise.resolve(['frozen', 'open_checkout']));
    expect(await guards.blockersOf(tx, 1)).toEqual(['live_order', 'frozen', 'open_checkout']);
  });

  it('refuses a second check with the same name: a boot error, not a silent replacement', () => {
    const guards = new RankChangeGuards();
    guards.register('live_order', () => Promise.resolve([]));
    expect(() => guards.register('live_order', () => Promise.resolve([]))).toThrow('already registered');
  });

  it('lets a failing check fail the whole change instead of hiding a blocker', async () => {
    const guards = new RankChangeGuards();
    guards.register('broken', () => Promise.reject(new Error('read failed')));
    guards.register('later', () => Promise.resolve(['frozen']));
    const error = await guards.blockersOf(tx, 1).then(
      () => undefined,
      (failure: unknown) => failure,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('read failed');
  });
});
