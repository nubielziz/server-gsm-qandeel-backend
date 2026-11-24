// Integration test of the data migration of decision 062 (commissions and referral links were retired): the SQL is run on rows written
// before it (roles that hold the permissions of the retired routes) and run again, as a database that already has it would. The three
// commission tables, the two referral columns and the journals the commissions posted stay in this step, so the test also proves the
// migration leaves them and the rows of everything else alone. The migration file is found by the end of its name.
import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { asc, eq } from 'drizzle-orm';
import { schema as s } from '@src/infra/db';
import { insertMerchant } from '../../support/auth';
import { closeTestDb, resetDb, testDb } from '../../support/db';

const FOLDER = join(import.meta.dir, '../../../drizzle');
const NAME = readdirSync(FOLDER).find((file) => file.endsWith('_retired_features.sql'));

beforeEach(async () => {
  await resetDb();
});
afterAll(async () => {
  await resetDb();
  await closeTestDb();
});

async function migrate(): Promise<void> {
  const { pool } = await testDb();
  await pool.query(readFileSync(join(FOLDER, NAME ?? 'missing'), 'utf8'));
}

/** A role written before the migration, with a time far in the past so a rewrite shows. */
const PAST = new Date('2026-01-01T00:00:00.000Z');
async function insertRole(name: string, permissions: string[]): Promise<number> {
  const { db } = await testDb();
  const [role] = await db.insert(s.roles).values({ name, permissions, updatedAt: PAST }).returning({ id: s.roles.id });
  return role!.id;
}

describe('the migration that retires commissions and referral links', () => {
  it('exists in the migrations folder', () => {
    expect(NAME).toBeDefined();
  });

  it('takes the six retired permissions out of every role, keeps every other permission in its order, and changes nothing when run again', async () => {
    const { db } = await testDb();
    const area = await insertRole('Commission desk', [
      'commissions:*',
      'clients:read',
      'commissions:read',
      'commissions:create',
      'orders:read',
    ]);
    const approver = await insertRole('Approver', ['commissions:approve', 'commissions:update', 'audit:read']);
    const onlyRetired = await insertRole('Retired only', ['commissions:read', 'commissions:delete']);
    const untouched = await insertRole('Support', ['tickets:read', 'tickets:reply']);
    const owner = await insertRole('Owner', ['*']);
    const empty = await insertRole('Nobody', []);
    const rolesBefore = async () => await db.select().from(s.roles).orderBy(asc(s.roles.id));
    const before = await rolesBefore();

    await migrate();
    const once = await rolesBefore();
    const permissionsOf = (rows: typeof once, id: number) => rows.find((row) => row.id === id)?.permissions;
    expect(permissionsOf(once, area)).toEqual(['clients:read', 'orders:read']);
    expect(permissionsOf(once, approver)).toEqual(['audit:read']);
    expect(permissionsOf(once, onlyRetired)).toEqual([]);
    expect(permissionsOf(once, untouched)).toEqual(['tickets:read', 'tickets:reply']);
    expect(permissionsOf(once, owner)).toEqual(['*']);
    expect(permissionsOf(once, empty)).toEqual([]);
    // A role that held none of them is not rewritten: its time stays. A role that held one is rewritten and says so.
    for (const id of [untouched, owner, empty]) expect(once.find((row) => row.id === id)?.updatedAt).toEqual(PAST);
    for (const id of [area, approver, onlyRetired]) {
      expect(once.find((row) => row.id === id)!.updatedAt.getTime()).toBeGreaterThan(PAST.getTime());
    }
    const names = (rows: typeof once) => rows.map((row) => row.name);
    expect(names(once)).toEqual(names(before));

    await migrate();
    expect(await rolesBefore()).toEqual(once);
  });

  it('runs on an empty database, and leaves the retired tables, the referral columns and the merchants as they are', async () => {
    const { db, pool } = await testDb();
    await migrate();
    const referrer = await insertMerchant(db, { status: 'active' });
    const merchant = await insertMerchant(db, { status: 'active', referredById: referrer });
    const [plan] = await db
      .insert(s.commissionPlans)
      .values({ name: 'Old referral', kind: 'referral', basis: 'revenue', percent: '3.0000', period: 'monthly' })
      .returning({ id: s.commissionPlans.id });
    await db.insert(s.commissionAssignments).values({ planId: plan!.id, beneficiaryId: referrer, scope: 'referrals' });
    const [clientBefore] = await db.select().from(s.clients).where(eq(s.clients.id, merchant));

    await migrate();
    const [client] = await db.select().from(s.clients).where(eq(s.clients.id, merchant));
    expect(client).toEqual(clientBefore);
    expect(client?.referredById).toBe(referrer);
    expect(await db.select().from(s.commissionPlans)).toHaveLength(1);
    expect(await db.select().from(s.commissionAssignments)).toHaveLength(1);
    const { rows } = await pool.query<{ count: string }>(
      `select count(*)::text as count from information_schema.columns
        where table_name = 'clients' and column_name in ('referred_by_id', 'referral_code')`,
    );
    expect(rows[0]?.count).toBe('2');
  });
});
