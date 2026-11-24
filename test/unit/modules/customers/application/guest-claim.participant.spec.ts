// Unit tests of the customers participant of the guest-order claim (decision 064): what it asks of the database, with a fake transaction
// that records the statements. The real moves, the proof columns that stay byte for byte and the lock refusal are proved on Postgres in
// test/integration/customers/checkout-accounts.test.ts.
import { describe, expect, it } from 'bun:test';
import { TestClock } from '../../../../support/clock';
import type { Transaction } from '@src/infra/db';
import { GuestClaimBusy, GuestClaimParticipants } from '@src/modules/identity';
import {
  CustomersGuestClaimParticipant,
  GUEST_CLAIM_CUSTOMERS,
} from '@src/modules/customers/application/guest-claim.participant';

const clock = new TestClock('2026-11-10T12:00:00.000Z');
const at = (iso: string) => new Date(iso);

/**
 * A transaction that answers the lock reads (sessions first, then consents) and the two updates with the rows it was told to return, and
 * records what was called.
 */
function fakeTransaction(options: {
  sessions: Array<{ id: number; status: string; expiresAt: Date }>;
  consents: number[];
}) {
  const calls: string[] = [];
  const reads = [options.sessions, options.consents.map((id) => ({ id }))];
  const updates = [options.sessions.map(({ id }) => ({ id })), options.consents.map((id) => ({ id }))];
  const select = {
    from: () => select,
    where: () => select,
    orderBy: () => select,
    for: (strength: string, config: { noWait?: boolean }) => {
      calls.push(`select for ${strength}${config.noWait === true ? ' nowait' : ''}`);
      return Promise.resolve(reads.shift() ?? []);
    },
  };
  const update = {
    set: (values: Record<string, unknown>) => {
      calls.push(`update ${Object.keys(values).sort().join(',')}`);
      return update;
    },
    where: () => update,
    returning: () => Promise.resolve(updates.shift() ?? []),
  };
  const tx = { select: () => select, update: () => update } as unknown as Transaction;
  return { tx, calls };
}

describe('CustomersGuestClaimParticipant', () => {
  it('registers with the claim under the name customers', () => {
    const registry = new GuestClaimParticipants();
    new CustomersGuestClaimParticipant(registry, clock).onModuleInit();
    expect(GUEST_CLAIM_CUSTOMERS).toBe('customers');
    expect(registry.names()).toEqual(['customers']);
  });

  it('locks the sessions and then the consents without waiting, moves both to the account, and counts them together', async () => {
    const { tx, calls } = fakeTransaction({
      sessions: [{ id: 5, status: 'paid', expiresAt: at('2026-11-10T12:30:00.000Z') }],
      consents: [11, 12, 13],
    });
    const participant = new CustomersGuestClaimParticipant(new GuestClaimParticipants(), clock);
    expect(await participant.move(tx, { guestId: 40, accountId: 7 })).toBe(4);
    expect(calls).toEqual([
      'select for update nowait',
      'update accountId,updatedAt',
      'select for update nowait',
      'update subjectId',
    ]);
  });

  it('moves a session that ran out or was paid, and refuses one that is open and not run out, before it writes anything', async () => {
    const run = (status: string, expiresAt: string) => {
      const { tx, calls } = fakeTransaction({ sessions: [{ id: 5, status, expiresAt: at(expiresAt) }], consents: [] });
      return {
        calls,
        result: new CustomersGuestClaimParticipant(new GuestClaimParticipants(), clock)
          .move(tx, { guestId: 40, accountId: 7 })
          .then(
            (count) => count,
            (error: unknown) => error,
          ),
      };
    };
    // Open, and the clock is before its end: the guest may be on a payment page.
    const open = run('open', '2026-11-10T12:30:00.000Z');
    expect(await open.result).toBeInstanceOf(GuestClaimBusy);
    expect(open.calls).toEqual(['select for update nowait']);
    // The end is exclusive: a session that runs out exactly now is history.
    expect(await run('open', '2026-11-10T12:00:00.000Z').result).toBe(1);
    expect(await run('expired', '2026-11-10T12:30:00.000Z').result).toBe(1);
  });

  it('writes nothing for a guest row without a session and without a consent', async () => {
    const { tx, calls } = fakeTransaction({ sessions: [], consents: [] });
    const participant = new CustomersGuestClaimParticipant(new GuestClaimParticipants(), clock);
    expect(await participant.move(tx, { guestId: 40, accountId: 7 })).toBe(0);
    expect(calls).toEqual(['select for update nowait', 'select for update nowait']);
  });
});
