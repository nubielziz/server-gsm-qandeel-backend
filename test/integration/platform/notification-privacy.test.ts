// Integration tests of what the notification center forgets when a customer is anonymized (feature 23, plan section 9.7, owner decision O6):
// `POST /admin/customers/:id/anonymize` deletes the customer's inbox items and empties the payload of their log rows in its own transaction,
// leaves everyone else's rows alone, and keeps the log rows themselves (what was sent and when).
import { afterAll, beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { eq } from 'drizzle-orm';
import { type Database, schema as s } from '@src/infra/db';
import { CustomerErasureHooks } from '@src/modules/customers';
import { NotificationPrivacy } from '@src/modules/platform';
import { type AdminApi, adminWith } from '../../support/admin-api';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches } from '../../support/auth';
import { insertCustomer } from '../../support/campaigns';
import { TestClock } from '../../support/clock';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { CONSOLE_ORIGIN } from '../../support/staff-console';

const clock = new TestClock('2026-11-08T09:00:00.000Z');
let t: TestApp;
let db: Database;
let staff: AdminApi;

async function personalRows(customerId: number) {
  const [first] = await db
    .insert(s.notificationInbox)
    .values({
      recipientType: 'customer',
      recipientId: customerId,
      event: 'order.completed',
      category: 'order',
      variables: { orderId: '1' },
    })
    .returning({ id: s.notificationInbox.id });
  await db.insert(s.notificationInbox).values({
    recipientType: 'customer',
    recipientId: customerId,
    event: 'order.failed',
    category: 'order',
    variables: {},
    readAt: clock.now(),
  });
  const [log] = await db
    .insert(s.notifications)
    .values({
      recipientType: 'customer',
      recipientId: customerId,
      channel: 'email',
      event: 'order.completed',
      payload: { variables: { customerName: 'Dana', orderId: '1' } },
      status: 'sent',
      sentAt: clock.now(),
    })
    .returning({ id: s.notifications.id });
  return { itemId: first!.id, logId: log!.id };
}

beforeAll(async () => {
  t = await createTestApp({ clock, env: { CORS_ORIGINS: CONSOLE_ORIGIN } });
  db = (await testDb()).db;
});
beforeEach(async () => {
  clock.set('2026-11-08T09:00:00.000Z');
  await resetDb();
  await clearIdentityCaches(t);
  staff = await adminWith(t, ['customers:privacy', 'customers:read'], { name: 'Rami K.' });
});
afterAll(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await t.close();
  await closeTestDb();
});

describe('anonymizing a customer', () => {
  it('deletes their inbox items and empties the payload of their log rows, and leaves other people’s rows alone', async () => {
    const dana = await insertCustomer(db, { name: 'Dana' });
    const other = await insertCustomer(db, { name: 'Sam' });
    const mine = await personalRows(dana);
    const theirs = await personalRows(other);
    const res = await staff.post(`/admin/customers/${dana}/anonymize`);
    expect(res.status).toBe(204);

    expect(await db.select().from(s.notificationInbox).where(eq(s.notificationInbox.recipientId, dana))).toHaveLength(
      0,
    );
    expect(await db.select().from(s.notificationInbox).where(eq(s.notificationInbox.recipientId, other))).toHaveLength(
      2,
    );
    const [log] = await db.select().from(s.notifications).where(eq(s.notifications.id, mine.logId));
    // The row stays (what was sent, when, to whom, with what outcome); the name and the order data go.
    expect(log).toMatchObject({ status: 'sent', event: 'order.completed', payload: {}, updatedAt: clock.now() });
    const [kept] = await db.select().from(s.notifications).where(eq(s.notifications.id, theirs.logId));
    expect(kept!.payload).toEqual({ variables: { customerName: 'Dana', orderId: '1' } });
    expect(theirs.itemId).toBeGreaterThan(0);
  });

  it('runs inside the anonymization’s transaction: a failing erasure rolls the whole anonymization back', async () => {
    const dana = await insertCustomer(db, { name: 'Dana' });
    await personalRows(dana);
    const spy = spyOn(t.app.get(NotificationPrivacy), 'eraseRecipient').mockRejectedValueOnce(new Error('boom'));
    const res = await staff.post(`/admin/customers/${dana}/anonymize`);
    expect(res.status).toBe(500);
    expect((await db.select().from(s.customers).where(eq(s.customers.id, dana)))[0]).toMatchObject({
      status: 'active',
      name: 'Dana',
    });
    expect(await db.select().from(s.notificationInbox).where(eq(s.notificationInbox.recipientId, dana))).toHaveLength(
      2,
    );
    spy.mockRestore();
  });

  it('registers its hook with the customers module’s list once', () => {
    const hooks = Reflect.get(t.app.get(CustomerErasureHooks), 'hooks') as object[];
    expect(hooks.filter((hook) => hook.constructor.name === 'CustomerInboxErasure')).toHaveLength(1);
  });
});
