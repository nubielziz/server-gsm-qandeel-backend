// Integration tests of the in-app items events make (feature 23, plan section 9.2, S9; decision 064): a storefront order mail also makes one
// inbox item for an account with a login (and none for a guest, a suspended, a blocked or an anonymized one), a low balance makes one even
// when the account switched email off, a job that runs twice makes one, an event without a registered text makes none, and the text of an
// item follows the audience the message names (the door of the order), not the rank the account holds when it reads.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { DbService, type Database, schema as s } from '@src/infra/db';
import { RedisService } from '@src/infra/redis';
import { type NotificationInput, NotificationService } from '@src/modules/platform';
import { SUPPORT_DEFAULT_TEMPLATES } from '@src/modules/support';
import { type TestApp, createTestApp } from '../../support/app';
import { insertMerchant } from '../../support/auth';
import { insertCustomer } from '../../support/campaigns';
import { TestClock } from '../../support/clock';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import {
  eventJob,
  mailbox,
  merchantSession,
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
  recipient: { type: 'account', id: customerId },
  channel: 'email',
  variables: { customerName: 'Dana', orderId: '4021', service: 'Vodafone UK iPhone Unlock', device: 'iPhone 15' },
  ...(dedupeKey === undefined ? {} : { dedupeKey }),
});

describe('events of the customer audience', () => {
  it('makes one inbox item beside the mail, with the occurrence as its key, and none the second time', async () => {
    const customerId = await insertCustomer(db, { name: 'Dana' });
    const first = await enqueue(orderMail(customerId, 'order-4021-completed:email'));
    expect(first).toMatchObject({ status: 'queued', created: true });
    const again = await enqueue(orderMail(customerId, 'order-4021-completed:email'));
    expect(again).toMatchObject({ status: 'queued', created: false });
    const rows = await items();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      recipientType: 'account',
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

  it('makes no item for a guest, a suspended or a blocked account, but still mails them (the event is transactional)', async () => {
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

  it('sends nothing, in any form, to an anonymized account', async () => {
    const gone = await insertCustomer(db, { status: 'anonymized', anonymizedAt: clock.now() });
    expect(await enqueue(orderMail(gone, 'order-9:email'))).toEqual({ status: 'skipped', reason: 'recipient_gone' });
    expect(await items()).toHaveLength(0);
    expect(await notificationRows(db)).toHaveLength(0);
  });

  it('makes no item for an event with no registered text, and still writes its mail', async () => {
    const customerId = await insertCustomer(db);
    await db
      .insert(s.notificationTemplates)
      .values(SUPPORT_DEFAULT_TEMPLATES.map((template) => ({ ...template, isActive: true })));
    const made = await enqueue({
      event: 'support.ticket_received',
      recipient: { type: 'account', id: customerId },
      channel: 'email',
      variables: {
        customerName: 'Dana',
        ticketNumber: 'T-1042',
        subject: 'Where is my unlock?',
        link: 'https://shop.example.com/support/tickets/x',
      },
      dedupeKey: 'ticket-1:email',
    });
    expect(made.status).toBe('queued');
    expect(await items()).toHaveLength(0);
  });
});

describe('events of the merchant audience', () => {
  const lowBalance = (clientId: number) =>
    eventJob('wallet.low_balance', 'ledger_accounts', 1, {
      accountId: clientId,
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
      recipientType: 'account',
      recipientId: clientId,
      event: 'wallet.low_balance',
      category: 'wallet',
      dedupeKey: `inapp:merchant:wallet.low_balance:outbox-${job.eventId}`,
    });
  });

  it('still makes the item for a merchant who switched email off', async () => {
    const clientId = await insertMerchant(db, {
      email: 'ops@zainmobilehub.example',
      notificationPrefs: { events: { 'wallet.low_balance': { email: false } } },
    });
    expect(await planEvent(t, lowBalance(clientId))).toEqual({ created: 0, skipped: 'opted_out' });
    expect(await items()).toHaveLength(1);
    expect(await notificationRows(db)).toHaveLength(0);
  });

  it('makes none for a suspended or a blocked merchant account and one for an active one (the one reading of a status)', async () => {
    const suspended = await insertMerchant(db, { status: 'suspended' });
    await planEvent(t, lowBalance(suspended));
    expect(await items()).toHaveLength(0);
    const blocked = await insertMerchant(db, { status: 'blocked' });
    await planEvent(t, lowBalance(blocked));
    expect(await items()).toHaveLength(0);
    const active = await insertMerchant(db);
    await planEvent(t, lowBalance(active));
    expect(await items()).toHaveLength(1);
  });
});

describe('one account, two audiences', () => {
  it('makes the item of the audience the message names and shows it with its own text to a merchant rank', async () => {
    const merchantId = await insertMerchant(db, { email: 'ops@zainmobilehub.example' });
    // An order of the shop door of an account that holds a merchant rank today: the customer text, never the rank's.
    const made = await enqueue({ ...orderMail(merchantId, 'shop-order-1:email'), audience: 'customer' });
    expect(made).toMatchObject({ status: 'queued', created: true });
    const [row] = await items();
    expect(row).toMatchObject({
      recipientType: 'account',
      recipientId: merchantId,
      event: 'order.completed',
      dedupeKey: 'inapp:customer:order.completed:shop-order-1',
    });
    // The merchant portal reads the same inbox: the audience in the occurrence key finds the customer text.
    const merchant = await merchantSession(t, merchantId);
    const list = (await merchant.call('GET', '/client/notifications')).body;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ title: 'Order 4021 completed', event: 'order.completed' });
  });

  it('makes no item when the named audience has no in-app text for the event, whatever the rank', async () => {
    const merchantId = await insertMerchant(db);
    // A merchant's order result has no in-app text (thousands a day on the API): the merchant audience makes the mail only.
    const made = await enqueue({
      event: 'order.completed',
      recipient: { type: 'account', id: merchantId },
      audience: 'merchant',
      channel: 'email',
      variables: { merchantName: 'Zain', orderId: '4021', service: 'Unlock', resultCode: 'CLEAN', resultComment: 'ok' },
      dedupeKey: 'portal-order-1:email',
    });
    expect(made.status).toBe('queued');
    expect(await items()).toHaveLength(0);
  });
});
