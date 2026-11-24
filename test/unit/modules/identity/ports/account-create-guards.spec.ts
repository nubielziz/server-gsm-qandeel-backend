// Unit test of the registry of account create checks (decision 064): the staff create runs every registered check before it writes.
import { describe, expect, it } from 'bun:test';
import { AppError } from '@src/common/errors';
import type { Transaction } from '@src/infra/db';
import { AccountCreateGuards } from '@src/modules/identity/ports/account-create-guards';

const tx = {} as Transaction;

describe('AccountCreateGuards', () => {
  it('allows the create when nothing is registered', async () => {
    expect(await new AccountCreateGuards().run(tx, { email: 'a@example.com', rankKind: 'retail' })).toBeUndefined();
  });

  it('gives every check the transaction, the email and the rank kind, in registration order', async () => {
    const guards = new AccountCreateGuards();
    const seen: string[] = [];
    guards.register('blocklist', (given, facts) => {
      seen.push(`blocklist:${facts.email}:${facts.rankKind}:${given === tx}`);
      return Promise.resolve();
    });
    guards.register('other', (_tx, facts) => {
      seen.push(`other:${facts.rankKind}`);
      return Promise.resolve();
    });
    await guards.run(tx, { email: 'b@example.com', rankKind: 'merchant' });
    expect(seen).toEqual(['blocklist:b@example.com:merchant:true', 'other:merchant']);
    expect(guards.names()).toEqual(['blocklist', 'other']);
  });

  it('stops at the first refusal and lets its error through unchanged', async () => {
    const guards = new AccountCreateGuards();
    const refusal = new AppError('CONFLICT', { detail: 'This email is blocked.' });
    let laterRan = false;
    guards.register('blocklist', () => Promise.reject(refusal));
    guards.register('later', () => {
      laterRan = true;
      return Promise.resolve();
    });
    const error = await guards.run(tx, { email: 'c@example.com', rankKind: 'retail' }).then(
      () => undefined,
      (failure: unknown) => failure,
    );
    expect(error).toBe(refusal);
    expect(laterRan).toBe(false);
  });

  it('refuses a second check with the same name', () => {
    const guards = new AccountCreateGuards();
    guards.register('blocklist', () => Promise.resolve());
    expect(() => guards.register('blocklist', () => Promise.resolve())).toThrow('already registered');
  });
});
