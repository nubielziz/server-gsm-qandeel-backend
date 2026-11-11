// Integration tests of `POST /admin/notification-campaigns/:id/send` (feature 23, route 9, S11): the confirmed number and its tolerance,
// the refusals (nobody reachable, the audience changed, not a draft or scheduled), exactly one outbox event, and the races: two parallel
// sends, a send racing an edit and a send racing a cancel.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { schema as s } from '../../src/infra/db';
import { type AdminApi, adminWith } from '../support/admin-api';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches } from '../support/auth';
import { campaignAudit, campaignRow, createDraft, insertCustomer } from '../support/campaigns';
import { DAY, TestClock } from '../support/clock';
import { closeTestDb, resetDb, testDb } from '../support/db';

const clock = new TestClock('2026-11-10T09:00:00.000Z');
let t: TestApp;
let owner: AdminApi;

const CUSTOMERS = { audience: { customers: { hasAccount: true } } };

async function fanOutEvents(campaignId: number) {
  const { db } = await testDb();
  return db
    .select()
    .from(s.outboxEvents)
    .where(eq(s.outboxEvents.type, 'notification.campaign_fanout'))
    .then((rows) => rows.filter((row) => row.aggregateId === campaignId));
}

beforeAll(async () => {
  t = await createTestApp({ clock });
});
beforeEach(async () => {
  clock.set('2026-11-10T09:00:00.000Z');
  await resetDb();
  await clearIdentityCaches(t);
  owner = await adminWith(t, ['*']);
  const { db } = await testDb();
  for (let i = 0; i < 10; i += 1) await insertCustomer(db);
});
afterAll(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await t.close();
  await closeTestDb();
});

describe('POST /admin/notification-campaigns/:id/send', () => {
  it('queues the campaign with the reachable count, one outbox event and an audit row', async () => {
    const draft = await createDraft(owner, CUSTOMERS);
    const res = await owner.post(`/admin/notification-campaigns/${draft.id}/send`, { confirmRecipients: 10 });
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({
      status: 'queued',
      queuedAt: clock.now().toISOString(),
      expectedRecipients: 10,
      updatedBy: { id: owner.staffId },
    });
    const events = await fanOutEvents(draft.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ aggregateType: 'notification_campaigns', payload: {} });
    const { db } = await testDb();
    expect((await campaignAudit(db, draft.id)).at(-1)).toMatchObject({
      action: 'sent notification campaign',
      after: { status: 'queued', channels: ['in_app', 'email'], purpose: 'service', expectedRecipients: 10 },
    });
  });

  it('accepts a confirmed number within max(5, 2 %) and refuses a larger drift with 409 CONFLICT and the new number', async () => {
    const near = await createDraft(owner, CUSTOMERS);
    expect((await owner.post(`/admin/notification-campaigns/${near.id}/send`, { confirmRecipients: 15 })).status).toBe(
      202,
    );
    const far = await createDraft(owner, CUSTOMERS);
    const res = await owner.post(`/admin/notification-campaigns/${far.id}/send`, { confirmRecipients: 16 });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CONFLICT');
    expect(res.body.recipients).toBe(10);
    expect(res.body.detail).toContain('10');
    expect((await campaignRow((await testDb()).db, far.id)).status).toBe('draft');
    expect(await fanOutEvents(far.id)).toHaveLength(0);
  });

  it('refuses an audience nobody is in with 422 on audience, a bad number with 422, and a sent campaign with 409', async () => {
    const nobody = await createDraft(owner, { audience: { customers: { countries: ['ZZ'] } } });
    const empty = await owner.post(`/admin/notification-campaigns/${nobody.id}/send`, { confirmRecipients: 1 });
    expect(empty.status).toBe(422);
    expect(empty.body.errors.map((e: { field: string }) => e.field)).toEqual(['audience']);
    const draft = await createDraft(owner, CUSTOMERS);
    const zero = await owner.post(`/admin/notification-campaigns/${draft.id}/send`, { confirmRecipients: 0 });
    expect(zero.status).toBe(422);
    expect(zero.body.errors.map((e: { field: string }) => e.field)).toEqual(['confirmRecipients']);
    await owner.post(`/admin/notification-campaigns/${draft.id}/send`, { confirmRecipients: 10 });
    const again = await owner.post(`/admin/notification-campaigns/${draft.id}/send`, { confirmRecipients: 10 });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('INVALID_TRANSITION');
    expect((await owner.post('/admin/notification-campaigns/999999/send', { confirmRecipients: 1 })).status).toBe(404);
  });

  it('sends a scheduled campaign now', async () => {
    const draft = await createDraft(owner, CUSTOMERS);
    await owner.post(`/admin/notification-campaigns/${draft.id}/schedule`, {
      scheduledAt: new Date(clock.nowMs() + DAY).toISOString(),
    });
    const res = await owner.post(`/admin/notification-campaigns/${draft.id}/send`, { confirmRecipients: 10 });
    expect(res.status).toBe(202);
    expect(res.body.status).toBe('queued');
  });
});

describe('races', () => {
  it('of two parallel sends, one is accepted and one refused, with one outbox event', async () => {
    const draft = await createDraft(owner, CUSTOMERS);
    const answers = await Promise.all([
      owner.post(`/admin/notification-campaigns/${draft.id}/send`, { confirmRecipients: 10 }),
      owner.post(`/admin/notification-campaigns/${draft.id}/send`, { confirmRecipients: 10 }),
    ]);
    expect(answers.map((res) => res.status).sort()).toEqual([202, 409]);
    expect(await fanOutEvents(draft.id)).toHaveLength(1);
    const { db } = await testDb();
    expect(
      (await campaignAudit(db, draft.id)).filter((row) => row.action === 'sent notification campaign'),
    ).toHaveLength(1);
  });

  it('a send racing an edit of the audience never sends with a stale count: either order is consistent', async () => {
    const draft = await createDraft(owner, CUSTOMERS);
    const [send, edit] = await Promise.all([
      owner.post(`/admin/notification-campaigns/${draft.id}/send`, { confirmRecipients: 10 }),
      owner.patch(`/admin/notification-campaigns/${draft.id}`, { audience: { customers: { countries: ['ZZ'] } } }),
    ]);
    const row = await campaignRow((await testDb()).db, draft.id);
    if (send.status === 202) {
      // The send won: the edit found a queued campaign; the stored audience is the one that was counted.
      expect(edit.status).toBe(409);
      expect(row).toMatchObject({ status: 'queued', audience: CUSTOMERS.audience });
    } else {
      // The edit won first: the send refused (the audience changed or now reaches nobody) and nothing is queued.
      expect(edit.status).toBe(200);
      expect([409, 422]).toContain(send.status);
      expect(row.status).toBe('draft');
      expect(await fanOutEvents(draft.id)).toHaveLength(0);
    }
  });

  it('a send racing a cancel of a scheduled campaign ends in exactly one of the two states', async () => {
    const draft = await createDraft(owner, CUSTOMERS);
    await owner.post(`/admin/notification-campaigns/${draft.id}/schedule`, {
      scheduledAt: new Date(clock.nowMs() + DAY).toISOString(),
    });
    const [send, cancel] = await Promise.all([
      owner.post(`/admin/notification-campaigns/${draft.id}/send`, { confirmRecipients: 10 }),
      owner.post(`/admin/notification-campaigns/${draft.id}/cancel`),
    ]);
    const row = await campaignRow((await testDb()).db, draft.id);
    // A cancel may also win after the send (queued is cancellable): then the fan-out stops at its first chunk.
    expect(cancel.status).toBe(200);
    expect(row.status).toBe('cancelled');
    expect(await fanOutEvents(draft.id)).toHaveLength(send.status === 202 ? 1 : 0);
  });
});
