// Integration tests of the account scope of the audit log (decision 064): the audit tab of one account reads its rows under every
// word they were written with (`account`, the old `merchant`, and the old `customer` numbers through the legacy map), never another
// person's rows, and every row says which account it is about. The map has a collision on purpose: the old customer number of the retail
// account equals the id of the merchant account.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { sql } from 'drizzle-orm';
import { type Database, schema as s } from '@src/infra/db';
import { adminWith } from '../../support/admin-api';
import { makeAccount } from '../../support/accounts';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches } from '../../support/auth';
import { TestClock } from '../../support/clock';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { mapLegacyClient, mapLegacyCustomer } from '../../support/legacy-accounts';

const clock = new TestClock('2026-11-10T09:00:00.000Z');
let t: TestApp;
let db: Database;

beforeAll(async () => {
  db = (await testDb()).db;
  t = await createTestApp({ clock });
});
beforeEach(async () => {
  clock.reset();
  await resetDb();
  await clearIdentityCaches(t);
});
afterAll(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await t.close();
  await closeTestDb();
});

type Row = typeof s.auditLogs.$inferInsert;
const ids = (body: Array<{ id: number }>) => body.map((row) => row.id);

/** Writes audit rows straight to the table, oldest first, with the current words (the table refuses an old word in a new actor). */
async function addRows(rows: Array<Partial<Row> & Pick<Row, 'action' | 'entityType' | 'entityId'>>): Promise<number[]> {
  const made = await db
    .insert(s.auditLogs)
    .values(
      rows.map((row, index) => ({
        actorType: 'staff' as const,
        actorId: 1,
        actorName: 'Rami K.',
        createdAt: new Date(clock.nowMs() + index * 1000),
        ...row,
      })),
    )
    .returning({ id: s.auditLogs.id });
  return made.map((row) => row.id);
}

/**
 * Writes audit rows that carry an old actor word, the way rows written before the accounts were merged do.
 *
 * Why: the table refuses `client` and `customer` in a new row (the current check is NOT VALID: it guards new rows only), so the check is dropped
 * and added back the same way inside one transaction.
 */
async function addLegacyActorRows(
  rows: Array<Pick<Row, 'action' | 'entityType' | 'entityId' | 'actorType' | 'actorId'>>,
): Promise<number[]> {
  const words = sql.raw(s.CURRENT_AUDIT_ACTOR_TYPES.map((word) => `'${word}'`).join(', '));
  return db.transaction(async (tx) => {
    await tx.execute(sql`alter table audit_logs drop constraint audit_logs_actor_type_current_check`);
    const made = await tx
      .insert(s.auditLogs)
      .values(
        rows.map((row, index) => ({ actorName: 'Old', createdAt: new Date(clock.nowMs() + index * 1000), ...row })),
      )
      .returning({ id: s.auditLogs.id });
    await tx.execute(
      sql`alter table audit_logs add constraint audit_logs_actor_type_current_check check (actor_type in (${words})) not valid`,
    );
    return made.map((row) => row.id);
  });
}

/**
 * Two accounts and their audit rows. Account `merchant` kept its number from the days of merchants (the map says so). Account `retail` was
 * customer number `merchant.id`: the old number of the customer equals the id of the merchant, so a filter on the raw number would show the
 * wrong person.
 */
async function world() {
  const merchant = await makeAccount({ rank: 'merchant' });
  const retail = await makeAccount({ rank: 'retail' });
  await mapLegacyClient(db, merchant.id);
  await mapLegacyCustomer(db, merchant.id, retail.id);
  const [newMerchant, oldMerchant, oldCustomer, newRetail, unmappedCustomer, merchantWordOfRetail, order] =
    await addRows([
      { action: 'changed rank of', entityType: 'account', entityId: merchant.id, entityLabel: 'Test Merchant' },
      { action: 'adjusted wallet of', entityType: 'merchant', entityId: merchant.id, entityLabel: 'Test Merchant' },
      { action: 'blocked', entityType: 'customer', entityId: merchant.id, entityLabel: 'Test Customer' },
      { action: 'changed rank of', entityType: 'account', entityId: retail.id, entityLabel: 'Test Customer' },
      { action: 'blocked', entityType: 'customer', entityId: 999_999, entityLabel: 'Nobody known' },
      // The word `merchant` with the id of the retail account: no merchant ever had this number.
      { action: 'adjusted wallet of', entityType: 'merchant', entityId: retail.id, entityLabel: 'Someone else' },
      { action: 'cancelled order', entityType: 'order', entityId: 41, entityLabel: 'Order 41' },
    ]);
  return {
    merchant,
    retail,
    ids: {
      newMerchant: newMerchant!,
      oldMerchant: oldMerchant!,
      oldCustomer: oldCustomer!,
      newRetail: newRetail!,
      unmappedCustomer: unmappedCustomer!,
      merchantWordOfRetail: merchantWordOfRetail!,
      order: order!,
    },
  };
}

describe('GET /admin/audit-logs?accountId=', () => {
  it('returns the account, merchant and customer rows of one account, with account.id set, and never another person with the same number', async () => {
    const w = await world();
    const staff = await adminWith(t, ['audit:read']);
    const merchantTab = await staff.get(`/admin/audit-logs?accountId=${w.merchant.id}&_sort=id&_order=asc`);
    expect(merchantTab.status).toBe(200);
    // The merchant's own rows under the two words it was written with; the customer row with the same number belongs to the other account.
    expect(ids(merchantTab.body)).toEqual([w.ids.newMerchant, w.ids.oldMerchant]);
    expect(merchantTab.total).toBe(2);
    expect(merchantTab.body.map((row: { account: unknown }) => row.account)).toEqual([
      { id: w.merchant.id },
      { id: w.merchant.id },
    ]);

    const retailTab = await staff.get(`/admin/audit-logs?accountId=${w.retail.id}&_sort=id&_order=asc`);
    // The account's own row and the row written under its old customer number (which is the merchant's id).
    expect(ids(retailTab.body)).toEqual([w.ids.oldCustomer, w.ids.newRetail]);
    expect(retailTab.body.map((row: { account: unknown }) => row.account)).toEqual([
      { id: w.retail.id },
      { id: w.retail.id },
    ]);
  });

  it('reads `entityType=account` with an entity id as the same thing, and without one as every row of the three words', async () => {
    const w = await world();
    const staff = await adminWith(t, ['audit:read']);
    const byId = await staff.get(`/admin/audit-logs?entityType=account&entityId=${w.retail.id}&_sort=id&_order=asc`);
    expect(ids(byId.body)).toEqual([w.ids.oldCustomer, w.ids.newRetail]);
    const every = await staff.get('/admin/audit-logs?entityType=account&_sort=id&_order=asc');
    expect(ids(every.body)).toEqual([
      w.ids.newMerchant,
      w.ids.oldMerchant,
      w.ids.oldCustomer,
      w.ids.newRetail,
      w.ids.unmappedCustomer,
      w.ids.merchantWordOfRetail,
    ]);
    expect(every.total).toBe(6);
    // The plain words still filter exactly, for the history.
    expect(ids((await staff.get('/admin/audit-logs?entityType=customer&_sort=id&_order=asc')).body)).toEqual([
      w.ids.oldCustomer,
      w.ids.unmappedCustomer,
    ]);
    expect(ids((await staff.get(`/admin/audit-logs?entityType=merchant&entityId=${w.merchant.id}`)).body)).toEqual([
      w.ids.oldMerchant,
    ]);
  });

  it('says which account each row is about, and null for an old number the map does not know and for rows of no account', async () => {
    const w = await world();
    const staff = await adminWith(t, ['audit:read']);
    const accountOf = async (id: number) => (await staff.get(`/admin/audit-logs/${id}`)).body.account;
    // A new row says account: the id itself.
    expect(await accountOf(w.ids.newMerchant)).toEqual({ id: w.merchant.id });
    // An old merchant row keeps the merchant's number.
    expect(await accountOf(w.ids.oldMerchant)).toEqual({ id: w.merchant.id });
    // An old customer row goes through the map: the old number is the merchant's id, the account is the retail one.
    expect(await accountOf(w.ids.oldCustomer)).toEqual({ id: w.retail.id });
    // Never another account: an unknown old number, and a merchant number nobody had.
    expect(await accountOf(w.ids.unmappedCustomer)).toBeNull();
    expect(await accountOf(w.ids.merchantWordOfRetail)).toBeNull();
    // A staff action on an order is about no account.
    expect(await accountOf(w.ids.order)).toBeNull();
  });

  it('refuses a malformed account id and combines with the other filters', async () => {
    const w = await world();
    const staff = await adminWith(t, ['audit:read']);
    expect((await staff.get('/admin/audit-logs?accountId=abc')).status).toBe(422);
    expect((await staff.get('/admin/audit-logs?accountId=0')).status).toBe(422);
    const narrowed = await staff.get(`/admin/audit-logs?accountId=${w.merchant.id}&q=wallet`);
    expect(ids(narrowed.body)).toEqual([w.ids.oldMerchant]);
    // Two accounts at once (the key repeated reads as IN).
    const both = await staff.get(`/admin/audit-logs?accountId=${w.merchant.id}&accountId=${w.retail.id}`);
    expect(both.total).toBe(4);
  });
});

describe('GET /admin/audit-logs?actorType=account', () => {
  it('reads the account, client and customer actors of one account through the map', async () => {
    const w = await world();
    const [current, oldMerchantActor, oldCustomerActor, someoneElse] = await addLegacyActorRows([
      { action: 'created ticket', entityType: 'ticket', entityId: 5, actorType: 'account', actorId: w.merchant.id },
      { action: 'created ticket', entityType: 'ticket', entityId: 6, actorType: 'client', actorId: w.merchant.id },
      // The old customer number equals the merchant's id: this actor is the retail account.
      { action: 'created ticket', entityType: 'ticket', entityId: 7, actorType: 'customer', actorId: w.merchant.id },
      { action: 'created ticket', entityType: 'ticket', entityId: 8, actorType: 'customer', actorId: 999_999 },
    ]);
    const staff = await adminWith(t, ['audit:read']);
    const merchantActor = await staff.get(
      `/admin/audit-logs?actorType=account&actorId=${w.merchant.id}&_sort=id&_order=asc`,
    );
    expect(ids(merchantActor.body)).toEqual([current!, oldMerchantActor!]);
    const retailActor = await staff.get(
      `/admin/audit-logs?actorType=account&actorId=${w.retail.id}&_sort=id&_order=asc`,
    );
    expect(ids(retailActor.body)).toEqual([oldCustomerActor!]);
    // Every account actor, old words included; the unmapped customer actor is one of them with no account behind it.
    const every = await staff.get('/admin/audit-logs?actorType=account&_sort=id&_order=asc');
    expect(ids(every.body)).toEqual([current!, oldMerchantActor!, oldCustomerActor!, someoneElse!]);
    // The row is about a ticket: the account that acted is the account the row stands for.
    const accountOf = every.body.map((row: { account: { id: number } | null }) => row.account);
    expect(accountOf).toEqual([{ id: w.merchant.id }, { id: w.merchant.id }, { id: w.retail.id }, null]);
    // The exact old word still filters for the history.
    expect(ids((await staff.get('/admin/audit-logs?actorType=customer&_sort=id&_order=asc')).body)).toEqual([
      oldCustomerActor!,
      someoneElse!,
    ]);
  });
});
