// Integration test of the data migration that stores every tax window's region trimmed and in upper case: the SQL is run on rows written
// before the rule (several spellings of one region) and run again, as a database that already has it would.
import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { asc } from 'drizzle-orm';
import { schema as s } from '@src/infra/db';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { insertTaxWindow } from '../../support/storefront';

const FOLDER = join(import.meta.dir, '../../../drizzle');
const NAME = readdirSync(FOLDER).find((file) => file.endsWith('_tax_region_upper_case.sql'));

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

describe('the migration of tax window regions', () => {
  it('exists in the migrations folder', () => {
    expect(NAME).toBeDefined();
  });

  it('trims every region and writes it in upper case, leaves the whole country empty, and changes nothing when run again', async () => {
    const { db } = await testDb();
    await insertTaxWindow(db, { country: 'CA', region: ' on', ratePercent: '13' });
    await insertTaxWindow(db, { country: 'CA', region: 'Qc ', ratePercent: '14.975' });
    await insertTaxWindow(db, { country: 'CA', region: 'BC', ratePercent: '0' });
    await insertTaxWindow(db, { country: 'GB', region: '' });
    const regions = async () =>
      (await db.select().from(s.taxRates).orderBy(asc(s.taxRates.id))).map((row) => [
        row.country,
        row.region,
        row.updatedAt,
      ]);
    const before = await regions();
    await migrate();
    const once = await regions();
    expect(once.map(([country, region]) => [country, region])).toEqual([
      ['CA', 'ON'],
      ['CA', 'QC'],
      ['CA', 'BC'],
      ['GB', ''],
    ]);
    // A data fix, not a staff change: the rows keep their times.
    expect(once.map((row) => row[2])).toEqual(before.map((row) => row[2]));
    await migrate();
    expect(await regions()).toEqual(once);
  });
});
