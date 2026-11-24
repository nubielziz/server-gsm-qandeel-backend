// Integration test of the data migration that retires the free IMEI check, two risk signals and the customer risk level: the SQL is run on
// rows written before it (the rules setting that still names the retired rule, the two retired settings, an IMEI check row, a customer with a
// risk level) and run again, as a database that already has it would. The table of the log and the risk-level column stay in this step, so the
// test also proves the migration leaves them, and every other setting and customer, alone. The migration file is found by the end of its name.
import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { schema as s } from '@src/infra/db';
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

const PAST = new Date('2026-01-01T00:00:00.000Z');

describe('the migration that retires the free IMEI check, two risk signals and the customer risk level', () => {
  it('exists in the migrations folder', () => {
    expect(NAME).toBeDefined();
  });

  it('takes the retired rule out of the stored rules, keeps the other rules, and changes nothing when run again', async () => {
    const { db } = await testDb();
    const rules = {
      blockBlacklistedImei: { on: true, value: null },
      reviewThreshold: { on: true, value: 55 },
      blockDisposableEmail: { on: true, value: null },
    };
    await db.insert(s.settings).values({ key: 'riskRules', value: rules, updatedAt: PAST });
    await migrate();
    const [once] = await db.select().from(s.settings).where(eq(s.settings.key, 'riskRules'));
    expect(once!.value).toEqual({
      reviewThreshold: { on: true, value: 55 },
      blockDisposableEmail: { on: true, value: null },
    });
    expect(once!.updatedAt.getTime()).toBeGreaterThan(PAST.getTime());
    await migrate();
    const [twice] = await db.select().from(s.settings).where(eq(s.settings.key, 'riskRules'));
    expect(twice).toEqual(once);
  });

  it('does not rewrite a rules setting that never held the retired rule, nor one that is not an object', async () => {
    const { db } = await testDb();
    await db.insert(s.settings).values({
      key: 'riskRules',
      value: { reviewThreshold: { on: true, value: 60 } },
      updatedAt: PAST,
    });
    await migrate();
    const [row] = await db.select().from(s.settings).where(eq(s.settings.key, 'riskRules'));
    expect(row!.updatedAt).toEqual(PAST);
    await db
      .update(s.settings)
      .set({ value: ['blockBlacklistedImei'] })
      .where(eq(s.settings.key, 'riskRules'));
    await migrate();
    const [list] = await db.select().from(s.settings).where(eq(s.settings.key, 'riskRules'));
    expect(list!.value).toEqual(['blockBlacklistedImei']);
  });

  it('deletes the two retired settings and no other setting', async () => {
    const { db } = await testDb();
    await db.insert(s.settings).values([
      { key: 'imeiRetentionDays', value: 180 },
      { key: 'imeiPrecheck', value: true },
      { key: 'guestCheckout', value: false },
      { key: 'support.attachmentRetentionDays', value: 30 },
    ]);
    await migrate();
    const keys = async () => (await db.select({ key: s.settings.key }).from(s.settings)).map((row) => row.key).sort();
    expect(await keys()).toEqual(['guestCheckout', 'support.attachmentRetentionDays']);
    await migrate();
    expect(await keys()).toEqual(['guestCheckout', 'support.attachmentRetentionDays']);
  });

  it('runs on an empty database, empties the retired log, and leaves the table, the risk-level column and the customers as they are', async () => {
    const { db, pool } = await testDb();
    await migrate();
    const [customer] = await db
      .insert(s.customers)
      .values({ email: 'a@example.com', name: 'A', riskLevel: 'high' })
      .returning();
    await db
      .insert(s.imeiChecks)
      .values({ imeiHash: 'h', imeiEnc: 'e', checkType: 'basic', source: 'storefront_free', customerId: customer!.id });
    await db.insert(s.imeiChecks).values({ checkType: 'basic', source: 'pre_order' });
    expect(await db.select().from(s.imeiChecks)).toHaveLength(2);
    await migrate();
    expect(await db.select().from(s.imeiChecks)).toHaveLength(0);
    const [after] = await db.select().from(s.customers).where(eq(s.customers.id, customer!.id));
    expect(after).toEqual(customer);
    expect(after!.riskLevel).toBe('high');
    const { rows } = await pool.query<{ count: string }>(
      `select count(*)::text as count from information_schema.columns
        where (table_name = 'customers' and column_name = 'risk_level') or table_name = 'imei_checks' and column_name = 'imei_hash'`,
    );
    expect(rows[0]?.count).toBe('2');
    // The customer can be deleted now that no log row holds it.
    await db.delete(s.customers).where(eq(s.customers.id, customer!.id));
    expect(await db.select().from(s.customers)).toHaveLength(0);
  });
});
