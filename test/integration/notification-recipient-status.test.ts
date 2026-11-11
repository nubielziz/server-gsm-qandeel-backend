// Integration tests of the customer status fix in `recipientOf` and of the Arabic mails (feature 23, plan sections 9.3-9.5, S6): an anonymized
// customer gets nothing, a blocked or suspended one still gets the transactional mails (order, ticket) and not the others (survey, checkout
// reminder), an Arabic customer's mail is Arabic with a right-to-left HTML part, and an English mail is exactly what it was.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { DbService, type Database, schema as s } from '../../src/infra/db';
import { RedisService } from '../../src/infra/redis';
import { ARABIC_DEFAULT_TEMPLATES, type NotificationInput, NotificationService } from '../../src/modules/platform';
import { SUPPORT_DEFAULT_TEMPLATES } from '../../src/modules/support';
import { type TestApp, createTestApp } from '../support/app';
import { insertCustomer } from '../support/campaigns';
import { TestClock } from '../support/clock';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { mailbox, notificationRows, seedDefaultTemplates, sendAllQueued } from '../support/notifications';
import { deleteBullKeys, testBullPrefix } from '../support/queues';

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
  recipient: { type: 'customer', id: customerId },
  channel: 'email',
  variables: { customerName: 'Dana', orderId: '4021', amount: '£13.75', service: 'iPhone unlock', device: 'iPhone 15' },
  dedupeKey: key,
});
const ticket = (event: string, customerId: number): NotificationInput => ({
  event,
  recipient: { type: 'customer', id: customerId },
  channel: 'email',
  variables: {
    customerName: 'Dana',
    ticketNumber: 'T-1042',
    subject: 'Where is my unlock?',
    link: 'https://shop.example.com/support/tickets/x',
  },
  dedupeKey: `${event}-1:email`,
});

describe('a customer who is not active', () => {
  it('gets nothing, in any form, once anonymized: a row made before is failed at send time', async () => {
    const customerId = await insertCustomer(db, { name: 'Dana' });
    expect(await enqueue(orderFailed(customerId))).toMatchObject({ status: 'queued' });
    await db.update(s.customers).set({ status: 'anonymized' }).where(eq(s.customers.id, customerId));
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

  it('no longer gets the satisfaction survey or the checkout reminder: they are not transactional', async () => {
    const suspended = await insertCustomer(db, { status: 'suspended' });
    expect(await enqueue(ticket('support.csat_survey', suspended))).toEqual({
      status: 'skipped',
      reason: 'recipient_suspended',
    });
    expect(
      await enqueue({
        event: 'checkout.abandoned',
        recipient: { type: 'customer', id: suspended },
        channel: 'email',
        variables: { customerName: 'Dana', device: 'iPhone', link: 'https://shop.example.com/x' },
        dedupeKey: 'recovery-1:email',
      }),
    ).toEqual({ status: 'skipped', reason: 'recipient_suspended' });
    expect(await notificationRows(db)).toHaveLength(0);
  });

  it('judges a row again at send time: a customer suspended after the survey was queued gets no survey', async () => {
    const customerId = await insertCustomer(db);
    expect(await enqueue(ticket('support.csat_survey', customerId))).toMatchObject({ status: 'queued' });
    await db.update(s.customers).set({ status: 'suspended' }).where(eq(s.customers.id, customerId));
    expect(await sendAllQueued(t)).toEqual([{ outcome: 'failed', reason: 'The recipient is suspended.' }]);
  });
});

describe('Arabic mail', () => {
  beforeEach(async () => {
    await db
      .insert(s.notificationTemplates)
      .values(ARABIC_DEFAULT_TEMPLATES.map((template) => ({ ...template, isActive: true })));
  });

  it('is Arabic with a right-to-left HTML part for an Arabic customer, and unchanged for an English one', async () => {
    const arabic = await insertCustomer(db, { locale: 'ar', name: 'دانة' });
    const english = await insertCustomer(db, { locale: 'en', name: 'Dana' });
    await enqueue(orderFailed(arabic, 'o-1:email'));
    await enqueue(orderFailed(english, 'o-2:email'));
    await sendAllQueued(t);
    const [first, second] = mailbox(t).sent;
    expect(first!.subject).toBe('تعذّر فتح القفل للطلب 4021');
    expect(first!.text).toContain('أعدنا £13.75 إلى بطاقتك');
    expect(first!.html).toStartWith('<div dir="rtl" lang="ar" style="text-align:right">');
    expect(first!.html).toContain('أعدنا £13.75');
    // The English mail has the text part only, exactly as before this feature.
    expect(second!.subject).toBe('We couldn’t unlock order 4021');
    expect(second!.html).toBeUndefined();
  });

  it('wraps the markup of an HTML template in a right-to-left div for an Arabic reader only', async () => {
    const arabic = await insertCustomer(db, { locale: 'ar' });
    const english = await insertCustomer(db, { locale: 'en' });
    await db
      .update(s.notificationTemplates)
      .set({ body: '<p>مرحباً {{customerName}}</p>' })
      .where(eq(s.notificationTemplates.locale, 'ar'));
    await db
      .update(s.notificationTemplates)
      .set({ body: '<p>Hi {{customerName}}</p>' })
      .where(eq(s.notificationTemplates.locale, 'en'));
    await enqueue(orderFailed(arabic, 'o-1:email'));
    await enqueue(orderFailed(english, 'o-2:email'));
    await sendAllQueued(t);
    const [first, second] = mailbox(t).sent;
    expect(first!.html).toBe('<div dir="rtl" lang="ar" style="text-align:right"><p>مرحباً Dana</p></div>');
    expect(second!.html).toBe('<p>Hi Dana</p>');
  });

  it('falls back to the English template for an Arabic customer when the Arabic one is switched off', async () => {
    const arabic = await insertCustomer(db, { locale: 'ar' });
    await db.update(s.notificationTemplates).set({ isActive: false }).where(eq(s.notificationTemplates.locale, 'ar'));
    expect(await enqueue(orderFailed(arabic))).toMatchObject({ status: 'queued' });
    await sendAllQueued(t);
    // The reader is Arabic, the template is the English one: the HTML part still reads right to left.
    expect(mailbox(t).sent[0]!.subject).toBe('We couldn’t unlock order 4021');
    expect(mailbox(t).sent[0]!.html).toStartWith('<div dir="rtl" lang="ar"');
  });
});
