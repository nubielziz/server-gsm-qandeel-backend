// Integration tests of the in-app items events make (feature 23, plan section 9.2, S9): a storefront order mail also makes one inbox item
// for a customer with an account (and none for a guest, a suspended or an anonymized one), a merchant's low balance makes one even when
// the merchant switched email and Telegram off, a job that runs twice makes one, and an event without a registered text makes none.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { DbService, type Database, schema as s } from '@src/infra/db';
import { RedisService } from '@src/infra/redis';
import { type NotificationInput, NotificationService } from '@src/modules/platform';
import { type TestApp, createTestApp } from '../../support/app';
import { insertMerchant } from '../../support/auth';
import { insertCustomer } from '../../support/campaigns';
import { TestClock } from '../../support/clock';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import {
  eventJob,
  mailbox,
  notificationRows,
  planEvent,
  seedDefaultTemplates,
  sendAllQueued,
} from '../../support/notifications';
import { deleteBullKeys, testBullPrefix } from '../../support/queues';

const prefix = testBullPrefix();
const clock = new TestClock('2026-11-10T09:00:00.000Z');
let t: TestApp;
let db: Database;

beforeAll(async () => {
  ({ db } = await testDb());
  t = await createTestApp({ clock, env: { BULL_PREFIX: prefix } });
});
afterAll(async () => {
  await deleteBullKeys(t.app.get(RedisService).queue, prefix);
  await resetDb();
  await t.close();
  await closeTestDb();
});
beforeEach(async () => {
  clock.set('2026-11-10T09:00:00.000Z');
  await resetDb();
  await seedDefaultTemplates(db);
  mailbox(t).reset();
});

const enqueue = (input: NotificationInput) =>
  t.app.get(DbService).runInTransaction(({ tx }) => t.app.get(NotificationService).enqueue({ tx }, input));
const items = () => db.select().from(s.notificationInbox).orderBy(s.notificationInbox.id);

const orderMail = (customerId: number, dedupeKey: string | undefined): NotificationInput => ({
  event: 'order.completed',
  recipient: { type: 'customer', id: customerId },
  channel: 'email',
  variables: { customerName: 'Dana', orderId: '4021', service: 'Vodafone UK iPhone Unlock', device: 'iPhone 15' },
  ...(dedupeKey === undefined ? {} : { dedupeKey }),
});

describe('customer events', () => {
  it('makes one inbox item beside the mail, with the occurrence as its key, and none the second time', async () => {
    const customerId = await insertCustomer(db, { name: 'Dana' });
    const first = await enqueue(orderMail(customerId, 'order-4021-completed:email'));
    expect(first).toMatchObject({ status: 'queued', created: true });
    const again = await enqueue(orderMail(customerId, 'order-4021-completed:email'));
    expect(again).toMatchObject({ status: 'queued', created: false });
    const rows = await items();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      recipientType: 'customer',
      recipientId: customerId,
      event: 'order.completed',
      category: 'order',
      campaignId: null,
      readAt: null,
      dedupeKey: 'inapp:customer:order.completed:order-4021-completed',
      variables: { customerName: 'Dana', orderId: '4021', service: 'Vodafone UK iPhone Unlock', device: 'iPhone 15' },
    });
    expect(await notificationRows(db)).toHaveLength(1);
  });

  it('makes the item even when the email template is switched off, and none without a dedupe key', async () => {
    const customerId = await insertCustomer(db);
    await db
      .update(s.notificationTemplates)
      .set({ isActive: false })
      .where(eq(s.notificationTemplates.event, 'order.completed'));
    const off = await enqueue(orderMail(customerId, 'order-1:email'));
    expect(off).toEqual({ status: 'skipped', reason: 'template_off' });
    expect(await items()).toHaveLength(1);
    await enqueue(orderMail(customerId, undefined));
    expect(await items()).toHaveLength(1);
  });

  it('makes no item for a guest, a suspended or a blocked customer, but still mails the suspended one (the event is transactional)', async () => {
    const guest = await insertCustomer(db, { hasAccount: false });
    const suspended = await insertCustomer(db, { status: 'suspended' });
    const blocked = await insertCustomer(db, { status: 'blocked' });
    for (const [n, id] of [guest, suspended, blocked].entries()) {
      const made = await enqueue(orderMail(id, `order-${n}:email`));
      expect(made.status, String(n)).toBe('queued');
    }
    expect(await items()).toHaveLength(0);
    await sendAllQueued(t);
    expect(mailbox(t).sent).toHaveLength(3);
  });

  it('sends nothing, in any form, to an anonymized customer', async () => {
    const gone = await insertCustomer(db, { status: 'anonymized' });
    expect(await enqueue(orderMail(gone, 'order-9:email'))).toEqual({ status: 'skipped', reason: 'recipient_gone' });
    expect(await items()).toHaveLength(0);
    expect(await notificationRows(db)).toHaveLength(0);
  });

  it('makes no item for an event with no registered text', async () => {
    const customerId = await insertCustomer(db);
    await enqueue({
      event: 'checkout.abandoned',
      recipient: { type: 'customer', id: customerId },
      channel: 'email',
      variables: { customerName: 'Dana', device: 'iPhone', link: 'https://shop.example.com/x' },
      dedupeKey: 'recovery-1:email',
    });
    expect(await items()).toHaveLength(0);
  });
});

describe('merchant events', () => {
  const lowBalance = (clientId: number) =>
    eventJob('wallet.low_balance', 'ledger_accounts', 1, {
      clientId,
      currency: 'USD',
      available: '10.0000',
      threshold: '50.0000',
    });

  it('makes one item with the mail, and a job that runs twice makes one', async () => {
    const clientId = await insertMerchant(db, { email: 'ops@zainmobilehub.example' });
    const job = lowBalance(clientId);
    expect(await planEvent(t, job)).toEqual({ created: 1 });
    expect(await planEvent(t, job)).toEqual({ created: 0 });
    const rows = await items();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      recipientType: 'client',
      recipientId: clientId,
      event: 'wallet.low_balance',
      category: 'wallet',
      dedupeKey: `inapp:merchant:wallet.low_balance:outbox-${job.eventId}`,
    });
  });

  it('still makes the item for a merchant who switched email and Telegram off', async () => {
    const clientId = await insertMerchant(db, {
      email: 'ops@zainmobilehub.example',
      notificationPrefs: { events: { 'wallet.low_balance': { email: false, telegram: false } } },
    });
    expect(await planEvent(t, lowBalance(clientId))).toEqual({ created: 0, skipped: 'opted_out' });
    expect(await items()).toHaveLength(1);
    expect(await notificationRows(db)).toHaveLength(0);
  });

  it('makes none for a suspended merchant and one for a merchant waiting for approval', async () => {
    const suspended = await insertMerchant(db, { status: 'suspended' });
    await planEvent(t, lowBalance(suspended));
    expect(await items()).toHaveLength(0);
    const pending = await insertMerchant(db, { status: 'pending' });
    await planEvent(t, lowBalance(pending));
    expect(await items()).toHaveLength(1);
  });
});
