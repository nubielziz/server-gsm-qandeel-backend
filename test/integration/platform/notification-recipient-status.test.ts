// Integration tests of the account status rule in `recipientOf` and of the mail an event template makes (feature 23, plan sections 9.3-9.5,
// S6; decision 039; decision 064): an anonymized account gets nothing, a blocked or suspended one (of either rank) still gets the transactional
// mails (order, ticket) and not the others, and every account gets the event's one template as rendered, or nothing when it is off or gone.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { DbService, type Database, schema as s } from '@src/infra/db';
import { RedisService } from '@src/infra/redis';
import { type NotificationInput, NotificationService } from '@src/modules/platform';
import { SUPPORT_DEFAULT_TEMPLATES } from '@src/modules/support';
import { type TestApp, createTestApp } from '../../support/app';
import { makeAccount } from '../../support/accounts';
import { insertCustomer } from '../../support/campaigns';
import { TestClock } from '../../support/clock';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { mailbox, notificationRows, seedDefaultTemplates, sendAllQueued } from '../../support/notifications';
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
  await db
    .insert(s.notificationTemplates)
    .values(SUPPORT_DEFAULT_TEMPLATES.map((template) => ({ ...template, isActive: true })));
  mailbox(t).reset();
});

const enqueue = (input: NotificationInput) =>
  t.app.get(DbService).runInTransaction(({ tx }) => t.app.get(NotificationService).enqueue({ tx }, input));
const orderFailed = (customerId: number, key = 'order-1-failed:email'): NotificationInput => ({
  event: 'order.failed',
  recipient: { type: 'account', id: customerId },
  channel: 'email',
  variables: { customerName: 'Dana', orderId: '4021', amount: '£13.75', service: 'iPhone unlock', device: 'iPhone 15' },
  dedupeKey: key,
});
const ticket = (event: string, customerId: number): NotificationInput => ({
  event,
  recipient: { type: 'account', id: customerId },
  channel: 'email',
  variables: {
    customerName: 'Dana',
    ticketNumber: 'T-1042',
    subject: 'Where is my unlock?',
    link: 'https://shop.example.com/support/tickets/x',
  },
  dedupeKey: `${event}-1:email`,
});

describe('an account that is not active', () => {
  it('gets nothing, in any form, once anonymized: a row made before is failed at send time', async () => {
    const customerId = await insertCustomer(db, { name: 'Dana' });
    expect(await enqueue(orderFailed(customerId))).toMatchObject({ status: 'queued' });
    await db
      .update(s.clients)
      .set({ status: 'anonymized', anonymizedAt: clock.now() })
      .where(eq(s.clients.id, customerId));
    expect(await enqueue(orderFailed(customerId, 'order-2-failed:email'))).toEqual({
      status: 'skipped',
      reason: 'recipient_gone',
    });
    const outcomes = await sendAllQueued(t);
    expect(outcomes).toEqual([{ outcome: 'failed', reason: 'The recipient no longer exists.' }]);
    expect(mailbox(t).sent).toHaveLength(0);
  });

  it('still gets the transactional mails when blocked or suspended: an order result and the receipt of a ticket', async () => {
    const blocked = await insertCustomer(db, { status: 'blocked' });
    const suspended = await insertCustomer(db, { status: 'suspended' });
    expect(await enqueue(orderFailed(blocked))).toMatchObject({ status: 'queued' });
    expect(await enqueue(ticket('support.ticket_received', suspended))).toMatchObject({ status: 'queued' });
    const outcomes = await sendAllQueued(t);
    expect(outcomes).toEqual([{ outcome: 'sent' }, { outcome: 'sent' }]);
    expect(
      mailbox(t)
        .sent.map((mail) => mail.to)
        .sort(),
    ).toHaveLength(2);
  });

  it('reads the status of a merchant rank the same way: a blocked or suspended one gets the mails it needs and a suspended one no other', async () => {
    const blocked = await makeAccount({ db, rank: 'merchant', status: 'blocked' });
    const suspended = await makeAccount({ db, rank: 'merchant', status: 'suspended' });
    // The shop's order mail names the customer text (the door of the order), whatever the rank is.
    expect(await enqueue({ ...orderFailed(blocked.id, 'm-1:email'), audience: 'customer' })).toMatchObject({
      status: 'queued',
    });
    expect(await enqueue({ ...orderFailed(suspended.id, 'm-2:email'), audience: 'customer' })).toMatchObject({
      status: 'queued',
    });
    // A merchant message that is not transactional is skipped for a suspended or blocked account.
    const lowBalance = {
      event: 'wallet.low_balance',
      recipient: { type: 'account' as const, id: suspended.id },
      channel: 'email' as const,
      variables: { merchantName: 'Zain', currency: 'USD', available: '1.00', threshold: '2.00' },
    };
    expect(await enqueue(lowBalance)).toEqual({ status: 'skipped', reason: 'recipient_suspended' });
    expect(await sendAllQueued(t)).toEqual([{ outcome: 'sent' }, { outcome: 'sent' }]);
  });
});

describe('the mail of an event template', () => {
  const orderFailedTemplate = eq(s.notificationTemplates.event, 'order.failed');

  it('is the template as rendered for every customer: a text template makes a text mail with no HTML part', async () => {
    const first = await insertCustomer(db, { name: 'Dana' });
    const second = await insertCustomer(db, { name: 'Omar' });
    await enqueue(orderFailed(first, 'o-1:email'));
    await enqueue(orderFailed(second, 'o-2:email'));
    await sendAllQueued(t);
    const sent = mailbox(t).sent;
    expect(sent).toHaveLength(2);
    for (const mail of sent) {
      expect(mail.subject).toBe('We couldn’t unlock order 4021');
      expect(mail.text).toContain('£13.75');
      expect(mail.html).toBeUndefined();
    }
  });

  it('carries the markup of an HTML template as rendered, with the values escaped and nothing wrapped around it', async () => {
    const customerId = await insertCustomer(db);
    await db.update(s.notificationTemplates).set({ body: '<p>Hi {{customerName}}</p>' }).where(orderFailedTemplate);
    await enqueue({
      ...orderFailed(customerId),
      variables: { ...orderFailed(customerId).variables, customerName: 'Dana <b>' },
    });
    await sendAllQueued(t);
    expect(mailbox(t).sent[0]!.html).toBe('<p>Hi Dana &lt;b&gt;</p>');
  });

  it('is not made while the template is switched off or missing, and a queued one fails at send time when it is switched off or deleted', async () => {
    const customerId = await insertCustomer(db);
    await db.update(s.notificationTemplates).set({ isActive: false }).where(orderFailedTemplate);
    expect(await enqueue(orderFailed(customerId))).toEqual({ status: 'skipped', reason: 'template_off' });
    await db.delete(s.notificationTemplates).where(orderFailedTemplate);
    expect(await enqueue(orderFailed(customerId))).toEqual({ status: 'skipped', reason: 'no_template' });
    expect(await notificationRows(db)).toHaveLength(0);

    await seedDefaultTemplates(db);
    expect(await enqueue(orderFailed(customerId, 'o-3:email'))).toMatchObject({ status: 'queued' });
    expect(await enqueue(orderFailed(customerId, 'o-4:email'))).toMatchObject({ status: 'queued' });
    await db.update(s.notificationTemplates).set({ isActive: false }).where(orderFailedTemplate);
    expect(await sendAllQueued(t)).toEqual([
      { outcome: 'failed', reason: 'The template is switched off.' },
      { outcome: 'failed', reason: 'The template is switched off.' },
    ]);
    await db.update(s.notificationTemplates).set({ isActive: true }).where(orderFailedTemplate);
    expect(await enqueue(orderFailed(customerId, 'o-5:email'))).toMatchObject({ status: 'queued' });
    await db.delete(s.notificationTemplates).where(orderFailedTemplate);
    // The two rows that failed above are finished; only the new one is sent, and fails.
    expect(await sendAllQueued(t)).toEqual([
      { outcome: 'skipped', reason: 'already_failed' },
      { outcome: 'skipped', reason: 'already_failed' },
      { outcome: 'failed', reason: 'There is no template for this message.' },
    ]);
    expect(mailbox(t).sent).toEqual([]);
  });
});
