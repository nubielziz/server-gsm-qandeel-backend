// Unit test of the registry of guest claim participants (decision 064): every module that holds a guest's records registers a mover, and the claim
// calls them all in one transaction.
import { describe, expect, it } from 'bun:test';
import type { Transaction } from '@src/infra/db';
import { GuestClaimParticipants } from '@src/modules/identity/ports/guest-claim-participants';

const tx = {} as Transaction;

describe('GuestClaimParticipants', () => {
  it('moves nothing when no participant is registered', async () => {
    expect(await new GuestClaimParticipants().moveAll(tx, { guestId: 1, accountId: 2 })).toEqual({});
  });

  it('calls every participant with the transaction and both ids, in registration order, and returns the counts by name', async () => {
    const claim = new GuestClaimParticipants();
    const seen: string[] = [];
    claim.register('orders', (given, ids) => {
      seen.push(`orders:${ids.guestId}>${ids.accountId}:${given === tx}`);
      return Promise.resolve(3);
    });
    claim.register('payments', (_tx, ids) => {
      seen.push(`payments:${ids.guestId}>${ids.accountId}`);
      return Promise.resolve(0);
    });
    expect(await claim.moveAll(tx, { guestId: 40, accountId: 7 })).toEqual({ orders: 3, payments: 0 });
    expect(seen).toEqual(['orders:40>7:true', 'payments:40>7']);
    expect(claim.names()).toEqual(['orders', 'payments']);
  });

  it('refuses a second participant with the same name', () => {
    const claim = new GuestClaimParticipants();
    claim.register('orders', () => Promise.resolve(0));
    expect(() => claim.register('orders', () => Promise.resolve(1))).toThrow('already registered');
  });

  it('lets the lock error of a participant reach the claim, which rolls back to its savepoint: no later participant runs', async () => {
    const claim = new GuestClaimParticipants();
    const lockNotAvailable = Object.assign(new Error('could not obtain lock on row'), { code: '55P03' });
    let laterRan = false;
    claim.register('first', () => Promise.reject(lockNotAvailable));
    claim.register('later', () => {
      laterRan = true;
      return Promise.resolve(1);
    });
    const error = await claim.moveAll(tx, { guestId: 1, accountId: 2 }).then(
      () => undefined,
      (failure: unknown) => failure,
    );
    expect(error).toBe(lockNotAvailable);
    expect(laterRan).toBe(false);
  });
});
