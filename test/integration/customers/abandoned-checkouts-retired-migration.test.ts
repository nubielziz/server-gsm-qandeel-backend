// Integration test of the data migration that retires the abandoned-checkouts list and the reminder (decision 062): the SQL is run on rows written
// before it (roles that hold the two retired permissions, the stored template of the retired mail, the reminder's outbox events and queued
// notifications, the stored delay) and run again, as a database that already has it would. The column "checkout_sessions"."recovery_emailed_at"
// stays in this step, so the test also proves the migration leaves it and the rows of everything else alone.
import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { asc, eq } from 'drizzle-orm';
import { schema as s } from '@src/infra/db';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { migrationFileName } from '../../support/migration-files';

const FOLDER = join(import.meta.dir, '../../../drizzle');
const SUFFIX = '_retired_features.sql';

beforeEach(async () => {
  await resetDb();
});
afterAll(async () => {
  await resetDb();
  await closeTestDb();
});

async function migrate(): Promise<void> {
  const { pool } = await testDb();
  await pool.query(readFileSync(join(FOLDER, migrationFileName(SUFFIX)), 'utf8'));
}

/** A role written before the migration, with a time far in the past so a rewrite shows. */
const PAST = new Date('2026-01-01T00:00:00.000Z');
async function insertRole(name: string, permissions: string[]): Promise<number> {
  const { db } = await testDb();
  const [role] = await db.insert(s.roles).values({ name, permissions, updatedAt: PAST }).returning({ id: s.roles.id });
  return role!.id;
}

describe('the migration that retires the abandoned-checkouts list and the reminder', () => {
  it('exists in the migrations folder', () => {
    expect(migrationFileName(SUFFIX)).toMatch(/^\d{4}_/);
  });

  it('takes the three retired permissions out of every role, keeps every other permission in its order, and changes nothing when run again', async () => {
    const { db } = await testDb();
    const area = await insertRole('Growth desk', [
      'growth:*',
      'customers:read',
      'growth:read',
      'growth:send',
      'orders:read',
    ]);
    const send = await insertRole('Sender', ['growth:send', 'audit:read']);
    const onlyRetired = await insertRole('Retired only', ['growth:read', 'growth:send']);
    const funnel = await insertRole('Reports', ['reports:growth', 'dashboard:read']);
    const owner = await insertRole('Owner', ['*']);
    const empty = await insertRole('Nobody', []);
    const rolesNow = async () => await db.select().from(s.roles).orderBy(asc(s.roles.id));
    const before = await rolesNow();

    await migrate();
    const once = await rolesNow();
    const permissionsOf = (rows: typeof once, id: number) => rows.find((row) => row.id === id)?.permissions;
    expect(permissionsOf(once, area)).toEqual(['customers:read', 'orders:read']);
    expect(permissionsOf(once, send)).toEqual(['audit:read']);
    expect(permissionsOf(once, onlyRetired)).toEqual([]);
    // The funnel report keeps its own permission: it is another area.
    expect(permissionsOf(once, funnel)).toEqual(['reports:growth', 'dashboard:read']);
    expect(permissionsOf(once, owner)).toEqual(['*']);
    expect(permissionsOf(once, empty)).toEqual([]);
    // A role that held none of the three is not rewritten: its time stays. A role that held one is rewritten and says so.
    for (const id of [funnel, owner, empty]) expect(once.find((row) => row.id === id)?.updatedAt).toEqual(PAST);
    for (const id of [area, send, onlyRetired]) {
      expect(once.find((row) => row.id === id)!.updatedAt.getTime()).toBeGreaterThan(PAST.getTime());
    }
    expect(once.map((row) => row.name)).toEqual(before.map((row) => row.name));

    await migrate();
    expect(await rolesNow()).toEqual(once);
  });

  it('deletes the stored templates of the retired mail on every channel and audience and keeps every other template', async () => {
    const { db } = await testDb();
    const insert = (event: string, channel: 'email' | 'telegram', audience: 'customer' | 'merchant') =>
      db.insert(s.notificationTemplates).values({ event, channel, audience, subject: 'S', body: 'B' });
    await insert('checkout.abandoned', 'email', 'customer');
    await insert('checkout.abandoned', 'email', 'merchant');
    await insert('order.received', 'email', 'customer');
    await insert('support.reply', 'email', 'customer');
    const events = async () =>
      (await db.select().from(s.notificationTemplates).orderBy(asc(s.notificationTemplates.id))).map(
        (row) => `${row.event}|${row.channel}|${row.audience}`,
      );

    await migrate();
    const once = await events();
    expect(once).toEqual(['order.received|email|customer', 'support.reply|email|customer']);

    await migrate();
    expect(await events()).toEqual(once);
  });

  it('marks the pending events of the reminder as handled, once, and leaves every other event alone', async () => {
    const { db } = await testDb();
    const handledAt = new Date('2026-02-01T00:00:00.000Z');
    await db.insert(s.outboxEvents).values([
      { type: 'checkout.recovery', aggregateType: 'checkout_sessions', aggregateId: 1 },
      { type: 'checkout.recovery', aggregateType: 'checkout_sessions', aggregateId: 2, processedAt: handledAt },
      { type: 'notification.send', aggregateType: 'notifications', aggregateId: 3 },
    ]);
    const rows = async () => await db.select().from(s.outboxEvents).orderBy(asc(s.outboxEvents.id));

    await migrate();
    const once = await rows();
    expect(once[0]!.processedAt).not.toBeNull();
    expect(once[1]!.processedAt).toEqual(handledAt);
    expect(once[2]!.processedAt).toBeNull();

    await migrate();
    expect(await rows()).toEqual(once);
  });

  it('ends the queued reminder rows as failed with a fixed reason, and keeps the sent ones and every other event as they are', async () => {
    const { db } = await testDb();
    const row = (event: string, status: 'queued' | 'sent') => ({
      recipientType: 'customer' as const,
      recipientId: 1,
      channel: 'email' as const,
      event,
      status,
    });
    await db
      .insert(s.notifications)
      .values([
        row('checkout.abandoned', 'queued'),
        row('checkout.abandoned', 'sent'),
        row('order.received', 'queued'),
      ]);
    const rows = async () => await db.select().from(s.notifications).orderBy(asc(s.notifications.id));

    await migrate();
    const once = await rows();
    expect(once.map((item) => [item.event, item.status, item.error])).toEqual([
      ['checkout.abandoned', 'failed', 'The checkout reminder was retired.'],
      ['checkout.abandoned', 'sent', null],
      ['order.received', 'queued', null],
    ]);

    await migrate();
    expect(await rows()).toEqual(once);
  });

  it('deletes the stored delay of the reminder and keeps every other setting', async () => {
    const { db } = await testDb();
    await db.insert(s.settings).values([
      { key: 'abandonedMinutes', value: 120 },
      { key: 'refundHoursBeforeDispatch', value: 24 },
      { key: 'guestCheckout', value: false },
    ]);

    await migrate();
    const keys = async () => (await db.select().from(s.settings).orderBy(asc(s.settings.id))).map((row) => row.key);
    expect(await keys()).toEqual(['refundHoursBeforeDispatch', 'guestCheckout']);

    await migrate();
    expect(await keys()).toEqual(['refundHoursBeforeDispatch', 'guestCheckout']);
  });

  it('runs on an empty database, and leaves the retired column and the funnel alone', async () => {
    const { pool } = await testDb();
    await migrate();
    await migrate();
    const { rows } = await pool.query<{ count: string }>(
      `select count(*)::text as count from information_schema.columns where table_name = 'checkout_sessions' and column_name = 'recovery_emailed_at'`,
    );
    expect(rows[0]?.count).toBe('1');
    const { db } = await testDb();
    expect(await db.select().from(s.checkoutSessions).where(eq(s.checkoutSessions.id, 1))).toEqual([]);
  });
});
