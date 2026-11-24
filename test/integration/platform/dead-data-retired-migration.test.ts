// Integration test of the data migration that retires the dead data of the accounts clean-up (the notification event deposit.approved): the SQL
// is run on rows written before it and run again, as a database that already has it would, and on an empty table. The migration file is found by
// the end of its name, so the test follows the file when it is renumbered.
import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { asc } from 'drizzle-orm';
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

const template = (event: string, channel: 'email' | 'telegram') => ({
  event,
  channel,
  audience: 'merchant' as const,
  subject: channel === 'email' ? 'A subject' : '',
  body: 'A body',
});

describe('the migration that retires the dead data', () => {
  it('exists in the migrations folder', () => {
    expect(NAME).toBeDefined();
  });

  it('deletes the stored templates of deposit.approved, keeps every other template, and changes nothing when run again', async () => {
    const { db } = await testDb();
    await db
      .insert(s.notificationTemplates)
      .values([
        template('deposit.approved', 'email'),
        template('deposit.approved', 'telegram'),
        template('invoice.paid', 'email'),
        template('wallet.low_balance', 'email'),
      ]);
    const keys = async () =>
      (await db.select().from(s.notificationTemplates).orderBy(asc(s.notificationTemplates.id))).map(
        (row) => `${row.event}|${row.channel}`,
      );

    await migrate();
    expect(await keys()).toEqual(['invoice.paid|email', 'wallet.low_balance|email']);
    await migrate();
    expect(await keys()).toEqual(['invoice.paid|email', 'wallet.low_balance|email']);
  });

  it('runs on an empty table', async () => {
    await migrate();
    const { db } = await testDb();
    expect(await db.select().from(s.notificationTemplates)).toEqual([]);
  });
});
