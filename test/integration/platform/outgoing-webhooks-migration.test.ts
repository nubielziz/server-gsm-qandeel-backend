// Integration test of the data migration that retires the outgoing webhooks to merchants: the SQL is run on rows written before it (roles that hold
// the permissions of the retired staff routes, the stored template of the notice of a switched-off endpoint, unrelayed outbox events of that notice,
// a rule on the alert metric of the deliveries with its open alert and its streak) and run again, as a database that already has it would. The
// tables "webhook_endpoints" and "webhook_deliveries" stay in this step, so the test also proves the migration leaves them and everything else alone.
import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { asc, eq } from 'drizzle-orm';
import { schema as s } from '@src/infra/db';
import { insertRule, insertAlert } from '../../support/alerts';
import { insertMerchant } from '../../support/auth';
import { closeTestDb, resetDb, testDb } from '../../support/db';

const FOLDER = join(import.meta.dir, '../../../drizzle');
// The file is found by its name, not its number: the number is given when the branches are merged.
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

async function insertTemplate(
  event: string,
  channel: 'email' | 'telegram',
  audience: 'merchant' | 'staff',
): Promise<void> {
  const { db } = await testDb();
  await db.insert(s.notificationTemplates).values({ event, channel, audience, subject: 'S', body: 'B' });
}

describe('the migration that retires the outgoing webhooks to merchants', () => {
  it('exists in the migrations folder', () => {
    expect(NAME).toBeDefined();
  });

  it('takes the three retired permissions out of every role, keeps every other permission in its order, and changes nothing when run again', async () => {
    const { db } = await testDb();
    const area = await insertRole('Webhook desk', [
      'webhooks:*',
      'clients:read',
      'webhooks:read',
      'webhooks:update',
      'orders:read',
    ]);
    const reader = await insertRole('Reader', ['webhooks:read', 'audit:read']);
    const onlyRetired = await insertRole('Retired only', ['webhooks:read', 'webhooks:update']);
    const untouched = await insertRole('Support', ['tickets:read', 'tickets:reply']);
    const owner = await insertRole('Owner', ['*']);
    const empty = await insertRole('Nobody', []);
    const rolesBefore = async () => await db.select().from(s.roles).orderBy(asc(s.roles.id));
    const before = await rolesBefore();

    await migrate();
    const once = await rolesBefore();
    const permissionsOf = (rows: typeof once, id: number) => rows.find((row) => row.id === id)?.permissions;
    expect(permissionsOf(once, area)).toEqual(['clients:read', 'orders:read']);
    expect(permissionsOf(once, reader)).toEqual(['audit:read']);
    expect(permissionsOf(once, onlyRetired)).toEqual([]);
    expect(permissionsOf(once, untouched)).toEqual(['tickets:read', 'tickets:reply']);
    expect(permissionsOf(once, owner)).toEqual(['*']);
    expect(permissionsOf(once, empty)).toEqual([]);
    // A role that held none of the three is not rewritten: its time stays. A role that held one is rewritten and says so.
    for (const id of [untouched, owner, empty]) expect(once.find((row) => row.id === id)?.updatedAt).toEqual(PAST);
    for (const id of [area, reader, onlyRetired]) {
      expect(once.find((row) => row.id === id)!.updatedAt.getTime()).toBeGreaterThan(PAST.getTime());
    }
    expect(once.map((row) => row.name)).toEqual(before.map((row) => row.name));

    await migrate();
    expect(await rolesBefore()).toEqual(once);
  });

  it('deletes the stored template of the notice of a switched-off endpoint and keeps every other template', async () => {
    const { db } = await testDb();
    await insertTemplate('webhook.endpoint_disabled', 'email', 'merchant');
    await insertTemplate('wallet.low_balance', 'email', 'merchant');
    await insertTemplate('order.completed', 'email', 'merchant');
    await insertTemplate('staff.invited', 'email', 'staff');
    const events = async () =>
      (await db.select().from(s.notificationTemplates).orderBy(asc(s.notificationTemplates.id))).map(
        (row) => `${row.event}|${row.channel}|${row.audience}`,
      );

    await migrate();
    const once = await events();
    expect(once).toEqual([
      'wallet.low_balance|email|merchant',
      'order.completed|email|merchant',
      'staff.invited|email|staff',
    ]);

    await migrate();
    expect(await events()).toEqual(once);
  });

  it('marks the unrelayed events of that notice as handled and leaves every other outbox row as it is', async () => {
    const { db } = await testDb();
    const PROCESSED = new Date('2026-02-01T00:00:00.000Z');
    await db.insert(s.outboxEvents).values([
      {
        type: 'webhook.endpoint_disabled',
        aggregateType: 'webhook_endpoints',
        aggregateId: 1,
        payload: { clientId: 5, endpointId: 1 },
      },
      {
        type: 'webhook.endpoint_disabled',
        aggregateType: 'webhook_endpoints',
        aggregateId: 2,
        payload: {},
        processedAt: PROCESSED,
      },
      { type: 'order.status_changed', aggregateType: 'orders', aggregateId: 7, payload: { orderId: 7 } },
    ]);
    const rows = async () => await db.select().from(s.outboxEvents).orderBy(asc(s.outboxEvents.id));

    await migrate();
    const once = await rows();
    expect(once[0]!.processedAt).toBeInstanceOf(Date);
    expect(once[1]!.processedAt).toEqual(PROCESSED);
    expect(once[2]!.processedAt).toBeNull();

    await migrate();
    expect(await rows()).toEqual(once);
  });

  it('deletes a rule on the retired alert metric the way the console does, resolves its open alert, drops its streak and keeps its history and every other rule', async () => {
    const { db } = await testDb();
    const retired = await insertRule(db, {
      key: 'webhook_delivery',
      metric: 'webhooks.success_rate',
      comparator: 'lt',
    });
    const other = await insertRule(db, { key: 'supplier_timeouts', metric: 'supplier.timeout_rate' });
    const alreadyDeleted = await insertRule(db, {
      key: 'old_webhook_delivery',
      metric: 'webhooks.success_rate',
      deletedAt: PAST,
    });
    const open = await insertAlert(db, retired, { startedAt: new Date('2026-11-01T10:00:00.000Z') });
    const done = await insertAlert(db, retired, {
      startedAt: new Date('2026-10-01T10:00:00.000Z'),
      status: 'resolved',
      resolvedAt: new Date('2026-10-01T10:30:00.000Z'),
    });
    const kept = await insertAlert(db, other, { startedAt: new Date('2026-11-01T10:00:00.000Z') });
    await db.insert(s.alertStreaks).values([
      { ruleId: retired.id, subjectKey: 'system', kind: 'breach', condition: 'lt|95', since: PAST, seenAt: PAST },
      { ruleId: other.id, subjectKey: 'system', kind: 'breach', condition: 'gt|20', since: PAST, seenAt: PAST },
    ]);
    const rules = async () => await db.select().from(s.alertRules).orderBy(asc(s.alertRules.id));
    const alerts = async () => await db.select().from(s.alertEvents).orderBy(asc(s.alertEvents.id));

    await migrate();
    const rulesOnce = await rules();
    expect(rulesOnce.find((rule) => rule.id === retired.id)?.deletedAt).toBeInstanceOf(Date);
    expect(rulesOnce.find((rule) => rule.id === other.id)?.deletedAt).toBeNull();
    // A rule that was deleted before keeps its own time of deletion.
    expect(rulesOnce.find((rule) => rule.id === alreadyDeleted.id)?.deletedAt).toEqual(PAST);
    const alertsOnce = await alerts();
    expect(alertsOnce.find((alert) => alert.id === open.id)).toMatchObject({
      status: 'resolved',
      metric: 'webhooks.success_rate',
    });
    expect(alertsOnce.find((alert) => alert.id === open.id)?.resolvedAt).toBeInstanceOf(Date);
    expect(alertsOnce.find((alert) => alert.id === done.id)?.resolvedAt).toEqual(new Date('2026-10-01T10:30:00.000Z'));
    expect(alertsOnce.find((alert) => alert.id === kept.id)?.status).toBe('firing');
    expect((await db.select().from(s.alertStreaks)).map((streak) => streak.ruleId)).toEqual([other.id]);

    await migrate();
    expect(await rules()).toEqual(rulesOnce);
    expect(await alerts()).toEqual(alertsOnce);
  });

  it('runs on an empty database, and leaves the two retired tables and the merchants as they are', async () => {
    const { db } = await testDb();
    await migrate();
    const merchantId = await insertMerchant(db);
    const [endpoint] = await db
      .insert(s.webhookEndpoints)
      .values({
        clientId: merchantId,
        url: 'https://hooks.example.com/gsm',
        secretEnc: 'sealed',
        events: ['order.status_changed'],
      })
      .returning();
    await db.insert(s.webhookDeliveries).values({
      endpointId: endpoint!.id,
      event: 'order.status_changed',
      eventId: 'evt_before_the_migration',
      payload: {},
    });
    const [clientBefore] = await db.select().from(s.clients).where(eq(s.clients.id, merchantId));

    await migrate();
    const [client] = await db.select().from(s.clients).where(eq(s.clients.id, merchantId));
    expect(client).toEqual(clientBefore);
    expect(await db.select().from(s.webhookEndpoints)).toEqual([endpoint!]);
    expect(await db.select().from(s.webhookDeliveries)).toHaveLength(1);
  });
});
