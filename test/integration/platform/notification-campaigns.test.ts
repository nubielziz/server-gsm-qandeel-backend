// Integration tests of the campaign routes (feature 23, plan section 10.2, routes 1-5, 7, 8, 10, 11): create, list, read, edit, delete,
// render preview, test send, schedule and cancel; each refusal with its status, code and field; the broadcasts permissions (a role
// with `notifications:*` is refused); the audit rows; and the refusal of a template for an announcement event.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { schema as s } from '@src/infra/db';
import { type AdminApi, adminWith } from '../../support/admin-api';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches, insertMerchant } from '../../support/auth';
import { CAMPAIGN_INPUT, campaignAudit, campaignRow, createDraft, insertCustomer } from '../../support/campaigns';
import { DAY, MINUTE, TestClock } from '../../support/clock';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { mailbox } from '../../support/notifications';

const clock = new TestClock('2026-11-10T09:00:00.000Z');
let t: TestApp;
let owner: AdminApi;

const fieldsOf = (body: { errors?: Array<{ field: string }> }) => (body.errors ?? []).map((error) => error.field);
const at = (ms: number) => new Date(clock.nowMs() + ms).toISOString();

beforeAll(async () => {
  t = await createTestApp({ clock });
});
beforeEach(async () => {
  clock.set('2026-11-10T09:00:00.000Z');
  await resetDb();
  await clearIdentityCaches(t);
  mailbox(t).reset();
  owner = await adminWith(t, ['*'], { name: 'Rami K.' });
  const { db } = await testDb();
  await insertMerchant(db);
  await insertCustomer(db);
});
afterAll(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await t.close();
  await closeTestDb();
});

describe('POST /admin/notification-campaigns', () => {
  it('creates a draft with its author and writes the audit row', async () => {
    const res = await owner.post('/admin/notification-campaigns', CAMPAIGN_INPUT);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      name: CAMPAIGN_INPUT.name,
      purpose: 'service',
      channels: ['in_app', 'email'],
      status: 'draft',
      audience: CAMPAIGN_INPUT.audience,
      content: CAMPAIGN_INPUT.content,
      link: CAMPAIGN_INPUT.link,
      expectedRecipients: null,
      recipients: 0,
      createdBy: { id: owner.staffId, name: 'Rami K.' },
      updatedBy: null,
      delivery: { inApp: { delivered: 0, read: 0 }, email: { queued: 0, sent: 0, failed: 0 } },
    });
    const { db } = await testDb();
    const audit = await campaignAudit(db, res.body.id);
    expect(audit.map((row) => row.action)).toEqual(['created notification campaign']);
    expect(audit[0]).toMatchObject({ actorType: 'staff', actorId: owner.staffId, entityLabel: CAMPAIGN_INPUT.name });
  });

  it('refuses HTML, an unknown placeholder, a blank text, a link that leaves the site and an empty audience, by field', async () => {
    const res = await owner.post('/admin/notification-campaigns', {
      ...CAMPAIGN_INPUT,
      content: { title: '  ', body: '<b>Hi</b> {{orderId}}' },
      link: { customer: 'https://evil.example/x', merchant: '//evil.example' },
      audience: {},
    });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('VALIDATION_FAILED');
    expect(fieldsOf(res.body).sort()).toEqual(
      ['audience', 'content.body', 'content.body', 'content.title', 'link.customer', 'link.merchant'].sort(),
    );
  });

  it('refuses the retired Telegram channel, a person listed twice and unknown keys of the audience', async () => {
    // A campaign has two channels (in the app, by email): a merchant audience does not bring a third back (decision 062).
    for (const audience of [{ customers: {} }, { merchants: {} }]) {
      const telegram = await owner.post('/admin/notification-campaigns', {
        ...CAMPAIGN_INPUT,
        channels: ['telegram'],
        audience,
      });
      expect(telegram.status).toBe(422);
      expect(fieldsOf(telegram.body)[0]).toMatch(/^channels/);
    }
    const twice = await owner.post('/admin/notification-campaigns', {
      ...CAMPAIGN_INPUT,
      audience: {
        include: [
          { type: 'customer', id: 1 },
          { type: 'customer', id: 1 },
        ],
      },
    });
    expect(fieldsOf(twice.body)).toEqual(['audience.include']);
    const unknown = await owner.post('/admin/notification-campaigns', {
      ...CAMPAIGN_INPUT,
      audience: { everyone: true },
    });
    expect(unknown.status).toBe(422);
  });

  it('needs the CSRF token', async () => {
    const res = await owner.withoutCsrf('POST', '/admin/notification-campaigns', CAMPAIGN_INPUT);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('CSRF_FAILED');
  });
});

describe('the broadcasts permissions', () => {
  it('refuses every campaign route to a role that has notifications:* but no broadcasts permission', async () => {
    const id = (await createDraft(owner)).id;
    const notifications = await adminWith(t, ['notifications:*']);
    const calls: Array<[string, string, unknown?]> = [
      ['GET', '/admin/notification-campaigns'],
      ['POST', '/admin/notification-campaigns', CAMPAIGN_INPUT],
      ['GET', `/admin/notification-campaigns/${id}`],
      ['PATCH', `/admin/notification-campaigns/${id}`, { name: 'x' }],
      ['DELETE', `/admin/notification-campaigns/${id}`],
      [
        'POST',
        '/admin/notification-campaigns/audience-preview',
        { audience: { staff: {} }, channels: ['in_app'], purpose: 'service' },
      ],
      ['POST', `/admin/notification-campaigns/${id}/preview`, { channel: 'email' }],
      ['POST', `/admin/notification-campaigns/${id}/test`, {}],
      ['POST', `/admin/notification-campaigns/${id}/send`, { confirmRecipients: 1 }],
      ['POST', `/admin/notification-campaigns/${id}/schedule`, { scheduledAt: at(DAY) }],
      ['POST', `/admin/notification-campaigns/${id}/cancel`],
      ['GET', `/admin/notification-campaigns/${id}/recipients?channel=email`],
    ];
    for (const [method, url, body] of calls) {
      const res = await notifications.call(method as never, url, body);
      expect(res.status, `${method} ${url}`).toBe(403);
    }
  });

  it('lets broadcasts:read read and count but not write', async () => {
    const id = (await createDraft(owner)).id;
    const reader = await adminWith(t, ['broadcasts:read']);
    expect((await reader.get('/admin/notification-campaigns')).status).toBe(200);
    expect((await reader.get(`/admin/notification-campaigns/${id}`)).status).toBe(200);
    expect((await reader.post(`/admin/notification-campaigns/${id}/preview`, { channel: 'email' })).status).toBe(200);
    expect((await reader.patch(`/admin/notification-campaigns/${id}`, { name: 'x' })).status).toBe(403);
    expect((await reader.post(`/admin/notification-campaigns/${id}/cancel`)).status).toBe(403);
  });
});

describe('GET /admin/notification-campaigns', () => {
  it('lists newest first with the author and the exact total, filters, sorts, searches and pages', async () => {
    const other = await adminWith(t, ['*'], { name: 'Lina' });
    const first = await createDraft(owner, { name: 'Ramadan offer', purpose: 'marketing' });
    clock.advance(MINUTE);
    const second = await createDraft(other, { name: 'New unlock services' });
    clock.advance(MINUTE);
    const third = await createDraft(owner, { name: 'Maintenance' });
    await owner.post(`/admin/notification-campaigns/${third.id}/schedule`, { scheduledAt: at(DAY) });

    const all = await owner.get('/admin/notification-campaigns');
    expect(all.status).toBe(200);
    expect(all.total).toBe(3);
    expect(all.body.map((row: { id: number }) => row.id)).toEqual([third.id, second.id, first.id]);
    expect(all.body[1]).toMatchObject({ createdBy: { id: other.staffId, name: 'Lina' }, planned: { inApp: 0 } });
    expect(all.body[0].delivery).toBeUndefined();

    const scheduled = await owner.get('/admin/notification-campaigns?status=scheduled');
    expect(scheduled.body.map((row: { id: number }) => row.id)).toEqual([third.id]);
    const notScheduled = await owner.get('/admin/notification-campaigns?status_ne=scheduled');
    expect(notScheduled.total).toBe(2);
    const marketing = await owner.get('/admin/notification-campaigns?purpose=marketing');
    expect(marketing.body.map((row: { id: number }) => row.id)).toEqual([first.id]);
    const byAuthor = await owner.get(`/admin/notification-campaigns?createdBy=${other.staffId}`);
    expect(byAuthor.body.map((row: { id: number }) => row.id)).toEqual([second.id]);
    const search = await owner.get('/admin/notification-campaigns?q=unlock');
    expect(search.body.map((row: { id: number }) => row.id)).toEqual([second.id]);
    const asc = await owner.get('/admin/notification-campaigns?_sort=id&_order=asc&_start=1&_end=3');
    expect(asc.total).toBe(3);
    expect(asc.body.map((row: { id: number }) => row.id)).toEqual([second.id, third.id]);
  });

  it('refuses an unknown filter value', async () => {
    const res = await owner.get('/admin/notification-campaigns?status=nope');
    expect(res.status).toBe(422);
  });
});

describe('GET /admin/notification-campaigns/:id', () => {
  it('answers 404 for an unknown id', async () => {
    const res = await owner.get('/admin/notification-campaigns/999999');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });

  it('shows a finished campaign whose stored audience has no segment left, and refuses a copy of it until staff choose one', async () => {
    // What migration 0035 leaves of a campaign that was for another language only: the same row with no `customers` segment
    // (decision 039, plan 4.6). A segment that is present with no filter would mean every customer, so the key is gone instead.
    const finished = await createDraft(owner);
    const { db } = await testDb();
    await db
      .update(s.notificationCampaigns)
      .set({ status: 'sent', audience: {} })
      .where(eq(s.notificationCampaigns.id, finished.id));
    const detail = await owner.get(`/admin/notification-campaigns/${finished.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body).toMatchObject({ status: 'sent', audience: {} });

    // The console's Duplicate sends the stored audience as it is: it reaches nobody, so the copy is refused as `empty`.
    const copy = await owner.post('/admin/notification-campaigns', {
      ...CAMPAIGN_INPUT,
      name: 'Copy',
      audience: detail.body.audience,
    });
    expect(copy.status).toBe(422);
    expect(copy.body.errors[0]).toMatchObject({ field: 'audience', code: 'empty' });

    // A draft the migration left in this state is refused at send, and staff can choose an audience again.
    const draft = await createDraft(owner);
    await db.update(s.notificationCampaigns).set({ audience: {} }).where(eq(s.notificationCampaigns.id, draft.id));
    const send = await owner.post(`/admin/notification-campaigns/${draft.id}/send`, { confirmRecipients: 1 });
    expect(send.status).toBe(422);
    expect(send.body.errors[0]).toMatchObject({ field: 'audience', code: 'empty' });
    const chosen = await owner.patch(`/admin/notification-campaigns/${draft.id}`, {
      audience: { customers: { hasAccount: true } },
    });
    expect(chosen.status).toBe(200);
    expect(chosen.body.audience).toEqual({ customers: { hasAccount: true } });
  });
});

describe('PATCH /admin/notification-campaigns/:id', () => {
  it('edits a draft, validates the merged campaign and audits only what changed', async () => {
    const draft = await createDraft(owner);
    const res = await owner.patch(`/admin/notification-campaigns/${draft.id}`, { name: 'Friday maintenance' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ name: 'Friday maintenance', updatedBy: { id: owner.staffId } });
    const { db } = await testDb();
    const [, edited] = await campaignAudit(db, draft.id);
    expect(edited).toMatchObject({
      action: 'edited notification campaign',
      before: { name: CAMPAIGN_INPUT.name },
      after: { name: 'Friday maintenance' },
    });

    const telegram = await owner.patch(`/admin/notification-campaigns/${draft.id}`, {
      channels: ['telegram'],
      audience: { merchants: {} },
    });
    expect(telegram.status).toBe(422);
    expect(fieldsOf(telegram.body)[0]).toMatch(/^channels/);
  });

  it('refuses an edit of a draft stored with the retired channel only until the edit names a channel', async () => {
    const draft = await createDraft(owner);
    const { db } = await testDb();
    await db
      .update(s.notificationCampaigns)
      .set({ channels: ['telegram'] })
      .where(eq(s.notificationCampaigns.id, draft.id));
    // The route shows no channel for it, and a rename alone cannot save: the merged campaign would reach nobody.
    expect((await owner.get(`/admin/notification-campaigns/${draft.id}`)).body.channels).toEqual([]);
    const rename = await owner.patch(`/admin/notification-campaigns/${draft.id}`, { name: 'Friday maintenance' });
    expect(rename.status).toBe(422);
    expect(fieldsOf(rename.body)).toEqual(['channels']);
    const chosen = await owner.patch(`/admin/notification-campaigns/${draft.id}`, { channels: ['email'] });
    expect(chosen.status).toBe(200);
    expect(chosen.body.channels).toEqual(['email']);
  });

  it('keeps the time of a scheduled campaign, and refuses a campaign that is no longer a draft or scheduled', async () => {
    const draft = await createDraft(owner);
    await owner.post(`/admin/notification-campaigns/${draft.id}/schedule`, { scheduledAt: at(DAY) });
    const res = await owner.patch(`/admin/notification-campaigns/${draft.id}`, { name: 'Later' });
    expect(res.body).toMatchObject({ status: 'scheduled', scheduledAt: at(DAY) });
    await owner.post(`/admin/notification-campaigns/${draft.id}/cancel`);
    const refused = await owner.patch(`/admin/notification-campaigns/${draft.id}`, { name: 'Again' });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('INVALID_TRANSITION');
    expect((await owner.patch('/admin/notification-campaigns/999999', { name: 'x' })).status).toBe(404);
  });

  it('refuses an empty body', async () => {
    const draft = await createDraft(owner);
    expect((await owner.patch(`/admin/notification-campaigns/${draft.id}`, {})).status).toBe(422);
  });
});

describe('DELETE /admin/notification-campaigns/:id', () => {
  it('deletes a draft with an audit row, refuses any other status with NOT_A_DRAFT and an unknown id with 404', async () => {
    const draft = await createDraft(owner);
    const res = await owner.delete(`/admin/notification-campaigns/${draft.id}`);
    expect(res.status).toBe(204);
    const { db } = await testDb();
    expect(await db.select().from(s.notificationCampaigns)).toHaveLength(0);
    expect((await campaignAudit(db, draft.id)).map((row) => row.action)).toEqual([
      'created notification campaign',
      'deleted notification campaign',
    ]);

    const scheduled = await createDraft(owner);
    await owner.post(`/admin/notification-campaigns/${scheduled.id}/schedule`, { scheduledAt: at(DAY) });
    const refused = await owner.delete(`/admin/notification-campaigns/${scheduled.id}`);
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('NOT_A_DRAFT');
    expect((await owner.delete(`/admin/notification-campaigns/${draft.id}`)).status).toBe(404);
  });
});

describe('POST /admin/notification-campaigns/:id/preview', () => {
  it('renders an email with a sample name and the link of the audience, and writes nothing', async () => {
    const draft = await createDraft(owner);
    const { db } = await testDb();
    const before = (await db.select().from(s.auditLogs)).length;
    const res = await owner.post(`/admin/notification-campaigns/${draft.id}/preview`, {
      channel: 'email',
      audience: 'customer',
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      subject: 'Maintenance for Daniel',
      format: 'html',
      note: 'A sample with made-up details.',
    });
    expect(res.body.body).toStartWith('<div dir="ltr" lang="en"');
    expect(res.body.body).toContain('/account/orders');
    expect((await db.select().from(s.auditLogs)).length).toBe(before);
  });

  it('renders the in-app message as text, uses the caller name for staff, and refuses a retired channel and a language sent along', async () => {
    const draft = await createDraft(owner);
    const inApp = await owner.post(`/admin/notification-campaigns/${draft.id}/preview`, { channel: 'in_app' });
    expect(inApp.body).toMatchObject({ subject: 'Maintenance for Daniel', format: 'text' });
    const staff = await owner.post(`/admin/notification-campaigns/${draft.id}/preview`, {
      channel: 'in_app',
      audience: 'staff',
    });
    expect(staff.body).toMatchObject({ subject: 'Maintenance for Rami K.', format: 'text' });
    expect(
      (await owner.post(`/admin/notification-campaigns/${draft.id}/preview`, { channel: 'telegram' })).status,
    ).toBe(422);
    expect((await owner.post('/admin/notification-campaigns/999999/preview', { channel: 'email' })).status).toBe(404);
    // A language is no part of the request any more (decision 039): the strict body refuses `locale` like any unknown key.
    for (const url of ['preview', 'test']) {
      const refused = await owner.post(`/admin/notification-campaigns/${draft.id}/${url}`, {
        locale: 'tr',
        channel: 'in_app',
        channels: ['in_app'],
      });
      expect(refused.status, url).toBe(422);
    }
    expect((await owner.post(`/admin/notification-campaigns/${draft.id}/preview`, { channel: 'sms' })).status).toBe(
      422,
    );
  });
});

describe('POST /admin/notification-campaigns/:id/test', () => {
  it('makes an in-app item and one transactional email for the caller only, with an audit row', async () => {
    const draft = await createDraft(owner);
    const res = await owner.post(`/admin/notification-campaigns/${draft.id}/test`, {});
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ queued: ['in_app', 'email'] });
    const { db } = await testDb();
    const items = await db.select().from(s.notificationInbox);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      recipientType: 'staff',
      recipientId: owner.staffId,
      event: 'broadcast.test',
      campaignId: null,
      variables: { title: 'Maintenance for Rami K.', body: 'The portal is read-only on Friday.' },
    });
    const rows = await db.select().from(s.notifications);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      event: 'broadcast.test',
      recipientType: 'staff',
      channel: 'email',
      campaignId: null,
    });
    const events = await db.select().from(s.outboxEvents).where(eq(s.outboxEvents.type, 'notification.send'));
    expect(events).toHaveLength(1);
    expect((await campaignAudit(db, draft.id)).at(-1)).toMatchObject({
      action: 'sent test notification',
      after: { channels: ['in_app', 'email'] },
    });
    // Nothing of the campaign itself moved.
    expect((await campaignRow(db, draft.id)).status).toBe('draft');
  });

  it('sends only the asked channels, refuses a campaign that was sent or cancelled, and an unknown id', async () => {
    const draft = await createDraft(owner);
    const only = await owner.post(`/admin/notification-campaigns/${draft.id}/test`, { channels: ['in_app'] });
    expect(only.body).toEqual({ queued: ['in_app'] });
    await owner.post(`/admin/notification-campaigns/${draft.id}/schedule`, { scheduledAt: at(DAY) });
    await owner.post(`/admin/notification-campaigns/${draft.id}/cancel`);
    const refused = await owner.post(`/admin/notification-campaigns/${draft.id}/test`, {});
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('INVALID_TRANSITION');
    expect((await owner.post('/admin/notification-campaigns/999999/test', {})).status).toBe(404);
    expect(
      (await owner.post(`/admin/notification-campaigns/${draft.id}/test`, { channels: ['telegram'] })).status,
    ).toBe(422);
  });
});

describe('POST /admin/notification-campaigns/:id/schedule', () => {
  it('schedules with the reachable count, reschedules, and audits both', async () => {
    const draft = await createDraft(owner);
    const res = await owner.post(`/admin/notification-campaigns/${draft.id}/schedule`, { scheduledAt: at(DAY) });
    expect(res.status).toBe(200);
    // The owner, the merchant and the customer of beforeEach.
    expect(res.body).toMatchObject({ status: 'scheduled', scheduledAt: at(DAY), expectedRecipients: 3 });
    const again = await owner.post(`/admin/notification-campaigns/${draft.id}/schedule`, { scheduledAt: at(2 * DAY) });
    expect(again.body).toMatchObject({ status: 'scheduled', scheduledAt: at(2 * DAY) });
    const { db } = await testDb();
    const audit = (await campaignAudit(db, draft.id)).filter((row) => row.action === 'scheduled notification campaign');
    expect(audit).toHaveLength(2);
    expect(audit[1]).toMatchObject({ before: { scheduledAt: at(DAY) }, after: { scheduledAt: at(2 * DAY) } });
  });

  it('refuses a time less than a minute or more than 90 days ahead, an audience nobody is in, and a cancelled campaign', async () => {
    const draft = await createDraft(owner);
    const soon = await owner.post(`/admin/notification-campaigns/${draft.id}/schedule`, { scheduledAt: at(30_000) });
    expect(soon.status).toBe(422);
    expect(fieldsOf(soon.body)).toEqual(['scheduledAt']);
    const late = await owner.post(`/admin/notification-campaigns/${draft.id}/schedule`, { scheduledAt: at(91 * DAY) });
    expect(fieldsOf(late.body)).toEqual(['scheduledAt']);
    const edge = await owner.post(`/admin/notification-campaigns/${draft.id}/schedule`, { scheduledAt: at(MINUTE) });
    expect(edge.status).toBe(200);

    const nobody = await createDraft(owner, { audience: { customers: { countries: ['ZZ'] } } });
    const empty = await owner.post(`/admin/notification-campaigns/${nobody.id}/schedule`, { scheduledAt: at(DAY) });
    expect(empty.status).toBe(422);
    expect(fieldsOf(empty.body)).toEqual(['audience']);

    await owner.post(`/admin/notification-campaigns/${draft.id}/cancel`);
    const cancelled = await owner.post(`/admin/notification-campaigns/${draft.id}/schedule`, { scheduledAt: at(DAY) });
    expect(cancelled.status).toBe(409);
    expect(cancelled.body.code).toBe('INVALID_TRANSITION');
  });
});

describe('POST /admin/notification-campaigns/:id/cancel', () => {
  it('cancels a scheduled campaign with who and when, and refuses a draft or a cancelled one', async () => {
    const draft = await createDraft(owner);
    const refusedDraft = await owner.post(`/admin/notification-campaigns/${draft.id}/cancel`);
    expect(refusedDraft.status).toBe(409);
    expect(refusedDraft.body.code).toBe('INVALID_TRANSITION');
    await owner.post(`/admin/notification-campaigns/${draft.id}/schedule`, { scheduledAt: at(DAY) });
    const res = await owner.post(`/admin/notification-campaigns/${draft.id}/cancel`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'cancelled',
      cancelledAt: clock.now().toISOString(),
      cancelledBy: { id: owner.staffId, name: 'Rami K.' },
    });
    expect((await owner.post(`/admin/notification-campaigns/${draft.id}/cancel`)).status).toBe(409);
    expect((await owner.post('/admin/notification-campaigns/999999/cancel')).status).toBe(404);
    const { db } = await testDb();
    expect((await campaignAudit(db, draft.id)).at(-1)?.action).toBe('cancelled notification campaign');
  });
});

describe('templates of the announcement events', () => {
  it('refuses a template for broadcast.announcement: announcements are written per campaign', async () => {
    const res = await owner.post('/admin/notification-templates', {
      event: 'broadcast.announcement',
      channel: 'email',
      audience: 'merchant',
      subject: 'x',
      body: 'y',
      format: 'text',
    });
    expect(res.status).toBe(422);
    expect(fieldsOf(res.body)).toEqual(['event']);
  });
});
