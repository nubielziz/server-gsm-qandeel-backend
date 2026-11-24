// Unit tests of the guest-order claim (decision 064): what moves, what never moves, and the savepoint that answers `busy`
// instead of waiting. The participants are the real registry; the database is a fake that records its savepoints.
import { beforeEach, describe, expect, it } from 'bun:test';
import type { Transaction } from '@src/infra/db';
import type { AccountRecord } from '@src/modules/identity/accounts/account-directory';
import {
  GuestClaimBusy,
  GuestClaimService,
  ORDERS_PARTICIPANT,
} from '@src/modules/identity/application/guest-claim.service';
import { GuestClaimParticipants } from '@src/modules/identity/ports/guest-claim-participants';

const lockNotAvailable = Object.assign(new Error('could not obtain lock on row in relation "clients"'), {
  code: '55P03',
});

function accountOf(overrides: Partial<AccountRecord> = {}): AccountRecord {
  return {
    id: 7,
    email: 'buyer@example.com',
    name: 'Buyer',
    status: 'active',
    groupId: 1,
    rankKind: 'retail',
    hasAccount: true,
    hasPassword: false,
    emailVerifiedAt: new Date('2026-11-24T10:00:00Z'),
    country: 'GB',
    currency: null,
    ...overrides,
  };
}

/** A transaction whose savepoint hands the callback its own marker and records how each savepoint ended. */
function fakeTx() {
  const savepoint = { name: 'savepoint' } as unknown as Transaction;
  const ended: string[] = [];
  const tx = {
    transaction: async <T>(run: (inner: Transaction) => Promise<T>): Promise<T> => {
      try {
        const result = await run(savepoint);
        ended.push('released');
        return result;
      } catch (error) {
        ended.push('rolled back');
        throw error;
      }
    },
  } as unknown as Transaction;
  return { tx, savepoint, ended };
}

const audited: unknown[] = [];
let guest: AccountRecord | undefined;
let lockedWith: unknown[] = [];
let lockFails: Error | undefined;
const directory = {
  lockGuestNoWait: (given: unknown, email: string) => {
    lockedWith = [given, email];
    if (lockFails) return Promise.reject(lockFails);
    return Promise.resolve(guest);
  },
};
const audit = {
  record: (_tx: unknown, entry: unknown) => {
    audited.push(entry);
    return Promise.resolve({});
  },
};

let participants: GuestClaimParticipants;
const service = () => new GuestClaimService(directory as never, participants, audit as never);

beforeEach(() => {
  participants = new GuestClaimParticipants();
  audited.length = 0;
  lockedWith = [];
  lockFails = undefined;
  guest = accountOf({ id: 3, hasAccount: false });
});

describe('GuestClaimService.claim', () => {
  it("moves every participant's rows from the guest row to the account and audits the counts once", async () => {
    const seen: unknown[] = [];
    participants.register(ORDERS_PARTICIPANT, (given, ids) => {
      seen.push([given, ids]);
      return Promise.resolve(2);
    });
    participants.register('checkout sessions', () => Promise.resolve(1));
    const { tx, savepoint, ended } = fakeTx();

    const result = await service().claim(tx, accountOf());

    expect(result).toEqual({ claimedOrders: 2 });
    // The guest row and the participants work inside the savepoint, not on the exchange's own handle.
    expect(lockedWith).toEqual([savepoint, 'buyer@example.com']);
    expect(seen).toEqual([[savepoint, { guestId: 3, accountId: 7 }]]);
    expect(ended).toEqual(['released']);
    expect(audited).toEqual([
      {
        action: 'claimed guest orders',
        entityType: 'account',
        entityId: 7,
        entityLabel: 'Buyer',
        after: { guestId: 3, orders: 2, 'checkout sessions': 1 },
      },
    ]);
  });

  it('counts only the orders participant as claimed orders', async () => {
    participants.register('tickets', () => Promise.resolve(4));
    const result = await service().claim(fakeTx().tx, accountOf());
    expect(result).toEqual({ claimedOrders: 0 });
    // Something moved, so the audit row still says what.
    expect(audited).toHaveLength(1);
  });

  it('writes no audit row when nothing moved', async () => {
    participants.register(ORDERS_PARTICIPANT, () => Promise.resolve(0));
    expect(await service().claim(fakeTx().tx, accountOf())).toEqual({ claimedOrders: 0 });
    expect(audited).toHaveLength(0);
  });

  it('moves nothing for a merchant rank, a guest row itself or an account that may not act, and never locks the guest row', async () => {
    let called = false;
    participants.register(ORDERS_PARTICIPANT, () => {
      called = true;
      return Promise.resolve(1);
    });
    for (const account of [
      accountOf({ rankKind: 'merchant' }),
      accountOf({ hasAccount: false }),
      accountOf({ status: 'suspended' }),
      accountOf({ status: 'blocked' }),
      accountOf({ status: 'anonymized' }),
    ]) {
      expect(await service().claim(fakeTx().tx, account)).toEqual({ claimedOrders: 0 });
    }
    expect(called).toBe(false);
    expect(lockedWith).toEqual([]);
    expect(audited).toHaveLength(0);
  });

  it('moves nothing when no guest row holds the email, or the guest row is blocked', async () => {
    let called = false;
    participants.register(ORDERS_PARTICIPANT, () => {
      called = true;
      return Promise.resolve(1);
    });
    guest = undefined;
    expect(await service().claim(fakeTx().tx, accountOf())).toEqual({ claimedOrders: 0 });
    guest = accountOf({ id: 3, hasAccount: false, status: 'blocked' });
    expect(await service().claim(fakeTx().tx, accountOf())).toEqual({ claimedOrders: 0 });
    expect(called).toBe(false);
    expect(audited).toHaveLength(0);
  });

  it('answers busy at once when the guest row is held by another transaction (55P03), and moves nothing', async () => {
    let called = false;
    participants.register(ORDERS_PARTICIPANT, () => {
      called = true;
      return Promise.resolve(1);
    });
    lockFails = lockNotAvailable;
    const { tx, ended } = fakeTx();
    expect(await service().claim(tx, accountOf())).toEqual({ claimedOrders: 0, skipped: 'busy' });
    expect(called).toBe(false);
    expect(ended).toEqual(['rolled back']);
    expect(audited).toHaveLength(0);
  });

  it('answers busy when a participant meets a held row, and rolls back what the earlier participants moved', async () => {
    participants.register(ORDERS_PARTICIPANT, () => Promise.resolve(2));
    participants.register('payments', () => Promise.reject(lockNotAvailable));
    let laterRan = false;
    participants.register('tickets', () => {
      laterRan = true;
      return Promise.resolve(1);
    });
    const { tx, ended } = fakeTx();
    expect(await service().claim(tx, accountOf())).toEqual({ claimedOrders: 0, skipped: 'busy' });
    // The savepoint ended with a rollback, which takes the orders back; no later participant ran and nothing is audited.
    expect(ended).toEqual(['rolled back']);
    expect(laterRan).toBe(false);
    expect(audited).toHaveLength(0);
  });

  it('answers busy when a participant refuses (a pending payment, an open checkout session, a ledger account)', async () => {
    participants.register('payments', () =>
      Promise.reject(new GuestClaimBusy('a payment of the guest row is pending')),
    );
    const { tx, ended } = fakeTx();
    expect(await service().claim(tx, accountOf())).toEqual({ claimedOrders: 0, skipped: 'busy' });
    expect(ended).toEqual(['rolled back']);
  });

  it('does not hide any other failure', async () => {
    const broken = new Error('connection terminated');
    participants.register(ORDERS_PARTICIPANT, () => Promise.reject(broken));
    const error = await service()
      .claim(fakeTx().tx, accountOf())
      .then(
        () => undefined,
        (failure: unknown) => failure,
      );
    expect(error).toBe(broken);
  });

  it('finds a lock error under the cause of a wrapped database error', async () => {
    lockFails = Object.assign(new Error('Failed query'), { cause: lockNotAvailable });
    expect(await service().claim(fakeTx().tx, accountOf())).toEqual({ claimedOrders: 0, skipped: 'busy' });
  });
});

describe('GuestClaimBusy', () => {
  it('is an error that names its reason without carrying anything personal', () => {
    const busy = new GuestClaimBusy('an open checkout session');
    expect(busy).toBeInstanceOf(Error);
    expect(busy.name).toBe('GuestClaimBusy');
    expect(busy.reason).toBe('an open checkout session');
    expect(busy.message).toContain('an open checkout session');
  });
});
