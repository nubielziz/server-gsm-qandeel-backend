// Integration tests of the account directory and the legacy resolver (decision 064): one email can belong to a login row and to a guest row
// at once, and the lookups never mix them up; guest rows are made once per email even when two requests race; the claim's lock never
// waits; the old merchant and customer numbers resolve through the map and never as account ids.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { eq, sql } from 'drizzle-orm';
import { DbService, schema as s } from '@src/infra/db';
import { AccountDirectory } from '@src/modules/identity/accounts/account-directory';
import { LegacyAccounts } from '@src/modules/identity/accounts/legacy-accounts';
import { type TestApp, createTestApp } from '../../support/app';
import { closeTestDb, pgErrorOf, resetDb, testDb } from '../../support/db';

let t: TestApp;
let directory: AccountDirectory;
let legacy: LegacyAccounts;
let retailId = 0;
let merchantRankId = 0;

beforeAll(async () => {
  t = await createTestApp();
  directory = t.app.get(AccountDirectory);
  legacy = t.app.get(LegacyAccounts);
});
afterAll(async () => {
  await resetDb();
  await t.close();
  await closeTestDb();
});
beforeEach(async () => {
  await resetDb();
  const { db } = await testDb();
  const [retail] = await db
    .insert(s.clientGroups)
    .values({ name: 'Storefront retail', kind: 'b2c_retail' })
    .returning({ id: s.clientGroups.id });
  const [merchant] = await db
    .insert(s.clientGroups)
    .values({ name: 'Standard', kind: 'b2b', isDefault: true })
    .returning({ id: s.clientGroups.id });
  retailId = retail!.id;
  merchantRankId = merchant!.id;
});

/** Inserts a row of `clients`: a merchant (username, merchant rank), a retail login, or a guest. */
async function insertAccount(
  kind: 'merchant' | 'retail' | 'guest',
  email: string,
  name = 'Test account',
): Promise<number> {
  const { db } = await testDb();
  const [row] = await db
    .insert(s.clients)
    .values({
      email,
      name,
      groupId: kind === 'merchant' ? merchantRankId : retailId,
      status: 'active',
      hasAccount: kind !== 'guest',
      passwordHash: kind === 'guest' ? null : 'hash',
      username: kind === 'merchant' ? `m-${email}` : null,
    })
    .returning({ id: s.clients.id });
  return row!.id;
}

const inTransaction = <T>(work: (tx: Parameters<AccountDirectory['findById']>[0]) => Promise<T>): Promise<T> =>
  t.app.get(DbService).runInTransaction(({ tx }) => work(tx));

describe('AccountDirectory reads', () => {
  it('tells a merchant rank from a retail rank through the rank reader', async () => {
    const merchantId = await insertAccount('merchant', 'merchant@example.com');
    const shopperId = await insertAccount('retail', 'shopper@example.com');
    const { db } = await testDb();
    expect((await directory.findById(db, merchantId))?.rankKind).toBe('merchant');
    expect((await directory.findById(db, shopperId))?.rankKind).toBe('retail');
    expect(await directory.findById(db, 999_999)).toBeUndefined();
  });

  it('returns the facts of an account and never a secret', async () => {
    const id = await insertAccount('merchant', 'merchant@example.com', 'Acme');
    const { db } = await testDb();
    const account = await directory.findById(db, id);
    expect(account).toMatchObject({
      id,
      email: 'merchant@example.com',
      name: 'Acme',
      status: 'active',
      groupId: merchantRankId,
      rankKind: 'merchant',
      hasAccount: true,
      hasPassword: true,
      emailVerifiedAt: null,
      country: '',
      currency: null,
    });
    expect(Object.keys(account!).sort()).toEqual([
      'country',
      'currency',
      'email',
      'emailVerifiedAt',
      'groupId',
      'hasAccount',
      'hasPassword',
      'id',
      'name',
      'rankKind',
      'status',
    ]);
  });

  it('finds the login row of an email whatever the order the rows were made in', async () => {
    const { db } = await testDb();
    const guestFirst = await insertAccount('guest', 'first@example.com');
    const loginSecond = await insertAccount('retail', 'first@example.com');
    const loginFirst = await insertAccount('retail', 'second@example.com');
    const guestSecond = await insertAccount('guest', 'second@example.com');

    expect((await directory.findLoginByEmail(db, 'first@example.com'))?.id).toBe(loginSecond);
    expect((await directory.findLoginByEmail(db, 'second@example.com'))?.id).toBe(loginFirst);
    expect((await directory.findGuestByEmail(db, 'first@example.com'))?.id).toBe(guestFirst);
    expect((await directory.findGuestByEmail(db, 'second@example.com'))?.id).toBe(guestSecond);
    expect((await directory.findLoginByEmail(db, 'second@example.com'))?.hasAccount).toBe(true);
  });

  it('ignores case and surrounding space, and finds nothing for an email only the other partition holds', async () => {
    const { db } = await testDb();
    const login = await insertAccount('retail', 'Mixed.Case@Example.com');
    const guest = await insertAccount('guest', 'only.guest@example.com');
    expect((await directory.findLoginByEmail(db, '  mixed.case@example.COM '))?.id).toBe(login);
    expect(await directory.findGuestByEmail(db, 'mixed.case@example.com')).toBeUndefined();
    expect(await directory.findLoginByEmail(db, 'only.guest@example.com')).toBeUndefined();
    expect((await directory.findGuestByEmail(db, 'ONLY.GUEST@example.com'))?.id).toBe(guest);
  });
});

describe('AccountDirectory.findOrCreateGuest', () => {
  it('makes a retail guest row, reuses it, and keeps the name it was made with', async () => {
    const first = await inTransaction((tx) =>
      directory.findOrCreateGuest(tx, { email: '  New.Guest@Example.com ', name: 'Visitor', country: 'JO' }),
    );
    expect(first.created).toBe(true);
    expect(first.account).toMatchObject({
      email: 'new.guest@example.com',
      name: 'Visitor',
      country: 'JO',
      status: 'active',
      groupId: retailId,
      rankKind: 'retail',
      hasAccount: false,
      hasPassword: false,
    });
    const second = await inTransaction((tx) =>
      directory.findOrCreateGuest(tx, { email: 'NEW.GUEST@example.com', name: 'Someone else' }),
    );
    expect(second.created).toBe(false);
    expect(second.account.id).toBe(first.account.id);
    expect(second.account.name).toBe('Visitor');
  });

  it('gives an email that has a login row a new guest row, never the login row, whatever its rank', async () => {
    const merchantId = await insertAccount('merchant', 'shared@example.com');
    const shopperId = await insertAccount('retail', 'shopper@example.com');
    for (const [email, loginId] of [
      ['shared@example.com', merchantId],
      ['shopper@example.com', shopperId],
    ] as const) {
      const { account, created } = await inTransaction((tx) => directory.findOrCreateGuest(tx, { email }));
      expect(created).toBe(true);
      expect(account.id).not.toBe(loginId);
      expect(account.hasAccount).toBe(false);
      expect(account.rankKind).toBe('retail');
      const { db } = await testDb();
      expect((await directory.findLoginByEmail(db, email))?.id).toBe(loginId);
    }
    const { db } = await testDb();
    const rows = await db.select({ id: s.clients.id }).from(s.clients).where(eq(s.clients.email, 'shared@example.com'));
    expect(rows).toHaveLength(2);
  });

  it('makes one guest row when two requests for one new email race', async () => {
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        inTransaction((tx) => directory.findOrCreateGuest(tx, { email: 'race@example.com' })),
      ),
    );
    expect(new Set(results.map((result) => result.account.id)).size).toBe(1);
    expect(results.filter((result) => result.created)).toHaveLength(1);
    const { db } = await testDb();
    expect(
      await db.select({ id: s.clients.id }).from(s.clients).where(eq(s.clients.email, 'race@example.com')),
    ).toHaveLength(1);
  });

  it('makes a new guest row when the guest row it met became an account meanwhile', async () => {
    let gate!: () => void;
    const opened = new Promise<void>((resolve) => {
      gate = resolve;
    });
    let madeFirst!: () => void;
    const first = new Promise<void>((resolve) => {
      madeFirst = resolve;
    });
    // One transaction makes the guest row and turns it into an account, but commits only after the other one has started.
    const turning = inTransaction(async (tx) => {
      const { account } = await directory.findOrCreateGuest(tx, { email: 'turning@example.com' });
      madeFirst();
      await opened;
      await tx.update(s.clients).set({ hasAccount: true, passwordHash: 'hash' }).where(eq(s.clients.id, account.id));
      return account.id;
    });
    await first;
    const meeting = inTransaction((tx) => directory.findOrCreateGuest(tx, { email: 'turning@example.com' }));
    await sleep(150);
    gate();
    const [turnedId, met] = await Promise.all([turning, meeting]);
    expect(met.created).toBe(true);
    expect(met.account.id).not.toBe(turnedId);
    expect(met.account.hasAccount).toBe(false);
    const { db } = await testDb();
    expect((await directory.findLoginByEmail(db, 'turning@example.com'))?.id).toBe(turnedId);
    expect((await directory.findGuestByEmail(db, 'turning@example.com'))?.id).toBe(met.account.id);
  });
});

describe('AccountDirectory locks', () => {
  it('reads an account under a key-share lock and under an update lock', async () => {
    const id = await insertAccount('retail', 'locked@example.com');
    expect((await inTransaction((tx) => directory.lockForKeyShare(tx, id)))?.id).toBe(id);
    expect((await inTransaction((tx) => directory.lockForUpdate(tx, id)))?.id).toBe(id);
    expect(await inTransaction((tx) => directory.lockForUpdate(tx, 999_999))).toBeUndefined();
  });

  it('lets two key-share holders share the row and makes an update wait for them', async () => {
    const id = await insertAccount('retail', 'share@example.com');
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held!: () => void;
    const holding = new Promise<void>((resolve) => {
      held = resolve;
    });
    const sharer = inTransaction(async (tx) => {
      await directory.lockForKeyShare(tx, id);
      held();
      await hold;
    });
    await holding;
    // A second key-share holder is not blocked.
    expect((await inTransaction((tx) => directory.lockForKeyShare(tx, id)))?.id).toBe(id);
    let updated = false;
    const writer = inTransaction((tx) => directory.lockForUpdate(tx, id)).then(() => {
      updated = true;
    });
    await sleep(200);
    expect(updated).toBe(false);
    release();
    await Promise.all([sharer, writer]);
    expect(updated).toBe(true);
  });

  it('locks the guest row of an email and never the login row that shares it', async () => {
    await insertAccount('retail', 'both@example.com');
    const guestId = await insertAccount('guest', 'both@example.com');
    await insertAccount('retail', 'login.only@example.com');
    const locked = await inTransaction((tx) => directory.lockGuestNoWait(tx, ' BOTH@example.com'));
    expect(locked?.id).toBe(guestId);
    expect(locked?.hasAccount).toBe(false);
    expect(await inTransaction((tx) => directory.lockGuestNoWait(tx, 'login.only@example.com'))).toBeUndefined();
  });

  it('refuses at once, with the lock error, while another transaction holds the guest row', async () => {
    await insertAccount('guest', 'busy@example.com');
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held!: () => void;
    const holding = new Promise<void>((resolve) => {
      held = resolve;
    });
    const holder = inTransaction(async (tx) => {
      await directory.lockGuestNoWait(tx, 'busy@example.com');
      held();
      await hold;
    });
    await holding;
    const started = performance.now();
    const failure = await pgErrorOf(inTransaction((tx) => directory.lockGuestNoWait(tx, 'busy@example.com')));
    expect(failure.code).toBe('55P03');
    expect(performance.now() - started).toBeLessThan(2_000);
    release();
    await holder;
  });
});

describe('LegacyAccounts', () => {
  /** A merchant (old number = its id), a converted customer (old customer number 7), and a merged pair (customer 15 into the merchant). */
  async function seedMap() {
    const { db } = await testDb();
    const merchant = await insertAccount('merchant', 'old.merchant@example.com');
    const converted = await insertAccount('retail', 'old.customer@example.com');
    const merged = await insertAccount('merchant', 'merged@example.com');
    await db.execute(sql`
      insert into account_legacy_ids (legacy_type, legacy_id, account_id, merged) values
        ('client', ${merchant}, ${merchant}, false),
        ('client', ${merged}, ${merged}, false),
        ('customer', 7, ${converted}, false),
        ('customer', 15, ${merged}, true),
        ('customer', ${merchant}, ${converted}, false)`);
    return { db, merchant, converted, merged };
  }

  it('resolves each word, and an old customer number is never read as an account id', async () => {
    const { db, merchant, converted, merged } = await seedMap();
    expect(await legacy.resolve(db, 'account', 4_000)).toBe(4_000);
    expect(await legacy.resolve(db, 'client', merchant)).toBe(merchant);
    expect(await legacy.resolve(db, 'merchant', merchant)).toBe(merchant);
    expect(await legacy.resolve(db, 'customer', 7)).toBe(converted);
    expect(await legacy.resolve(db, 'customer', 15)).toBe(merged);
    // Customer number = the merchant's id: the customer's account, not the merchant.
    expect(await legacy.resolve(db, 'customer', merchant)).toBe(converted);
    expect(await legacy.resolve(db, 'customer', 999)).toBeUndefined();
    expect(await legacy.resolve(db, 'client', 999)).toBeUndefined();
  });

  it('lists the old numbers of an account', async () => {
    const { db, merchant, converted, merged } = await seedMap();
    expect(await legacy.legacyIdsOf(db, merchant)).toEqual([{ type: 'client', id: merchant }]);
    expect(await legacy.legacyIdsOf(db, converted)).toEqual(
      [7, merchant].sort((a, b) => a - b).map((id) => ({ type: 'customer', id })),
    );
    expect(await legacy.legacyIdsOf(db, merged)).toEqual([
      { type: 'client', id: merged },
      { type: 'customer', id: 15 },
    ]);
    expect(await legacy.legacyIdsOf(db, 4_000)).toEqual([]);
  });

  it('evaluates the id expression in a query: unknown pairs and other words give null', async () => {
    const { db, merchant, converted, merged } = await seedMap();
    const result = await db.execute(sql`
      select t.label, ${legacy.legacyAccountIdSql(sql`t.type`, sql`t.id`)} as account_id
      from (values
        ('account', 4000::bigint, 'account'),
        ('client', ${merchant}::bigint, 'client'),
        ('merchant', ${merged}::bigint, 'merchant'),
        ('customer', 7::bigint, 'customer'),
        ('customer', ${merchant}::bigint, 'customer-same-number'),
        ('customer', 999::bigint, 'customer-unknown'),
        ('staff', ${merchant}::bigint, 'staff'),
        ('system', null::bigint, 'system')
      ) as t(type, id, label)`);
    const byLabel = new Map(
      result.rows.map((row) => [row.label, row.account_id === null ? null : Number(row.account_id)]),
    );
    expect(Object.fromEntries(byLabel)).toEqual({
      account: 4_000,
      client: merchant,
      merchant: merged,
      customer: converted,
      'customer-same-number': converted,
      'customer-unknown': null,
      staff: null,
      system: null,
    });
  });

  it('matches every pair of one account in its history, and no pair of another account', async () => {
    const { db, merchant, converted, merged } = await seedMap();
    const result = await db.execute(sql`
      select t.label from (values
        ('account', ${merged}::bigint, 'account-self'),
        ('client', ${merged}::bigint, 'client-self'),
        ('merchant', ${merged}::bigint, 'merchant-self'),
        ('customer', 15::bigint, 'customer-merged'),
        ('account', ${converted}::bigint, 'account-other'),
        ('customer', 7::bigint, 'customer-other'),
        ('customer', ${merged}::bigint, 'customer-same-number-as-the-merchant-id'),
        ('client', ${merchant}::bigint, 'client-other'),
        ('staff', ${merged}::bigint, 'staff-same-number')
      ) as t(type, id, label)
      where ${legacy.accountHistorySql(sql`t.type`, sql`t.id`, merged)}`);
    expect(result.rows.map((row) => row.label).sort()).toEqual(
      ['account-self', 'client-self', 'customer-merged', 'merchant-self'].sort(),
    );
  });
});
