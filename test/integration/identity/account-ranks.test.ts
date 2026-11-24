// Integration tests of the rank and username writes of the identity module (decision 064): a rank is written only for an account that
// exists, a guest row never takes a merchant rank, and a username is made from the name once, without clashing even when two accounts
// of one name become merchants at the same moment.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { eq } from 'drizzle-orm';
import { DbService, schema as s } from '@src/infra/db';
import { AccountDirectory } from '@src/modules/identity/accounts/account-directory';
import { AccountRanks } from '@src/modules/identity/accounts/account-ranks';
import { type TestApp, createTestApp } from '../../support/app';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { expectRejection } from '../../support/rejection';

let t: TestApp;
let ranks: AccountRanks;
let directory: AccountDirectory;
let retailId = 0;
let merchantRankId = 0;
let secondMerchantRankId = 0;

beforeAll(async () => {
  t = await createTestApp();
  ranks = t.app.get(AccountRanks);
  directory = t.app.get(AccountDirectory);
});
afterAll(async () => {
  await resetDb();
  await t.close();
  await closeTestDb();
});
beforeEach(async () => {
  await resetDb();
  const { db } = await testDb();
  const groups = await db
    .insert(s.clientGroups)
    .values([
      { name: 'Storefront retail', kind: 'b2c_retail' },
      { name: 'Standard', kind: 'b2b', isDefault: true },
      { name: 'Gold', kind: 'b2b' },
    ])
    .returning({ id: s.clientGroups.id });
  [retailId, merchantRankId, secondMerchantRankId] = groups.map((group) => group.id) as [number, number, number];
});

/** Inserts a retail login, a guest row, or a merchant with or without a username. */
async function insertAccount(options: {
  readonly email: string;
  readonly name: string;
  readonly guest?: boolean;
  readonly merchant?: boolean;
  readonly username?: string;
}): Promise<number> {
  const { db } = await testDb();
  const [row] = await db
    .insert(s.clients)
    .values({
      email: options.email,
      name: options.name,
      groupId: options.merchant ? merchantRankId : retailId,
      status: 'active',
      hasAccount: options.guest !== true,
      passwordHash: options.guest === true ? null : 'hash',
      username: options.username ?? null,
    })
    .returning({ id: s.clients.id });
  return row!.id;
}

const inTransaction = <T>(work: (tx: Parameters<AccountDirectory['findById']>[0]) => Promise<T>): Promise<T> =>
  t.app.get(DbService).runInTransaction(({ tx }) => work(tx));

async function usernameOf(id: number): Promise<string | null> {
  const { db } = await testDb();
  const [row] = await db.select({ username: s.clients.username }).from(s.clients).where(eq(s.clients.id, id));
  return row!.username;
}

describe('AccountRanks.setRank', () => {
  it('moves an account between ranks of both kinds and the rank kind follows', async () => {
    const id = await insertAccount({ email: 'move@example.com', name: 'Move' });
    const { db } = await testDb();
    await inTransaction((tx) => ranks.setRank(tx, id, merchantRankId));
    expect(await directory.findById(db, id)).toMatchObject({ groupId: merchantRankId, rankKind: 'merchant' });
    await inTransaction((tx) => ranks.setRank(tx, id, secondMerchantRankId));
    expect(await directory.findById(db, id)).toMatchObject({ groupId: secondMerchantRankId, rankKind: 'merchant' });
    await inTransaction((tx) => ranks.setRank(tx, id, retailId));
    expect(await directory.findById(db, id)).toMatchObject({ groupId: retailId, rankKind: 'retail' });
  });

  it('writes nothing for an account or a rank that does not exist', async () => {
    const id = await insertAccount({ email: 'missing@example.com', name: 'Missing' });
    await expectRejection(inTransaction((tx) => ranks.setRank(tx, 999_999, merchantRankId)));
    await expectRejection(inTransaction((tx) => ranks.setRank(tx, id, 999_999)));
    const { db } = await testDb();
    expect((await directory.findById(db, id))?.groupId).toBe(retailId);
  });

  it('refuses a merchant rank for a guest row and leaves the row as it was', async () => {
    const guestId = await insertAccount({ email: 'guest@example.com', name: '', guest: true });
    await expectRejection(
      inTransaction((tx) => ranks.setRank(tx, guestId, merchantRankId)),
      /guest/,
    );
    const { db } = await testDb();
    expect((await directory.findById(db, guestId))?.groupId).toBe(retailId);
  });
});

describe('AccountRanks.ensureUsername', () => {
  it('makes a username from the name, and gives the same one back the second time', async () => {
    const id = await insertAccount({ email: 'acme@example.com', name: 'Acme Phones Ltd.', merchant: true });
    expect(await inTransaction((tx) => ranks.ensureUsername(tx, id))).toBe('acme-phones-ltd');
    expect(await usernameOf(id)).toBe('acme-phones-ltd');
    expect(await inTransaction((tx) => ranks.ensureUsername(tx, id))).toBe('acme-phones-ltd');
  });

  it('keeps a username the account already has', async () => {
    const id = await insertAccount({
      email: 'kept@example.com',
      name: 'Another Name',
      merchant: true,
      username: 'chosen',
    });
    expect(await inTransaction((tx) => ranks.ensureUsername(tx, id))).toBe('chosen');
    expect(await usernameOf(id)).toBe('chosen');
  });

  it('numbers a name that is taken, ignoring case', async () => {
    await insertAccount({ email: 'one@example.com', name: 'Twin', merchant: true, username: 'Twin' });
    const second = await insertAccount({ email: 'two@example.com', name: 'Twin', merchant: true });
    const third = await insertAccount({ email: 'three@example.com', name: 'Twin', merchant: true });
    expect(await inTransaction((tx) => ranks.ensureUsername(tx, second))).toBe('twin-2');
    expect(await inTransaction((tx) => ranks.ensureUsername(tx, third))).toBe('twin-3');
  });

  it('falls back to a name for an account whose name has no letters or digits', async () => {
    const id = await insertAccount({ email: 'symbols@example.com', name: '***', merchant: true });
    expect(await inTransaction((tx) => ranks.ensureUsername(tx, id))).toBe('merchant');
  });

  it('refuses a guest row and an account that does not exist', async () => {
    const guestId = await insertAccount({ email: 'guest@example.com', name: 'Guest', guest: true });
    await expectRejection(
      inTransaction((tx) => ranks.ensureUsername(tx, guestId)),
      /guest/,
    );
    await expectRejection(inTransaction((tx) => ranks.ensureUsername(tx, 999_999)));
    expect(await usernameOf(guestId)).toBeNull();
  });

  it('gives two accounts of one name that become merchants at the same moment two different usernames', async () => {
    const first = await insertAccount({ email: 'a@example.com', name: 'Same Name', merchant: true });
    const second = await insertAccount({ email: 'b@example.com', name: 'Same Name', merchant: true });
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    let wrote!: () => void;
    const written = new Promise<void>((resolve) => {
      wrote = resolve;
    });
    // The first transaction takes the plain slug and commits only after the second one has tried the same slug.
    const holder = inTransaction(async (tx) => {
      const username = await ranks.ensureUsername(tx, first);
      wrote();
      await hold;
      return username;
    });
    await written;
    const racer = inTransaction((tx) => ranks.ensureUsername(tx, second));
    await sleep(200);
    release();
    const [firstName, secondName] = await Promise.all([holder, racer]);
    expect(firstName).toBe('same-name');
    expect(secondName).toBe('same-name-2');
    expect(await usernameOf(first)).toBe('same-name');
    expect(await usernameOf(second)).toBe('same-name-2');
  });
});
