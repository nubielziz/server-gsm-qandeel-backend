// Integration test of the data migration of decision 061 (merchant verification by documents was retired): the SQL is run on rows
// written before it (roles that hold the permissions of the five retired routes, the stored templates of the two retired mail
// events) and run again, as a database that already has it would. The table "kyc_submissions" and the column "clients"."kyc_status"
// stay in this step, so the test also proves the migration leaves them and the rows of everything else alone.
import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { asc, eq } from 'drizzle-orm';
import { schema as s } from '@src/infra/db';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { insertMerchant } from '../../support/auth';

const FOLDER = join(import.meta.dir, '../../../drizzle');
const NAME = readdirSync(FOLDER).find((file) => file.endsWith('_merchant_verification_retired.sql'));

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

async function insertTemplate(
  event: string,
  channel: 'email' | 'telegram',
  audience: 'merchant' | 'staff',
): Promise<void> {
  const { db } = await testDb();
  await db.insert(s.notificationTemplates).values({ event, channel, audience, subject: 'S', body: 'B' });
}

describe('the migration that retires merchant verification by documents', () => {
  it('exists in the migrations folder', () => {
    expect(NAME).toBeDefined();
  });

  it('takes the three retired permissions out of every role, keeps every other permission in its order, and changes nothing when run again', async () => {
    const { db } = await testDb();
    const area = await insertRole('Verification desk', [
      'kyc:*',
      'clients:read',
      'kyc:read',
      'kyc:decide',
      'orders:read',
    ]);
    const decide = await insertRole('Reviewer', ['kyc:decide', 'audit:read']);
    const onlyRetired = await insertRole('Retired only', ['kyc:read', 'kyc:decide']);
    const untouched = await insertRole('Support', ['tickets:read', 'tickets:reply']);
    const owner = await insertRole('Owner', ['*']);
    const empty = await insertRole('Nobody', []);
    const rolesBefore = async () => await db.select().from(s.roles).orderBy(asc(s.roles.id));
    const before = await rolesBefore();

    await migrate();
    const once = await rolesBefore();
    const permissionsOf = (rows: typeof once, id: number) => rows.find((row) => row.id === id)?.permissions;
    expect(permissionsOf(once, area)).toEqual(['clients:read', 'orders:read']);
    expect(permissionsOf(once, decide)).toEqual(['audit:read']);
    expect(permissionsOf(once, onlyRetired)).toEqual([]);
    expect(permissionsOf(once, untouched)).toEqual(['tickets:read', 'tickets:reply']);
    expect(permissionsOf(once, owner)).toEqual(['*']);
    expect(permissionsOf(once, empty)).toEqual([]);
    // A role that held none of the three is not rewritten: its time stays. A role that held one is rewritten and says so.
    for (const id of [untouched, owner, empty]) expect(once.find((row) => row.id === id)?.updatedAt).toEqual(PAST);
    for (const id of [area, decide, onlyRetired]) {
      expect(once.find((row) => row.id === id)!.updatedAt.getTime()).toBeGreaterThan(PAST.getTime());
    }
    const names = (rows: typeof once) => rows.map((row) => row.name);
    expect(names(once)).toEqual(names(before));

    await migrate();
    expect(await rolesBefore()).toEqual(once);
  });

  it('deletes the stored templates of the two retired mail events on every channel and keeps every other template', async () => {
    const { db } = await testDb();
    await insertTemplate('merchant.kyc_approved', 'email', 'merchant');
    await insertTemplate('merchant.kyc_approved', 'telegram', 'merchant');
    await insertTemplate('merchant.kyc_rejected', 'email', 'merchant');
    await insertTemplate('merchant.reactivated', 'email', 'merchant');
    await insertTemplate('merchant.suspended', 'email', 'merchant');
    await insertTemplate('staff.invited', 'email', 'staff');
    const events = async () =>
      (await db.select().from(s.notificationTemplates).orderBy(asc(s.notificationTemplates.id))).map(
        (row) => `${row.event}|${row.channel}|${row.audience}`,
      );

    await migrate();
    const once = await events();
    expect(once).toEqual([
      'merchant.reactivated|email|merchant',
      'merchant.suspended|email|merchant',
      'staff.invited|email|staff',
    ]);

    await migrate();
    expect(await events()).toEqual(once);
  });

  it('runs on an empty database, and leaves the retired table and column, and the merchants, as they are', async () => {
    const { db, pool } = await testDb();
    await migrate();
    const merchantId = await insertMerchant(db, { status: 'pending' });
    await db.insert(s.kycSubmissions).values({ clientId: merchantId, status: 'approved', fileIds: [] });
    const [clientBefore] = await db.select().from(s.clients).where(eq(s.clients.id, merchantId));

    await migrate();
    const [client] = await db.select().from(s.clients).where(eq(s.clients.id, merchantId));
    expect(client).toEqual(clientBefore);
    expect(client?.kycStatus).toBe('none');
    expect(await db.select().from(s.kycSubmissions)).toHaveLength(1);
    const { rows } = await pool.query<{ count: string }>(
      `select count(*)::text as count from information_schema.columns where table_name = 'clients' and column_name = 'kyc_status'`,
    );
    expect(rows[0]?.count).toBe('1');
  });
});
