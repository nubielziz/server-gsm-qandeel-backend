// Integration tests of the notification template routes (feature 12a, stage 12): list with filters, search and the 30-day count, one template,
// create, change, delete and the preview, with the audit entries and the refusals of RULES settings 10. Real Postgres and Redis through HTTP.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { schema as s } from '../../src/infra/db';
import { DEFAULT_TEMPLATES } from '../../src/modules/platform';
import { type AdminApi, adminWith } from '../support/admin-api';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches, insertMerchant } from '../support/auth';
import { DAY, TestClock } from '../support/clock';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { mailbox, seedDefaultTemplates, telegramOutbox } from '../support/notifications';

const clock = new TestClock('2026-11-01T10:00:00.000Z');
let t: TestApp;
let owner: AdminApi;

beforeAll(async () => {
  t = await createTestApp({
    clock,
    env: { TELEGRAM_BOT_TOKEN: '1234567890:AAtest-token', TELEGRAM_BOT_USERNAME: 'gsm_test_bot' },
  });
});
afterAll(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await t.close();
  await closeTestDb();
});
beforeEach(async () => {
  clock.set('2026-11-01T10:00:00.000Z');
  await resetDb();
  await clearIdentityCaches(t);
  await seedDefaultTemplates((await testDb()).db);
  mailbox(t).reset();
  telegramOutbox(t).reset();
  owner = await adminWith(t, ['*'], { name: 'Rami K.' });
});

const fieldsOf = (body: { errors: Array<{ field: string }> }) => body.errors.map((error) => error.field);
// A customer template of an event no migration ships a default for (`support.reply`), so a test can add the first one.
const customerSupportReply = {
  event: 'support.reply',
  channel: 'email',
  audience: 'customer',
  locale: 'en',
  subject: 'Re: your question',
  body: 'Hi {{customerName}}, we looked into it.',
  isActive: true,
};

async function audit() {
  const { db } = await testDb();
  return db.select().from(s.auditLogs).orderBy(s.auditLogs.id);
}

async function idOf(event: string, channel: 'email' | 'telegram', audience = 'merchant', locale = 'en') {
  const { db } = await testDb();
  const rows = await db.select().from(s.notificationTemplates);
  return rows.find(
    (row) => row.event === event && row.channel === channel && row.audience === audience && row.locale === locale,
  )!.id;
}

describe('GET /admin/notification-templates', () => {
  it('lists every template, event A to Z, with the exact total and the wire fields', async () => {
    const res = await owner.get('/admin/notification-templates?_start=0&_end=100');
    expect(res.status).toBe(200);
    expect(res.total).toBe(DEFAULT_TEMPLATES.length);
    const events = res.body.map((row: { event: string }) => row.event);
    expect(events).toEqual([...events].sort());
    // The alert templates of feature 12b (staff audience) come first, then the merchant and customer ones.
    expect(res.body[0]).toMatchObject({
      event: 'alert.fired',
      channel: 'email',
      audience: 'staff',
      subject: 'Alert ({{severity}}): {{ruleName}} - {{subject}}',
    });
    // The wire fields of one row: the first customer account mail of feature 14b.
    expect(res.body.find((row: { event: string }) => row.event === 'customer.email_verification')).toEqual({
      id: expect.any(Number),
      event: 'customer.email_verification',
      channel: 'email',
      audience: 'customer',
      locale: 'en',
      subject: 'Confirm your email address',
      body: expect.stringContaining('{{customerName}}'),
      isActive: true,
      sentLast30Days: 0,
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    });
  });

  it('filters by audience, channel, switch, event and language, searches the event and the subject, and pages', async () => {
    const { db } = await testDb();
    await db.insert(s.notificationTemplates).values({
      event: 'support.reply',
      channel: 'email',
      audience: 'customer',
      locale: 'en-GB',
      subject: 'Zebra reply',
      body: 'Hi {{customerName}}',
      isActive: false,
    });
    const total = async (query: string) => (await owner.get(`/admin/notification-templates?${query}`)).total;
    expect(await total('channel=telegram')).toBe(DEFAULT_TEMPLATES.filter((x) => x.channel === 'telegram').length);
    // The customer mails of features 14b and 16 ship with a default template each, next to the one this test adds.
    expect(await total('audience=customer')).toBe(
      DEFAULT_TEMPLATES.filter((x) => x.audience === 'customer').length + 1,
    );
    expect(await total('isActive=false')).toBe(1);
    expect(await total('event=wallet.low_balance')).toBe(2);
    expect(await total('locale=en-GB')).toBe(1);
    expect(await total('q=ZEBRA')).toBe(1);
    expect(await total('q=low_balance')).toBe(2);
    const page = await owner.get('/admin/notification-templates?_sort=id&_order=desc&_start=1&_end=3');
    expect(page.body).toHaveLength(2);
    expect(page.total).toBe(DEFAULT_TEMPLATES.length + 1);
    expect(page.body[0].id).toBeGreaterThan(page.body[1].id);
    expect((await owner.get('/admin/notification-templates?audience=robot')).status).toBe(422);
  });

  it('counts the messages sent in the last 30 days per event, channel and kind of recipient, whatever the language', async () => {
    const { db } = await testDb();
    const merchant = await insertMerchant(db);
    const sent = (days: number) => new Date(clock.nowMs() - days * DAY);
    const base = { recipientType: 'client' as const, recipientId: merchant, event: 'wallet.low_balance', payload: {} };
    await db.insert(s.notifications).values([
      { ...base, channel: 'email', status: 'sent', sentAt: sent(1) },
      { ...base, channel: 'email', status: 'sent', sentAt: sent(29) },
      { ...base, channel: 'email', status: 'sent', sentAt: sent(31) },
      { ...base, channel: 'email', status: 'failed', error: 'no' },
      { ...base, channel: 'email', status: 'queued' },
      { ...base, channel: 'telegram', status: 'sent', sentAt: sent(2) },
      { ...base, recipientType: 'customer', channel: 'email', status: 'sent', sentAt: sent(2) },
    ]);
    // A second language of the same template shows the same number.
    await db.insert(s.notificationTemplates).values({
      event: 'wallet.low_balance',
      channel: 'email',
      audience: 'merchant',
      locale: 'de',
      subject: 'Guthaben niedrig',
      body: 'Hallo {{merchantName}}',
    });
    const rows = (await owner.get('/admin/notification-templates?event=wallet.low_balance')).body;
    const countOf = (channel: string, locale: string) =>
      rows.find((row: { channel: string; locale: string }) => row.channel === channel && row.locale === locale)
        .sentLast30Days;
    expect(countOf('email', 'en')).toBe(2);
    expect(countOf('email', 'de')).toBe(2);
    expect(countOf('telegram', 'en')).toBe(1);
    const one = await owner.get(`/admin/notification-templates/${await idOf('wallet.low_balance', 'email')}`);
    expect(one.body.sentLast30Days).toBe(2);
  });

  it('needs a session and the notifications:read permission', async () => {
    expect((await owner.anonymous('GET', '/admin/notification-templates')).status).toBe(401);
    const nobody = await adminWith(t, ['orders:read']);
    expect((await nobody.get('/admin/notification-templates')).body.code).toBe('FORBIDDEN');
    const reader = await adminWith(t, ['notifications:read']);
    expect((await reader.get('/admin/notification-templates')).status).toBe(200);
  });
});

describe('GET /admin/notification-templates/:id', () => {
  it('answers one template, 404 for an unknown id and 422 for a bad one', async () => {
    const id = await idOf('merchant.invited', 'email');
    const res = await owner.get(`/admin/notification-templates/${id}`);
    expect(res.body).toMatchObject({
      id,
      event: 'merchant.invited',
      audience: 'merchant',
      subject: expect.any(String),
    });
    expect((await owner.get('/admin/notification-templates/99999')).body.code).toBe('NOT_FOUND');
    expect((await owner.get('/admin/notification-templates/abc')).status).toBe(422);
  });
});

describe('POST /admin/notification-templates', () => {
  it('adds a template for a registered event, with the defaults, and writes the audit entry', async () => {
    const res = await owner.post('/admin/notification-templates', {
      ...customerSupportReply,
      locale: undefined,
      isActive: undefined,
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ ...customerSupportReply, sentLast30Days: 0 });
    const entries = await audit();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      action: 'created notification template',
      entityType: 'notification_template',
      entityId: res.body.id,
      entityLabel: 'support.reply (email, customer, en)',
      actorName: 'Rami K.',
      before: null,
      after: { event: 'support.reply', channel: 'email', audience: 'customer', locale: 'en', isActive: true },
    });
  });

  it('keeps a Telegram template without a subject, whatever was sent', async () => {
    const res = await owner.post('/admin/notification-templates', {
      event: 'order.completed',
      channel: 'telegram',
      audience: 'merchant',
      locale: 'en-GB',
      subject: 'ignored',
      body: 'Order {{orderId}} is complete.',
    });
    expect(res.status).toBe(201);
    expect(res.body.subject).toBe('');
    expect(res.body.locale).toBe('en-GB');
  });

  it('refuses an event the system does not send, with 422 on event', async () => {
    const unknown = await owner.post('/admin/notification-templates', {
      ...customerSupportReply,
      event: 'order.teleported',
    });
    expect(unknown.status).toBe(422);
    expect(fieldsOf(unknown.body)).toEqual(['event']);
    expect(unknown.body.errors[0].code).toBe('unknown_event');
    const typo = await owner.post('/admin/notification-templates', {
      ...customerSupportReply,
      event: 'Order Completed',
    });
    expect(fieldsOf(typo.body)).toEqual(['event']);
    expect(await audit()).toEqual([]);
  });

  it('refuses an event that is not sent to the audience or not by the channel', async () => {
    const audience = await owner.post('/admin/notification-templates', {
      ...customerSupportReply,
      event: 'wallet.low_balance',
      body: 'Low',
    });
    expect(fieldsOf(audience.body)).toEqual(['audience']);
    const channel = await owner.post('/admin/notification-templates', {
      ...customerSupportReply,
      channel: 'telegram',
      subject: '',
    });
    expect(fieldsOf(channel.body)).toEqual(['channel']);
  });

  it('refuses a second template for the same event, channel, audience and language with 422 on event, also in parallel', async () => {
    expect((await owner.post('/admin/notification-templates', customerSupportReply)).status).toBe(201);
    const again = await owner.post('/admin/notification-templates', customerSupportReply);
    expect(again.status).toBe(422);
    expect(again.body.errors[0]).toMatchObject({
      field: 'event',
      message: 'A template for this event, channel and language already exists.',
    });
    // Another language is a different template.
    expect(
      (await owner.post('/admin/notification-templates', { ...customerSupportReply, locale: 'en-GB' })).status,
    ).toBe(201);

    const race = {
      ...customerSupportReply,
      event: 'checkout.abandoned',
      body: 'Hi {{customerName}}, you left {{device}} behind.',
    };
    const answers = await Promise.all(
      Array.from({ length: 4 }, () => owner.post('/admin/notification-templates', race)),
    );
    expect(answers.filter((answer) => answer.status === 201)).toHaveLength(1);
    expect(answers.filter((answer) => answer.status === 422)).toHaveLength(3);
  });

  it('refuses an email without a subject, an empty message, a bad language and a placeholder the event does not offer', async () => {
    const post = (patch: Record<string, unknown>) =>
      owner.post('/admin/notification-templates', { ...customerSupportReply, ...patch });
    expect(fieldsOf((await post({ subject: '  ' })).body)).toEqual(['subject']);
    expect(fieldsOf((await post({ body: '   ' })).body)).toEqual(['body']);
    expect(fieldsOf((await post({ locale: 'English' })).body)).toEqual(['locale']);
    const typo = await post({ body: 'Hi {{custmerName}}, order {{orderId}}' });
    expect(fieldsOf(typo.body)).toEqual(['body']);
    expect(typo.body.errors[0].message).toContain('{{custmerName}}');
    expect(typo.body.errors[0].message).toContain('{{customerName}}');
    // `support.reply` offers `{{link}}` (feature 17), so this one asks an event that has none, in a language with no default.
    expect(fieldsOf((await post({ event: 'order.completed', locale: 'ar', subject: 'Hello {{link}}' })).body)).toEqual([
      'subject',
    ]);
    expect((await post({ body: undefined })).status).toBe(422);
    expect((await post({ channel: 'sms' })).status).toBe(422);
    expect(await audit()).toEqual([]);
  });

  it('needs a CSRF token and the notifications:create permission', async () => {
    expect((await owner.withoutCsrf('POST', '/admin/notification-templates', customerSupportReply)).body.code).toBe(
      'CSRF_FAILED',
    );
    const reader = await adminWith(t, ['notifications:read']);
    expect((await reader.post('/admin/notification-templates', customerSupportReply)).body.code).toBe('FORBIDDEN');
    const creator = await adminWith(t, ['notifications:create']);
    expect((await creator.post('/admin/notification-templates', customerSupportReply)).status).toBe(201);
  });
});

describe('PATCH /admin/notification-templates/:id', () => {
  it('edits the subject and the body and audits the change with before and after', async () => {
    const id = await idOf('wallet.low_balance', 'email');
    const res = await owner.patch(`/admin/notification-templates/${id}`, {
      subject: 'Top up soon',
      body: 'Hi {{merchantName}}, you have {{available}} {{currency}} left.',
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id,
      subject: 'Top up soon',
      body: 'Hi {{merchantName}}, you have {{available}} {{currency}} left.',
    });
    const [entry] = await audit();
    expect(entry).toMatchObject({
      action: 'edited notification template',
      entityLabel: 'wallet.low_balance (email, merchant, en)',
      before: { subject: 'Your wallet balance is low' },
      after: { subject: 'Top up soon' },
    });
  });

  it('turns a template off and on with the demo verb phrases, and audits a request that changes nothing too', async () => {
    const id = await idOf('invoice.paid', 'telegram');
    expect((await owner.patch(`/admin/notification-templates/${id}`, { isActive: false })).body.isActive).toBe(false);
    expect((await owner.patch(`/admin/notification-templates/${id}`, { isActive: true })).body.isActive).toBe(true);
    expect((await owner.patch(`/admin/notification-templates/${id}`, { isActive: true })).status).toBe(200);
    expect((await audit()).map((entry) => entry.action)).toEqual([
      'turned off notification',
      'turned on notification',
      'turned on notification',
    ]);
  });

  it('fixes event, channel, audience and language after create: another value is 422 on that field, the same value is fine', async () => {
    const id = await idOf('wallet.low_balance', 'email');
    const res = await owner.patch(`/admin/notification-templates/${id}`, {
      event: 'deposit.approved',
      channel: 'telegram',
      audience: 'staff',
      locale: 'de',
    });
    expect(res.status).toBe(422);
    expect(fieldsOf(res.body)).toEqual(['event', 'channel', 'audience', 'locale']);
    expect(res.body.errors[0].code).toBe('immutable');
    const same = await owner.patch(`/admin/notification-templates/${id}`, {
      event: 'wallet.low_balance',
      channel: 'email',
      audience: 'merchant',
      locale: 'en',
      isActive: false,
    });
    expect(same.status).toBe(200);
  });

  it('checks the texts it is given, but lets a template with an old placeholder be switched off', async () => {
    const { db } = await testDb();
    const id = await idOf('wallet.low_balance', 'email');
    expect(fieldsOf((await owner.patch(`/admin/notification-templates/${id}`, { body: 'Hi {{nope}}' })).body)).toEqual([
      'body',
    ]);
    expect(fieldsOf((await owner.patch(`/admin/notification-templates/${id}`, { subject: '' })).body)).toEqual([
      'subject',
    ]);
    expect(fieldsOf((await owner.patch(`/admin/notification-templates/${id}`, { body: ' ' })).body)).toEqual(['body']);
    await db
      .update(s.notificationTemplates)
      .set({ body: 'Old {{removedVariable}}' })
      .where(eq(s.notificationTemplates.id, id));
    expect((await owner.patch(`/admin/notification-templates/${id}`, { isActive: false })).status).toBe(200);
    expect((await owner.patch('/admin/notification-templates/99999', { isActive: false })).body.code).toBe('NOT_FOUND');
  });

  it('needs the notifications:update permission', async () => {
    const id = await idOf('invoice.paid', 'telegram');
    const reader = await adminWith(t, ['notifications:read']);
    expect((await reader.patch(`/admin/notification-templates/${id}`, { isActive: false })).body.code).toBe(
      'FORBIDDEN',
    );
  });
});

describe('DELETE /admin/notification-templates/:id', () => {
  it('deletes the template and audits what it held', async () => {
    const id = await idOf('invoice.paid', 'telegram');
    const res = await owner.delete(`/admin/notification-templates/${id}`);
    expect(res.status).toBe(204);
    expect((await owner.get(`/admin/notification-templates/${id}`)).status).toBe(404);
    const [entry] = await audit();
    expect(entry).toMatchObject({
      action: 'deleted notification template',
      entityLabel: 'invoice.paid (telegram, merchant, en)',
      before: { event: 'invoice.paid', channel: 'telegram', body: expect.stringContaining('Invoice') },
      after: null,
    });
    expect((await owner.delete(`/admin/notification-templates/${id}`)).body.code).toBe('NOT_FOUND');
    const reader = await adminWith(t, ['notifications:read']);
    expect(
      (await reader.delete(`/admin/notification-templates/${await idOf('invoice.paid', 'email')}`)).body.code,
    ).toBe('FORBIDDEN');
  });
});

describe('POST /admin/notification-templates/:id/preview', () => {
  it('renders the saved template with sample data, sends nothing and says the format and the sender', async () => {
    const id = await idOf('wallet.low_balance', 'email');
    const res = await owner.post(`/admin/notification-templates/${id}/preview`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      subject: 'Your wallet balance is low',
      body: expect.stringContaining('Hi Zain Mobile Hub,'),
      format: 'text',
      from: 'GSM <noreply@gsm.local>',
      note: 'A sample with made-up details.',
    });
    expect(res.body.body).toContain('42.5000 USD');
    expect(res.body.body).not.toContain('{{');
    expect(mailbox(t).sent).toEqual([]);
    expect(telegramOutbox(t).sent).toEqual([]);
  });

  it('previews unsaved text, leaves an unknown placeholder visible, and says html for a template with markup', async () => {
    const id = await idOf('wallet.low_balance', 'email');
    const typo = await owner.post(`/admin/notification-templates/${id}/preview`, {
      subject: 'Hello {{merchantName}} {{typo}}',
      body: 'Balance {{available}} and {{missing}}',
    });
    expect(typo.body).toMatchObject({
      subject: 'Hello Zain Mobile Hub {{typo}}',
      body: 'Balance 42.5000 and {{missing}}',
      format: 'text',
    });
    // The saved row is untouched.
    expect((await owner.get(`/admin/notification-templates/${id}`)).body.subject).toBe('Your wallet balance is low');

    const html = await owner.post(`/admin/notification-templates/${id}/preview`, {
      body: '<p>Hi <strong>{{merchantName}}</strong></p>',
    });
    expect(html.body.format).toBe('html');
    expect(html.body.body).toBe('<p>Hi <strong>Zain Mobile Hub</strong></p>');
  });

  it('previews a Telegram template with an empty subject and the bot as the sender', async () => {
    const id = await idOf('deposit.approved', 'telegram');
    const res = await owner.post(`/admin/notification-templates/${id}/preview`);
    expect(res.body).toMatchObject({
      subject: '',
      body: 'Deposit approved: 250.0000 USD was added to your wallet.',
      format: 'text',
      from: '@gsm_test_bot',
    });
  });

  it('answers 404 for an unknown template, and needs read access and a CSRF token', async () => {
    expect((await owner.post('/admin/notification-templates/99999/preview')).body.code).toBe('NOT_FOUND');
    const id = await idOf('wallet.low_balance', 'email');
    expect((await owner.withoutCsrf('POST', `/admin/notification-templates/${id}/preview`)).body.code).toBe(
      'CSRF_FAILED',
    );
    const nobody = await adminWith(t, ['orders:read']);
    expect((await nobody.post(`/admin/notification-templates/${id}/preview`)).body.code).toBe('FORBIDDEN');
    const reader = await adminWith(t, ['notifications:read']);
    expect((await reader.post(`/admin/notification-templates/${id}/preview`)).status).toBe(200);
  });
});
