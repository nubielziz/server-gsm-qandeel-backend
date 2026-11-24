// Integration tests of the files participant of the guest-order claim (decision 064): the files a guest row owns move to the account that
// proved the mailbox, the files of everyone else stay, and a file another transaction holds makes the move refuse at once with the lock
// error (SQLSTATE 55P03) instead of waiting. Real Postgres; no application is needed (the participant is a function of the platform module).
import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { type Database, pgErrorInfo, schema as s } from '@src/infra/db';
import { moveGuestClaimFiles } from '@src/modules/platform/files/guest-claim-files';
import { makeAccount } from '../../support/accounts';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { insertFileRow } from '../../support/support-accounts';

let db: Database;

beforeEach(async () => {
  db = (await testDb()).db;
  await resetDb();
});
afterAll(async () => {
  await resetDb();
  await closeTestDb();
});

const ownersOf = async (): Promise<Array<[number, number]>> =>
  (await db.select().from(s.files).orderBy(s.files.id)).map((row) => [row.id, row.ownerId]);

describe('moveGuestClaimFiles', () => {
  it('moves every file of the guest row to the account and leaves the files of every other owner alone', async () => {
    const guest = await makeAccount({ rank: 'retail', guest: true });
    const account = await makeAccount({ rank: 'retail' });
    const other = await makeAccount({ rank: 'retail' });
    const first = await insertFileRow(db, 'account', guest.id);
    const second = await insertFileRow(db, 'account', guest.id, {
      filename: 'screenshot.png',
      key: 'tickets-4/account-1/x',
    });
    const accountsOwn = await insertFileRow(db, 'account', account.id);
    const others = await insertFileRow(db, 'account', other.id);
    // A staff member whose id equals the guest's number is not the guest: the owner type keeps them apart.
    const staffs = await insertFileRow(db, 'staff', guest.id);

    const moved = await db.transaction((tx) => moveGuestClaimFiles(tx, { guestId: guest.id, accountId: account.id }));

    expect(moved).toBe(2);
    expect(await ownersOf()).toEqual([
      [first.id, account.id],
      [second.id, account.id],
      [accountsOwn.id, account.id],
      [others.id, other.id],
      [staffs.id, guest.id],
    ]);
    expect((await db.select().from(s.files).where(eq(s.files.id, staffs.id)))[0]).toMatchObject({ ownerType: 'staff' });
    // The claim has nothing left to move for the guest row: a second call moves nothing.
    expect(await db.transaction((tx) => moveGuestClaimFiles(tx, { guestId: guest.id, accountId: account.id }))).toBe(0);
  });

  it('moves nothing for a guest row without files', async () => {
    const guest = await makeAccount({ rank: 'retail', guest: true });
    const account = await makeAccount({ rank: 'retail' });
    expect(await db.transaction((tx) => moveGuestClaimFiles(tx, { guestId: guest.id, accountId: account.id }))).toBe(0);
  });

  it('refuses at once with the lock error while another transaction holds one of the files', async () => {
    const guest = await makeAccount({ rank: 'retail', guest: true });
    const account = await makeAccount({ rank: 'retail' });
    const held = await insertFileRow(db, 'account', guest.id);
    await insertFileRow(db, 'account', guest.id);
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked!: () => void;
    const holding = new Promise<void>((resolve) => {
      locked = resolve;
    });
    // A janitor run or a ticket reply that touches the file at the same time.
    const holder = db.transaction(async (tx) => {
      await tx.select({ id: s.files.id }).from(s.files).where(eq(s.files.id, held.id)).for('update');
      locked();
      await hold;
    });
    await holding;
    const started = performance.now();
    const failure = await db
      .transaction((tx) => moveGuestClaimFiles(tx, { guestId: guest.id, accountId: account.id }))
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(pgErrorInfo(failure)?.code).toBe('55P03');
    expect(performance.now() - started).toBeLessThan(2_000);
    release();
    await holder;
    // The refused claim rolled back: both files still belong to the guest row.
    expect((await ownersOf()).every(([, owner]) => owner === guest.id)).toBe(true);
  });
});
