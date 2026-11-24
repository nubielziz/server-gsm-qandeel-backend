// Integration tests of the notification template routes (feature 12a, stage 12): list with filters, search and the 30-day count, one template,
// create, change, delete and the preview, with the audit entries and the refusals of RULES settings 10. Real Postgres and Redis through HTTP.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { schema as s } from '@src/infra/db';
import { DEFAULT_TEMPLATES } from '@src/modules/platform';
import { type AdminApi, adminWith } from '../../support/admin-api';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches } from '../../support/auth';
import { DAY, TestClock } from '../../support/clock';
import { closeTestDb, pgErrorOf, resetDb, testDb } from '../../support/db';
import { seedIdentityTemplates } from '../../support/identity-mail';
import { mailbox, seedDefaultTemplates, telegramOutbox } from '../../support/notifications';

const clock = new TestClock('2026-11-01T10:00:00.000Z');
let t: TestApp;
let owner: AdminApi;

beforeAll(async () => {
  t = await createTestApp({
    clock,
    env: { TELEGRAM_BOT_TOKEN: '1234567890:AAtest-token' },
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
  channel: 'email' as const,
  audience: 'customer' as const,
  subject: 'Re: your question',
  body: 'Hi {{customerName}}, we looked into it.',
  isActive: true,
};

async function audit() {
  const { db } = await testDb();
  return db.select().from(s.auditLogs).orderBy(s.auditLogs.id);
}

async function idOf(event: string, channel: 'email' | 'telegram', audience = 'merchant') {
  const { db } = await testDb();
  const rows = await db.select().from(s.notificationTemplates);
  return rows.find((row) => row.event === event && row.channel === channel && row.audience === audience)!.id;
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
      subject: 'Confirm your email address',
      body: expect.stringContaining('{{customerName}}'),
      isActive: true,
      sentLast30Days: 0,
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    });
  });

  it('filters by audience, channel, switch and event, searches the event and the subject, and pages', async () => {
    const { db } = await testDb();
    await db.insert(s.notificationTemplates).values({
      event: 'support.reply',
      channel: 'email',
      audience: 'customer',
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
    expect(await total('event=wallet.low_balance')).toBe(1);
    expect(await total('q=ZEBRA')).toBe(1);
    expect(await total('q=low_balance')).toBe(1);
    const page = await owner.get('/admin/notification-templates?_sort=id&_order=desc&_start=1&_end=3');
    expect(page.body).toHaveLength(2);
    expect(page.total).toBe(DEFAULT_TEMPLATES.length + 1);
    expect(page.body[0].id).toBeGreaterThan(page.body[1].id);
    expect((await owner.get('/admin/notification-templates?audience=robot')).status).toBe(422);
    // Templates have no language (decision 039): `locale` is an unknown key of this strict list, so it is refused, not ignored.
    const language = await owner.get('/admin/notification-templates?locale=en');
    expect(language.status).toBe(422);
    expect(language.body.code).toBe('VALIDATION_FAILED');
  });

  it('counts the messages sent in the last 30 days per event, channel and kind of recipient', async () => {
    const { db } = await testDb();
    const sent = (days: number) => new Date(clock.nowMs() - days * DAY);
    // The one event that still has both channels is the operations alert (its messages go to the ops mailbox and chat, recipient 0).
    const base = { recipientType: 'staff' as const, recipientId: 0, event: 'alert.fired', payload: {} };
    await db.insert(s.notifications).values([
      { ...base, channel: 'email', status: 'sent', sentAt: sent(1) },
      { ...base, channel: 'email', status: 'sent', sentAt: sent(29) },
      { ...base, channel: 'email', status: 'sent', sentAt: sent(31) },
      { ...base, channel: 'email', status: 'failed', error: 'no' },
      { ...base, channel: 'email', status: 'queued' },
      { ...base, channel: 'telegram', status: 'sent', sentAt: sent(2) },
      { ...base, recipientType: 'customer', channel: 'email', status: 'sent', sentAt: sent(2) },
    ]);
    const rows = (await owner.get('/admin/notification-templates?event=alert.fired')).body;
    expect(rows).toHaveLength(2);
    const countOf = (channel: string) =>
      rows.find((row: { channel: string }) => row.channel === channel).sentLast30Days;
    expect(countOf('email')).toBe(2);
    expect(countOf('telegram')).toBe(1);
    const one = await owner.get(`/admin/notification-templates/${await idOf('alert.fired', 'email', 'staff')}`);
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
    const res = await owner.post('/admin/notification-templates', { ...customerSupportReply, isActive: undefined });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ ...customerSupportReply, sentLast30Days: 0 });
    expect(res.body).not.toHaveProperty('locale');
    const entries = await audit();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      action: 'created notification template',
      entityType: 'notification_template',
      entityId: res.body.id,
      entityLabel: 'support.reply (email, customer)',
      actorName: 'Rami K.',
      before: null,
      after: { event: 'support.reply', channel: 'email', audience: 'customer', isActive: true },
    });
    expect(entries[0]!.after).not.toHaveProperty('locale');
  });

  it('keeps a Telegram template without a subject, whatever was sent', async () => {
    // The Telegram message of the alert ships as a default: take it away, so this one is the first.
    const { db } = await testDb();
    await db
      .delete(s.notificationTemplates)
      .where(eq(s.notificationTemplates.id, await idOf('alert.fired', 'telegram', 'staff')));
    const res = await owner.post('/admin/notification-templates', {
      event: 'alert.fired',
      channel: 'telegram',
      audience: 'staff',
      subject: 'ignored',
      body: 'ALERT {{ruleName}} on {{subject}}.',
    });
    expect(res.status).toBe(201);
    expect(res.body.subject).toBe('');
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

  it('refuses a template for an event that a campaign writes itself (feature 23), with 422 on event', async () => {
    const res = await owner.post('/admin/notification-templates', {
      ...customerSupportReply,
      event: 'broadcast.announcement',
      body: 'Hello {{customerName}}',
    });
    expect(res.status).toBe(422);
    expect(fieldsOf(res.body)).toEqual(['event']);
    expect(res.body.errors[0].code).toBe('not_templated');
    expect(res.body.errors[0].message).toBe('Announcements are written per campaign, not as a template.');
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
    // A merchant has email only (decision 062): the events that were on Telegram once are refused on that channel.
    const merchant = await owner.post('/admin/notification-templates', {
      event: 'wallet.low_balance',
      channel: 'telegram',
      audience: 'merchant',
      subject: '',
      body: 'Low balance: {{available}} {{currency}}.',
    });
    expect(fieldsOf(merchant.body)).toEqual(['channel']);
    expect(merchant.body.errors[0].code).toBe('not_for_channel');
  });

  it('refuses a second template for the same event, channel and audience with 422 on event, also in parallel', async () => {
    expect((await owner.post('/admin/notification-templates', customerSupportReply)).status).toBe(201);
    const again = await owner.post('/admin/notification-templates', customerSupportReply);
    expect(again.status).toBe(422);
    expect(again.body.errors[0]).toMatchObject({
      field: 'event',
      code: 'duplicate',
      message: 'A template for this event, channel and audience already exists.',
    });
    // A language sent along is not part of the key any more (decision 039): it is dropped, and the template is still the duplicate.
    const tr = await owner.post('/admin/notification-templates', { ...customerSupportReply, locale: 'tr' });
    expect(tr.status).toBe(422);
    expect(tr.body.errors[0]).toMatchObject({ field: 'event', code: 'duplicate' });
    // The same event for another audience is another template.
    expect(
      (
        await owner.post('/admin/notification-templates', {
          ...customerSupportReply,
          audience: 'merchant',
          body: 'Hi {{merchantName}}, we looked into it.',
        })
      ).status,
    ).toBe(201);
    // The unique key of the table says the same, whatever the route checks first.
    const { db } = await testDb();
    expect(
      await pgErrorOf(db.insert(s.notificationTemplates).values({ ...customerSupportReply, subject: 'Twin' })),
    ).toMatchObject({ code: '23505', constraint: 'notification_templates_event_uq' });

    // The race starts from a clean slate: the two templates made above are removed, then four calls create the same one.
    await db.delete(s.notificationTemplates).where(eq(s.notificationTemplates.event, 'support.reply'));
    const answers = await Promise.all(
      Array.from({ length: 4 }, () => owner.post('/admin/notification-templates', customerSupportReply)),
    );
    expect(answers.filter((answer) => answer.status === 201)).toHaveLength(1);
    expect(answers.filter((answer) => answer.status === 422)).toHaveLength(3);
  });

  it('refuses an email without a subject, an empty message and a placeholder the event does not offer', async () => {
    const post = (patch: Record<string, unknown>) =>
      owner.post('/admin/notification-templates', { ...customerSupportReply, ...patch });
    expect(fieldsOf((await post({ subject: '  ' })).body)).toEqual(['subject']);
    expect(fieldsOf((await post({ body: '   ' })).body)).toEqual(['body']);
    const typo = await post({ body: 'Hi {{custmerName}}, order {{orderId}}' });
    expect(fieldsOf(typo.body)).toEqual(['body']);
    expect(typo.body.errors[0].message).toContain('{{custmerName}}');
    expect(typo.body.errors[0].message).toContain('{{customerName}}');
    // `support.reply` offers `{{link}}` (feature 17), so this one asks an event that has none (its texts are checked before the duplicate).
    expect(fieldsOf((await post({ event: 'order.completed', subject: 'Hello {{link}}' })).body)).toEqual(['subject']);
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
      entityLabel: 'wallet.low_balance (email, merchant)',
      before: { subject: 'Your wallet balance is low' },
      after: { subject: 'Top up soon' },
    });
  });

  it('turns a template off and on with the demo verb phrases, and audits a request that changes nothing too', async () => {
    const id = await idOf('alert.resolved', 'telegram', 'staff');
    expect((await owner.patch(`/admin/notification-templates/${id}`, { isActive: false })).body.isActive).toBe(false);
    expect((await owner.patch(`/admin/notification-templates/${id}`, { isActive: true })).body.isActive).toBe(true);
    expect((await owner.patch(`/admin/notification-templates/${id}`, { isActive: true })).status).toBe(200);
    expect((await audit()).map((entry) => entry.action)).toEqual([
      'turned off notification',
      'turned on notification',
      'turned on notification',
    ]);
  });

  it('fixes event, channel and audience after create: another value is 422 on that field, the same value is fine', async () => {
    const id = await idOf('wallet.low_balance', 'email');
    const res = await owner.patch(`/admin/notification-templates/${id}`, {
      event: 'invoice.paid',
      channel: 'telegram',
      audience: 'staff',
    });
    expect(res.status).toBe(422);
    expect(fieldsOf(res.body)).toEqual(['event', 'channel', 'audience']);
    expect(res.body.errors[0].code).toBe('immutable');
    const same = await owner.patch(`/admin/notification-templates/${id}`, {
      event: 'wallet.low_balance',
      channel: 'email',
      audience: 'merchant',
      // A language sent along is dropped (templates have no language): it is no change and no error.
      locale: 'tr',
      isActive: false,
    });
    expect(same.status).toBe(200);
    expect(same.body).not.toHaveProperty('locale');
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
    const id = await idOf('invoice.paid', 'email');
    const reader = await adminWith(t, ['notifications:read']);
    expect((await reader.patch(`/admin/notification-templates/${id}`, { isActive: false })).body.code).toBe(
      'FORBIDDEN',
    );
  });
});

describe('DELETE /admin/notification-templates/:id', () => {
  it('deletes the template and audits what it held', async () => {
    const id = await idOf('invoice.paid', 'email');
    const res = await owner.delete(`/admin/notification-templates/${id}`);
    expect(res.status).toBe(204);
    expect((await owner.get(`/admin/notification-templates/${id}`)).status).toBe(404);
    const [entry] = await audit();
    expect(entry).toMatchObject({
      action: 'deleted notification template',
      entityLabel: 'invoice.paid (email, merchant)',
      before: { event: 'invoice.paid', channel: 'email', body: expect.stringContaining('Invoice') },
      after: null,
    });
    expect((await owner.delete(`/admin/notification-templates/${id}`)).body.code).toBe('NOT_FOUND');
    // Another template that still exists: the reader is refused for want of the permission, not for a missing row.
    const reader = await adminWith(t, ['notifications:read']);
    expect(
      (await reader.delete(`/admin/notification-templates/${await idOf('order.completed', 'email')}`)).body.code,
    ).toBe('FORBIDDEN');
  });
});

describe('the emails that carry a one-time link or protect accounts (decision 047)', () => {
  const rowOf = async (id: number) => {
    const { db } = await testDb();
    return (await db.select().from(s.notificationTemplates).where(eq(s.notificationTemplates.id, id)))[0]!;
  };

  it('refuses a link template that puts the link anywhere but its own place, and changes nothing', async () => {
    const id = await idOf('merchant.password_reset', 'email');
    const before = await rowOf(id);
    const codes = async (payload: Record<string, string>) => {
      const res = await owner.patch(`/admin/notification-templates/${id}`, payload);
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('VALIDATION_FAILED');
      return res.body.errors.map((error: { field: string; code: string }) => `${error.field}:${error.code}`);
    };
    expect(await codes({ body: '<img src="https://example.com/x?{{link}}">' })).toContain('body:link_tag');
    expect(await codes({ body: 'Reset: example.com/{{link}}' })).toEqual(['body:link_placement']);
    expect(await codes({ subject: 'Reset {{link}}' })).toEqual(['subject:link_in_subject']);
    expect(await codes({ body: '<a href="https://example.com">Reset</a> {{link}}' })).toContain('body:link_href');
    expect(await codes({ body: 'Visit https://example.com or {{link}}' })).toContain('body:link_url');
    expect(await rowOf(id)).toEqual(before);
    expect((await audit()).length).toBe(0);
    // The usual shapes pass: its own line, or the whole href of one link with a text.
    const ok = await owner.patch(`/admin/notification-templates/${id}`, {
      body: '<p>Hi {{merchantName}}</p><p><a href="{{link}}" class="button">Choose a password</a></p><p>It stops working at {{expiresAt}}.</p>',
    });
    expect(ok.status).toBe(200);
  });

  it('checks a link template on create too, and leaves the ticket and other mails that carry no credential alone', async () => {
    const { db } = await testDb();
    // The only template of its event (no migration ships one): the first is created through the route, and it is checked.
    const created = await owner.post('/admin/notification-templates', {
      ...customerSupportReply,
      event: 'support.ticket_received',
      subject: 'We got {{ticketNumber}}',
      body: 'Follow it here: x{{link}}',
    });
    expect(created.status).toBe(422);
    expect(created.body.errors.map((error: { code: string }) => error.code)).toContain('link_placement');
    await db.delete(s.notificationTemplates).where(eq(s.notificationTemplates.event, 'invoice.paid'));
    const plain = await owner.post('/admin/notification-templates', {
      event: 'invoice.paid',
      channel: 'email',
      audience: 'merchant',
      subject: 'Paid {{invoiceNumber}}',
      body: 'See https://example.com for {{invoiceNumber}} {{amount}} {{currency}} {{merchantName}}',
    });
    expect(plain.status).toBe(201);
  });

  it('keeps {{link}} in a security mail and {{change}} in a security notice', async () => {
    const { db } = await testDb();
    await seedIdentityTemplates(db);
    const reset = await idOf('merchant.password_reset', 'email');
    const noLink = await owner.patch(`/admin/notification-templates/${reset}`, {
      body: 'Hi {{merchantName}}, we will mail you again.',
    });
    expect(noLink.status).toBe(422);
    expect(noLink.body.errors).toContainEqual({
      field: 'body',
      code: 'security_placeholder',
      message: 'This email protects accounts: keep {{link}} in the message.',
    });
    const notice = await idOf('merchant.security_notice', 'email');
    const before = await rowOf(notice);
    const noChange = await owner.patch(`/admin/notification-templates/${notice}`, {
      body: 'Hi {{merchantName}}, something changed.',
    });
    expect(noChange.status).toBe(422);
    expect(noChange.body.errors).toContainEqual({
      field: 'body',
      code: 'security_placeholder',
      message: 'This email protects accounts: keep {{change}} in the message, it says what changed.',
    });
    expect(await rowOf(notice)).toEqual(before);
    expect(
      (
        await owner.patch(`/admin/notification-templates/${notice}`, {
          body: 'Hi {{merchantName}}, our team changed this: {{change}}.',
        })
      ).status,
    ).toBe(200);
  });

  it('refuses a security notice whose text could hide what it says, and a security email with a style, and changes nothing', async () => {
    const { db } = await testDb();
    await seedIdentityTemplates(db);
    const notice = await idOf('merchant.security_notice', 'email');
    const reset = await idOf('merchant.password_reset', 'email');
    const before = [await rowOf(notice), await rowOf(reset)];
    const codes = async (id: number, body: string) => {
      const res = await owner.patch(`/admin/notification-templates/${id}`, { body });
      expect(res.status, body).toBe(422);
      expect(res.body.code).toBe('VALIDATION_FAILED');
      return res.body.errors.map((error: { field: string; code: string }) => `${error.field}:${error.code}`);
    };
    expect(await codes(notice, '<p style="display:none">{{change}}</p>')).toEqual(['body:link_attribute']);
    expect(await codes(notice, '<p hidden>{{change}}</p>')).toEqual(['body:link_attribute']);
    expect(await codes(notice, 'Hi {{merchantName}}<!-- {{change}} -->')).toEqual(['body:link_markup']);
    expect(await codes(notice, '<img src="x"><p>{{change}}</p>')).toEqual(['body:link_tag']);
    // The notice is in the body, but only inside a tag: the reader would not see it.
    const hiddenChange = await owner.patch(`/admin/notification-templates/${notice}`, {
      body: '<p title="{{change}}">Hi {{merchantName}}, something changed.</p>',
    });
    expect(hiddenChange.status).toBe(422);
    expect(hiddenChange.body.errors).toContainEqual({
      field: 'body',
      code: 'security_placeholder',
      message:
        'This email protects accounts: {{change}} must stand in the text of the message, not inside a comment or a tag.',
    });
    expect(await codes(reset, '<p style="color:#06c"><a href="{{link}}">Choose a password</a></p>')).toEqual([
      'body:link_attribute',
    ]);
    expect([await rowOf(notice), await rowOf(reset)]).toEqual(before);
    expect((await audit()).length).toBe(0);
    // Text that shows the notice passes, with formatting.
    const ok = await owner.patch(`/admin/notification-templates/${notice}`, {
      body: '<p>Hi {{merchantName}}</p><p><strong>{{change}}</strong></p>',
    });
    expect(ok.status).toBe(200);
  });

  it('cannot switch off or delete an email that protects accounts, and still switches off and deletes an ordinary template', async () => {
    const { db } = await testDb();
    await seedIdentityTemplates(db);
    const reset = await idOf('merchant.password_reset', 'email');
    const before = await rowOf(reset);
    const off = await owner.patch(`/admin/notification-templates/${reset}`, { isActive: false });
    expect(off.status).toBe(409);
    expect(off.body).toMatchObject({
      code: 'LOCKED',
      detail:
        'This email protects accounts (a sign-in, password, invitation or verification link, or a security notice), so it cannot be switched off. You can change its words.',
    });
    const removed = await owner.delete(`/admin/notification-templates/${reset}`);
    expect(removed.status).toBe(409);
    expect(removed.body.code).toBe('LOCKED');
    expect(removed.body.detail).toContain('cannot be deleted');
    expect(await rowOf(reset)).toEqual(before);
    expect((await audit()).length).toBe(0);
    // A customer account mail and a staff link mail are locked the same way.
    for (const [event, audience] of [
      ['customer.magic_link', 'customer'],
      ['staff.invited', 'staff'],
      ['merchant.security_notice', 'merchant'],
    ] as const) {
      const id = await idOf(event, 'email', audience);
      expect((await owner.patch(`/admin/notification-templates/${id}`, { isActive: false })).status, event).toBe(409);
      expect((await owner.delete(`/admin/notification-templates/${id}`)).status, event).toBe(409);
    }
    // A row deleted in the database before: creating it switched off is refused too; creating it on works.
    await db.delete(s.notificationTemplates).where(eq(s.notificationTemplates.event, 'staff.invited'));
    const staffInvited = {
      event: 'staff.invited',
      channel: 'email' as const,
      audience: 'staff' as const,
      subject: 'Welcome',
      body: 'Choose your password:\n\n{{link}}',
    };
    expect((await owner.post('/admin/notification-templates', { ...staffInvited, isActive: false })).status).toBe(409);
    expect((await owner.post('/admin/notification-templates', staffInvited)).status).toBe(201);
    // An ordinary template switches off and is deleted as before.
    const invoicePaid = await idOf('invoice.paid', 'email');
    expect((await owner.patch(`/admin/notification-templates/${invoicePaid}`, { isActive: false })).status).toBe(200);
    expect((await owner.delete(`/admin/notification-templates/${invoicePaid}`)).status).toBe(204);
    // A security email that was switched off before this rule can only be switched on, with its words changed.
    await db.update(s.notificationTemplates).set({ isActive: false }).where(eq(s.notificationTemplates.id, reset));
    expect((await owner.patch(`/admin/notification-templates/${reset}`, { isActive: true })).body.isActive).toBe(true);
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
      from: 'IMEI-HUB <noreply@gsm.local>',
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
    const id = await idOf('alert.fired', 'telegram', 'staff');
    const res = await owner.post(`/admin/notification-templates/${id}/preview`);
    expect(res.body).toMatchObject({
      subject: '',
      body: 'ALERT critical: Supplier timeouts on Supplier Bosphorus Unlock. supplier.timeout_rate is 25% (limit 20%). The limit is above 20% over 3 min.',
      format: 'text',
      from: 'Telegram bot',
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
