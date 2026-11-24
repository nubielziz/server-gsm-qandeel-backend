// Unit tests of the files participant of the guest-order claim (decision 064): what it asks of the database, with a fake transaction that
// records the statements. The real moves and the lock refusal are proved on Postgres in test/integration/platform/guest-claim-files.test.ts.
import { describe, expect, it } from 'bun:test';
import type { Transaction } from '@src/infra/db';
import { GUEST_CLAIM_FILES_NAME, moveGuestClaimFiles } from '@src/modules/platform/files/guest-claim-files';

/** A transaction that answers the lock read with `locked` ids and the update with the ids it was told to move; it records what was called. */
function fakeTransaction(locked: number[]) {
  const calls: string[] = [];
  const select = {
    from: () => select,
    where: () => select,
    orderBy: () => select,
    for: (strength: string, config: { noWait?: boolean }) => {
      calls.push(`select for ${strength}${config.noWait === true ? ' nowait' : ''}`);
      return Promise.resolve(locked.map((id) => ({ id })));
    },
  };
  const update = {
    set: (values: Record<string, unknown>) => {
      calls.push(`update ${JSON.stringify(values)}`);
      return update;
    },
    where: () => update,
    returning: () => Promise.resolve(locked.map((id) => ({ id }))),
  };
  const tx = { select: () => select, update: () => update } as unknown as Transaction;
  return { tx, calls };
}

describe('moveGuestClaimFiles', () => {
  it('registers under the name files', () => {
    expect(GUEST_CLAIM_FILES_NAME).toBe('files');
  });

  it('locks the rows without waiting, then moves them to the account, and counts them', async () => {
    const { tx, calls } = fakeTransaction([4, 9]);
    expect(await moveGuestClaimFiles(tx, { guestId: 11, accountId: 12 })).toBe(2);
    expect(calls).toEqual(['select for update nowait', 'update {"ownerId":12}']);
  });

  it('writes nothing when the guest row has no files', async () => {
    const { tx, calls } = fakeTransaction([]);
    expect(await moveGuestClaimFiles(tx, { guestId: 11, accountId: 12 })).toBe(0);
    expect(calls).toEqual(['select for update nowait']);
  });
});
