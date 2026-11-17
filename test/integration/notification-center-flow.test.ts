// A whole broadcast from the staff member's side to the reader's (feature 23, plan section 15, "flow"): create, count the audience, preview, send
// a test, schedule, let the clock pass, sweep, fan out, deliver (in-memory drivers), a merchant and a customer read their inbox and mark read,
// the detail shows the delivery and read numbers, the recipients list names who got what, and the audit trail tells the story.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { type Database } from '../../src/infra/db';
import { QueuesService } from '../../src/infra/queues';
import { RedisService } from '../../src/infra/redis';
import { BROADCAST_QUEUE, CampaignSweepProcessor, SettingsReader } from '../../src/modules/platform';
import { schema as s } from '../../src/infra/db';
import { type AdminApi, adminWith } from '../support/admin-api';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches, insertMerchant, openSession } from '../support/auth';
import {
  campaignAudit,
  campaignMessages,
  createDraft,
  fanOutAll,
  fanOutWith,
  insertCustomer,
  jobLike,
  sendBroadcast,
} from '../support/campaigns';
import { MINUTE, TestClock } from '../support/clock';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { mailbox, merchantSession, seedDefaultTemplates, sendAllQueued } from '../support/notifications';
import { deleteBullKeys, testBullPrefix } from '../support/queues';
import { STORE_ORIGIN } from '../support/store';

const prefix = testBullPrefix();
const clock = new TestClock('2026-11-10T09:00:00.000Z');
let t: TestApp;
let db: Database;
let owner: AdminApi;

beforeAll(async () => {
  t = await createTestApp({ clock, env: { BULL_PREFIX: prefix } });
  db = (await testDb()).db;
});
beforeEach(async () => {
  clock.set('2026-11-10T09:00:00.000Z');
  await resetDb();
  await clearIdentityCaches(t);
  await t.app.get(QueuesService).queue(BROADCAST_QUEUE).obliterate({ force: true });
  await t.app.get(RedisService).cache.flushdb();
  await db.insert(s.settings).values([
    { key: 'notifications.broadcast_email_per_second', value: 30 },
    { key: 'notifications.broadcast_telegram_per_second', value: 30 },
  ]);
  await t.app.get(SettingsReader).invalidate();
  await seedDefaultTemplates(db);
  mailbox(t).reset();
  fanOutWith(t, { chunkSize: 500, timeBudgetMs: 60_000, highWater: 20_000 });
  owner = await adminWith(t, ['*'], { name: 'Rami K.' });
});
afterAll(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await deleteBullKeys(t.app.get(RedisService).queue, prefix);
  await t.close();
  await closeTestDb();
});

describe('the notification center, end to end', () => {
  it('takes a scheduled announcement from the composer to the readers and back to the detail page', async () => {
    const merchantId = await insertMerchant(db, { name: 'Zain Mobile Hub', email: 'ops@zainmobilehub.example' });
    const customerId = await insertCustomer(db, { name: 'Huda', email: 'huda@mail.example' });

    // 1. Write it.
    const draft = await createDraft(owner, {
      channels: ['in_app', 'email'],
      audience: { merchants: {}, customers: { hasAccount: true } },
    });
    expect(draft).toMatchObject({ status: 'draft', createdBy: { name: 'Rami K.' } });

    // 2. See who it reaches, and what it looks like.
    const preview = await owner.post('/admin/notification-campaigns/audience-preview', {
      audience: draft.audience,
      channels: draft.channels,
      purpose: draft.purpose,
    });
    expect(preview.body).toMatchObject({
      total: 2,
      reachable: 2,
      byType: { staff: 0, client: 1, customer: 1 },
      byChannel: { inApp: 2, email: 2, telegram: 0 },
    });
    const rendered = await owner.post(`/admin/notification-campaigns/${draft.id}/preview`, {
      channel: 'email',
      audience: 'customer',
    });
    expect(rendered.body).toMatchObject({ format: 'html', subject: 'Maintenance for Daniel' });
    expect(rendered.body.body).toStartWith('<div dir="ltr" lang="en"');

    // 3. Test it on yourself: an inbox item and one email, from the transactional queue.
    expect((await owner.post(`/admin/notification-campaigns/${draft.id}/test`, {})).body).toEqual({
      queued: ['in_app', 'email'],
    });
    await sendAllQueued(t);
    expect(mailbox(t).sent.map((mail) => mail.subject)).toEqual(['[Test] Maintenance for Rami K.']);
    expect((await owner.get('/admin/inbox')).body[0]).toMatchObject({
      title: '[Test] Maintenance for Rami K.',
      category: 'announcement',
    });
    mailbox(t).reset();

    // 4. Schedule it; nothing happens before its time.
    const scheduledAt = new Date(clock.nowMs() + 10 * MINUTE).toISOString();
    expect(
      (await owner.post(`/admin/notification-campaigns/${draft.id}/schedule`, { scheduledAt })).body,
    ).toMatchObject({
      status: 'scheduled',
      expectedRecipients: 2,
    });
    const sweep = () => t.app.get(CampaignSweepProcessor).process(jobLike({}));
    expect(await sweep()).toEqual({ queued: 0, rekicked: 0, failed: 0 });

    // 5. The time comes: the sweep queues it, the fan-out makes the items and messages, the sender delivers them.
    clock.advance(10 * MINUTE);
    expect(await sweep()).toEqual({ queued: 1, rekicked: 0, failed: 0 });
    await fanOutAll(t, draft.id);
    const rows = await campaignMessages(db, draft.id);
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(await sendBroadcast(t, row.id, 'email')).toEqual({ outcome: 'sent' });
    const toHuda = mailbox(t).sent.find((mail) => mail.to === 'huda@mail.example')!;
    expect(toHuda.subject).toBe('Maintenance for Huda');
    expect(toHuda.html).toStartWith('<div dir="ltr" lang="en"');
    expect(mailbox(t).sent.find((mail) => mail.to === 'ops@zainmobilehub.example')!.subject).toBe(
      'Maintenance for Zain Mobile Hub',
    );

    // 6. The readers open their inboxes (signed in after the clock moved).
    const merchant = await merchantSession(t, merchantId);
    const merchantItems = (await merchant.call('GET', '/client/notifications')).body;
    expect(merchantItems).toHaveLength(1);
    expect(merchantItems[0]).toMatchObject({
      title: 'Maintenance for Zain Mobile Hub',
      link: '/merchant/wallet',
      campaignId: draft.id,
      readAt: null,
    });
    expect((await merchant.call('GET', '/client/notifications/unread-count')).body).toEqual({ unread: 1 });
    expect((await merchant.call('POST', `/client/notifications/${merchantItems[0].id}/read`)).status).toBe(204);

    const session = await openSession(t, { type: 'customer', id: customerId });
    const asCustomer = async (url: string) => {
      const res = await t.app.inject({ method: 'GET', url, headers: { origin: STORE_ORIGIN, ...session.headers } });
      return JSON.parse(res.body);
    };
    const customerItems = await asCustomer('/store/v1/me/notifications');
    expect(customerItems[0]).toMatchObject({ title: 'Maintenance for Huda', link: '/account/orders' });
    const readAll = await t.app.inject({
      method: 'POST',
      url: '/store/v1/me/notifications/read-all',
      headers: { origin: STORE_ORIGIN, ...session.mutationHeaders },
      payload: { upToId: customerItems[0].id },
    });
    expect(JSON.parse(readAll.body)).toEqual({ updated: 1 });
    expect(await asCustomer('/store/v1/me/notifications/unread-count')).toEqual({ unread: 0 });

    // 7. Back on the detail page: the numbers, the recipients and the trail.
    const detail = (await owner.get(`/admin/notification-campaigns/${draft.id}`)).body;
    expect(detail).toMatchObject({
      status: 'sent',
      recipients: 2,
      expectedRecipients: 2,
      planned: { inApp: 2, email: 2, telegram: 0 },
      delivery: {
        inApp: { delivered: 2, read: 2 },
        email: { queued: 0, sent: 2, failed: 0 },
        telegram: { queued: 0, sent: 0, failed: 0 },
      },
    });
    const inApp = (await owner.get(`/admin/notification-campaigns/${draft.id}/recipients?channel=in_app`)).body;
    expect(inApp.map((row: { status: string }) => row.status)).toEqual(['read', 'read']);
    const email = await owner.get(`/admin/notification-campaigns/${draft.id}/recipients?channel=email`);
    expect(email.total).toBe(2);
    expect(email.body.map((row: { recipient: string }) => row.recipient).sort()).toEqual([
      'h***@mail.example',
      'o***@zainmobilehub.example',
    ]);
    expect((await owner.get(`/admin/notifications?campaignId=${draft.id}`)).total).toBe(2);
    expect((await campaignAudit(db, draft.id)).map((row) => `${row.actorType}: ${row.action}`)).toEqual([
      'staff: created notification campaign',
      'staff: sent test notification',
      'staff: scheduled notification campaign',
      'system: sent scheduled notification campaign',
    ]);
  });
});
