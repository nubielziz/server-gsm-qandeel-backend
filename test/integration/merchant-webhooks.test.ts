// Integration tests of the webhook routes (feature 7b, stage 7): the merchant's endpoints under /client/webhooks (MISMATCHES B156), the
// delivery log of an endpoint, and the staff's log under /admin/webhook-deliveries with the manual retry. Real Postgres and Redis; the
// delivery jobs are added to a queue of this file's own prefix and no worker runs (the engine has its own tests).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { CacheKeys } from '../../src/infra/cache';
import { EncryptionService } from '../../src/infra/crypto';
import { type Database, schema as s } from '../../src/infra/db';
import { QueuesService } from '../../src/infra/queues';
import { RedisService } from '../../src/infra/redis';
import { WEBHOOK_SECRET_AAD } from '../../src/modules/platform/webhooks/webhook-deliveries';
import { type TestApp, createTestApp } from '../support/app';
import { adminWith } from '../support/admin-api';
import { clearIdentityCaches, insertMerchant } from '../support/auth';
import { MINUTE, TestClock } from '../support/clock';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { deleteBullKeys, testBullPrefix } from '../support/queues';
import {
  type PortalClient,
  WebhookTestModule,
  insertDelivery,
  insertEndpoint,
  portalFor,
  resetWebhookPolicy,
} from '../support/webhooks';

const prefix = testBullPrefix();
const clock = new TestClock('2026-11-01T10:00:00.000Z');
let t: TestApp;
let db: Database;

beforeAll(async () => {
  ({ db } = await testDb());
  t = await createTestApp({ clock, env: { BULL_PREFIX: prefix }, imports: [WebhookTestModule] });
});
afterAll(async () => {
  await deleteBullKeys(t.app.get(RedisService).queue, prefix);
  await resetDb();
  await t.close();
  await closeTestDb();
});
beforeEach(async () => {
  clock.set('2026-11-01T10:00:00.000Z');
  resetWebhookPolicy();
  await resetDb();
  await clearIdentityCaches(t);
  await deleteBullKeys(t.app.get(RedisService).queue, prefix);
  const redis = t.app.get(RedisService).cache;
  const found = await redis.keys(`${t.app.get(CacheKeys).rateLimit('webhook-retry')}:*`);
  if (found.length > 0) await redis.del(...found);
});

async function merchant(overrides: Partial<typeof s.clients.$inferInsert> = {}): Promise<PortalClient> {
  return portalFor(t, await insertMerchant(db, overrides));
}
const encryption = () => t.app.get(EncryptionService);
const fieldsOf = (body: { errors: Array<{ field: string }> }) => body.errors.map((error) => error.field);

describe('POST /client/webhooks', () => {
  it('creates an endpoint, shows the signing secret once and stores it encrypted', async () => {
    const m = await merchant();
    const res = await m.call('POST', '/client/webhooks', {
      url: ' https://hooks.example.com/gsm ',
      events: ['order.status_changed', 'wallet.low_balance', 'order.status_changed'],
    });
    expect(res.status).toBe(201);
    expect(res.res.headers['cache-control']).toBe('no-store');
    const { endpoint, secret } = res.body;
    expect(secret).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
    expect(endpoint).toMatchObject({
      url: 'https://hooks.example.com/gsm',
      events: ['order.status_changed', 'wallet.low_balance'],
      isActive: true,
      failureCount: 0,
    });
    expect(JSON.stringify(endpoint)).not.toContain(secret);

    const [row] = await db.select().from(s.webhookEndpoints).where(eq(s.webhookEndpoints.id, endpoint.id));
    expect(row?.clientId).toBe(m.clientId);
    expect(row?.secretEnc).not.toContain(secret);
    expect(row?.secretEnc.startsWith('v1:')).toBe(true);
    expect(encryption().decrypt(row!.secretEnc, WEBHOOK_SECRET_AAD)).toBe(secret);
  });

  it('can start switched off, and writes no audit row (merchant routes are not audited, B121)', async () => {
    const m = await merchant();
    const res = await m.call('POST', '/client/webhooks', {
      url: 'https://hooks.example.com/',
      events: ['invoice.paid'],
      isActive: false,
    });
    expect(res.body.endpoint.isActive).toBe(false);
    expect(await db.select().from(s.auditLogs)).toEqual([]);
  });

  it('refuses an address that is not https with a public host, with 422 on url', async () => {
    const m = await merchant();
    const events = ['invoice.paid'];
    const refused = async (url: string) => {
      const res = await m.call('POST', '/client/webhooks', { url, events });
      expect(res.status, url).toBe(422);
      expect(fieldsOf(res.body), url).toEqual(['url']);
      return res.body.errors[0].message as string;
    };
    expect(await refused('http://hooks.example.com/gsm')).toContain('https://');
    expect(await refused('https://private.example.com/gsm')).toContain('public host');
    expect(await refused('https://127.0.0.1/gsm')).toContain('public host');
    expect(await refused('https://169.254.169.254/latest/meta-data')).toContain('public host');
    expect(await refused('https://user:pw@hooks.example.com/')).toContain('user name');
    expect(await refused('not a url')).toContain('full address');
    expect(await db.select().from(s.webhookEndpoints)).toEqual([]);
  });

  it('refuses events that are empty or not one of the four, with 422 on events.N', async () => {
    const m = await merchant();
    const url = 'https://hooks.example.com/gsm';
    expect(fieldsOf((await m.call('POST', '/client/webhooks', { url, events: [] })).body)).toEqual(['events']);
    const unknown = await m.call('POST', '/client/webhooks', {
      url,
      events: ['invoice.paid', 'order.completed', 'ping'],
    });
    expect(unknown.status).toBe(422);
    expect(fieldsOf(unknown.body)).toEqual(['events.1', 'events.2']);
    expect((await m.call('POST', '/client/webhooks', { url })).status).toBe(422);
  });

  it('refuses the 6th endpoint with 422 on url, also when requests arrive together', async () => {
    const m = await merchant();
    const create = (index: number) =>
      m.call('POST', '/client/webhooks', { url: `https://hooks.example.com/${index}`, events: ['invoice.paid'] });
    const answers = await Promise.all(Array.from({ length: 8 }, (_, index) => create(index)));
    expect(answers.filter((answer) => answer.status === 201)).toHaveLength(5);
    const refused = answers.filter((answer) => answer.status === 422);
    expect(refused).toHaveLength(3);
    expect(refused[0]?.body.errors[0]).toMatchObject({
      field: 'url',
      message: 'You can register 5 endpoints; delete one first.',
    });
    // Another merchant has its own five.
    const other = await merchant();
    expect(
      (await other.call('POST', '/client/webhooks', { url: 'https://hooks.example.com/x', events: ['invoice.paid'] }))
        .status,
    ).toBe(201);
  });

  it('needs a session, a CSRF token and an approved merchant', async () => {
    const m = await merchant();
    const payload = { url: 'https://hooks.example.com/gsm', events: ['invoice.paid'] };
    expect((await m.withoutCsrf('POST', '/client/webhooks', payload)).body.code).toBe('CSRF_FAILED');
    expect((await t.app.inject({ method: 'POST', url: '/client/webhooks', payload })).statusCode).toBe(401);
    const pending = await merchant({ status: 'pending' });
    expect((await pending.call('POST', '/client/webhooks', payload)).body.code).toBe('ACCOUNT_PENDING_APPROVAL');
  });
});

describe('GET /client/webhooks', () => {
  it("lists the merchant's own endpoints newest first with the exact total, never the secret or another merchant's", async () => {
    const m = await merchant();
    const other = await merchant();
    const first = await insertEndpoint(encryption(), db, m.clientId, { url: 'https://a.example.com/' });
    const second = await insertEndpoint(encryption(), db, m.clientId, {
      url: 'https://b.example.com/',
      failureCount: 3,
    });
    await insertEndpoint(encryption(), db, other.clientId);
    const res = await m.call('GET', '/client/webhooks');
    expect(res.status).toBe(200);
    expect(res.total).toBe(2);
    expect(res.body.map((row: { id: number }) => row.id)).toEqual([second, first]);
    expect(res.body[0]).toMatchObject({ url: 'https://b.example.com/', failureCount: 3, isActive: true });
    expect(JSON.stringify(res.body)).not.toContain('secret');
    expect((await m.call('GET', '/client/webhooks?_start=1&_end=2')).body.map((row: { id: number }) => row.id)).toEqual(
      [first],
    );
  });
});

describe('PATCH /client/webhooks/:id', () => {
  it('changes the address, the events and the switch; turning it on again resets the failure count', async () => {
    const m = await merchant();
    const id = await insertEndpoint(encryption(), db, m.clientId, { isActive: false, failureCount: 7 });
    const kept = await m.call('PATCH', `/client/webhooks/${id}`, {
      url: 'https://new.example.com/hook',
      events: ['wallet.low_balance'],
    });
    expect(kept.body).toMatchObject({
      url: 'https://new.example.com/hook',
      events: ['wallet.low_balance'],
      isActive: false,
      failureCount: 7,
    });
    const on = await m.call('PATCH', `/client/webhooks/${id}`, { isActive: true });
    expect(on.body).toMatchObject({ isActive: true, failureCount: 0 });
    // Pausing keeps the counter; saving "on" for an endpoint that is on changes nothing.
    await db.update(s.webhookEndpoints).set({ failureCount: 2 }).where(eq(s.webhookEndpoints.id, id));
    expect((await m.call('PATCH', `/client/webhooks/${id}`, { isActive: true })).body.failureCount).toBe(2);
    expect((await m.call('PATCH', `/client/webhooks/${id}`, { isActive: false })).body.failureCount).toBe(2);
  });

  it('checks a changed address like a new one, and the events', async () => {
    const m = await merchant();
    const id = await insertEndpoint(encryption(), db, m.clientId);
    const res = await m.call('PATCH', `/client/webhooks/${id}`, { url: 'http://insecure.example.com/' });
    expect(res.status).toBe(422);
    expect(fieldsOf(res.body)).toEqual(['url']);
    expect(fieldsOf((await m.call('PATCH', `/client/webhooks/${id}`, { events: ['nope'] })).body)).toEqual([
      'events.0',
    ]);
    const [row] = await db.select().from(s.webhookEndpoints).where(eq(s.webhookEndpoints.id, id));
    expect(row?.url).toBe('https://hooks.example.com/gsm');
  });

  it("answers 404 for another merchant's endpoint and an unknown one", async () => {
    const mine = await merchant();
    const other = await merchant();
    const theirs = await insertEndpoint(encryption(), db, other.clientId);
    expect((await mine.call('PATCH', `/client/webhooks/${theirs}`, { isActive: false })).status).toBe(404);
    expect((await mine.call('PATCH', '/client/webhooks/999999', { isActive: false })).status).toBe(404);
    const [row] = await db.select().from(s.webhookEndpoints).where(eq(s.webhookEndpoints.id, theirs));
    expect(row?.isActive).toBe(true);
  });
});

describe('DELETE /client/webhooks/:id', () => {
  it('deletes the endpoint and its delivery log', async () => {
    const m = await merchant();
    const id = await insertEndpoint(encryption(), db, m.clientId);
    await insertDelivery(db, id);
    await insertDelivery(db, id);
    const res = await m.call('DELETE', `/client/webhooks/${id}`);
    expect(res.status).toBe(204);
    expect(await db.select().from(s.webhookEndpoints)).toEqual([]);
    expect(await db.select().from(s.webhookDeliveries)).toEqual([]);
    expect((await m.call('DELETE', `/client/webhooks/${id}`)).status).toBe(404);
  });

  it("answers 404 for another merchant's endpoint and leaves it alone", async () => {
    const mine = await merchant();
    const other = await merchant();
    const theirs = await insertEndpoint(encryption(), db, other.clientId);
    expect((await mine.call('DELETE', `/client/webhooks/${theirs}`)).status).toBe(404);
    expect(await db.select().from(s.webhookEndpoints)).toHaveLength(1);
  });
});

describe('POST /client/webhooks/:id/test', () => {
  it('queues a signed ping delivery with a sample payload and answers 202 with its id', async () => {
    const m = await merchant();
    const id = await insertEndpoint(encryption(), db, m.clientId, { events: ['invoice.paid'] });
    const res = await m.call('POST', `/client/webhooks/${id}/test`);
    expect(res.status).toBe(202);
    const [row] = await db.select().from(s.webhookDeliveries).where(eq(s.webhookDeliveries.id, res.body.deliveryId));
    expect(row).toMatchObject({ endpointId: id, event: 'ping', attempt: 1, status: 'pending' });
    expect(row?.nextRetryAt?.toISOString()).toBe(clock.now().toISOString());
    expect(row?.eventId).toMatch(/^evt_[A-Za-z0-9_-]{24}$/);
    expect(row?.payload).toEqual({
      id: row?.eventId,
      type: 'ping',
      createdAt: clock.now().toISOString(),
      data: { message: 'This is a test event from GSM.', endpointId: id },
    });
    const job = await t.app.get(QueuesService).queue('merchant-webhooks').getJob(`webhook-${res.body.deliveryId}-1`);
    expect(job?.name).toBe('webhook.deliver');
    expect(job?.data).toMatchObject({ deliveryId: res.body.deliveryId, attempt: 1 });
  });

  it('sends a test even to an endpoint that is not subscribed to any real event it names, and twice gives two deliveries', async () => {
    const m = await merchant();
    const id = await insertEndpoint(encryption(), db, m.clientId);
    const a = await m.call('POST', `/client/webhooks/${id}/test`);
    const b = await m.call('POST', `/client/webhooks/${id}/test`);
    expect(a.body.deliveryId).not.toBe(b.body.deliveryId);
  });

  it('is 409 INVALID_TRANSITION for a paused endpoint and 404 for another merchant’s or an unknown one', async () => {
    const m = await merchant();
    const paused = await insertEndpoint(encryption(), db, m.clientId, { isActive: false });
    const refused = await m.call('POST', `/client/webhooks/${paused}/test`);
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('INVALID_TRANSITION');
    const other = await merchant();
    const theirs = await insertEndpoint(encryption(), db, other.clientId);
    expect((await m.call('POST', `/client/webhooks/${theirs}/test`)).status).toBe(404);
    expect((await m.call('POST', '/client/webhooks/999999/test')).status).toBe(404);
    expect(await db.select().from(s.webhookDeliveries)).toEqual([]);
  });
});

describe('GET /client/webhooks/:id/deliveries', () => {
  it("lists the endpoint's deliveries newest first in the portal's words", async () => {
    const m = await merchant();
    const id = await insertEndpoint(encryption(), db, m.clientId);
    const other = await insertEndpoint(encryption(), db, m.clientId);
    await insertDelivery(db, other);
    const ok = await insertDelivery(db, id, { status: 'delivered', responseCode: 200, nextRetryAt: null });
    const failed = await insertDelivery(db, id, {
      status: 'failed',
      attempt: 8,
      responseCode: null,
      error: 'The endpoint did not answer within 10 seconds.',
      nextRetryAt: null,
    });
    const waiting = await insertDelivery(db, id, {
      attempt: 3,
      responseCode: 500,
      nextRetryAt: new Date(clock.nowMs() + MINUTE),
    });
    const res = await m.call('GET', `/client/webhooks/${id}/deliveries`);
    expect(res.status).toBe(200);
    expect(res.total).toBe(3);
    expect(res.body.map((row: { id: number }) => row.id)).toEqual([waiting, failed, ok]);
    expect(res.body[0]).toEqual({
      id: waiting,
      event: 'order.status_changed',
      attempt: 3,
      status: 'pending',
      responseCode: 500,
      error: '',
      nextRetryAt: new Date(clock.nowMs() + MINUTE).toISOString(),
      createdAt: expect.any(String),
    });
    expect(res.body[1]).toMatchObject({
      status: 'failed',
      responseCode: 0,
      error: 'The endpoint did not answer within 10 seconds.',
      nextRetryAt: null,
    });
    expect(res.body[2]).toMatchObject({ status: 'succeeded', responseCode: 200 });
    expect(JSON.stringify(res.body)).not.toContain('payload');
  });

  it("answers 404 for another merchant's endpoint and an unknown one", async () => {
    const mine = await merchant();
    const other = await merchant();
    const theirs = await insertEndpoint(encryption(), db, other.clientId);
    expect((await mine.call('GET', `/client/webhooks/${theirs}/deliveries`)).status).toBe(404);
    expect((await mine.call('GET', '/client/webhooks/999999/deliveries')).status).toBe(404);
  });
});

describe('GET /admin/webhook-deliveries', () => {
  async function world() {
    const zain = await insertMerchant(db, { name: 'Zain Mobile Hub' });
    const hassan = await insertMerchant(db, { name: 'Hassan Mobile' });
    const zainHook = await insertEndpoint(encryption(), db, zain, { url: 'https://hooks.zain.example/gsm' });
    const hassanHook = await insertEndpoint(encryption(), db, hassan, { url: 'https://api.hassan.example/in' });
    const a = await insertDelivery(db, zainHook, { status: 'delivered', responseCode: 200, nextRetryAt: null });
    const b = await insertDelivery(db, hassanHook, {
      status: 'failed',
      attempt: 8,
      responseCode: null,
      event: 'wallet.low_balance',
      error: 'The endpoint could not be reached (the connection failed).',
      nextRetryAt: null,
    });
    const c = await insertDelivery(db, zainHook, {
      attempt: 2,
      responseCode: 500,
      responseBody: '{"error":"internal"}',
    });
    return { zain, hassan, zainHook, hassanHook, a, b, c };
  }

  it('lists newest first with the endpoint and the merchant joined, and responseCode 0 for no answer', async () => {
    const staff = await adminWith(t, ['webhooks:read']);
    const w = await world();
    const res = await staff.get('/admin/webhook-deliveries');
    expect(res.status).toBe(200);
    expect(res.total).toBe(3);
    expect(res.body.map((row: { id: number }) => row.id)).toEqual([w.c, w.b, w.a]);
    expect(res.body[0]).toMatchObject({
      id: w.c,
      endpointId: w.zainHook,
      event: 'order.status_changed',
      attempt: 2,
      status: 'pending',
      responseCode: 500,
      responseBody: '{"error":"internal"}',
      error: null,
      endpoint: { id: w.zainHook, url: 'https://hooks.zain.example/gsm' },
      client: { id: w.zain, name: 'Zain Mobile Hub' },
    });
    expect(res.body[0].payload).toMatchObject({ type: 'order.status_changed' });
    expect(res.body[1]).toMatchObject({ status: 'failed', responseCode: 0, nextRetryAt: null });
  });

  it('filters by status, event and merchant, searches merchant, event and address, and counts exactly', async () => {
    const staff = await adminWith(t, ['webhooks:read']);
    const w = await world();
    const ids = async (query: string) =>
      (await staff.get(`/admin/webhook-deliveries?${query}`)).body.map((row: { id: number }) => row.id);
    expect(await ids('status=failed')).toEqual([w.b]);
    expect(await ids('status_ne=delivered')).toEqual([w.c, w.b]);
    expect(await ids('event=wallet.low_balance')).toEqual([w.b]);
    expect(await ids(`clientId=${w.zain}`)).toEqual([w.c, w.a]);
    expect(await ids('q=hassan')).toEqual([w.b]);
    expect(await ids('q=LOW_BAL')).toEqual([w.b]);
    expect(await ids('q=hooks.zain')).toEqual([w.c, w.a]);
    const counted = await staff.get('/admin/webhook-deliveries?clientId=' + w.zain + '&_start=0&_end=1');
    expect(counted.body).toHaveLength(1);
    expect(counted.total).toBe(2);
    expect((await staff.get('/admin/webhook-deliveries?status=bogus')).status).toBe(422);
    expect((await staff.get('/admin/webhook-deliveries?_sort=attempt')).status).toBe(422);
    expect(await ids('_sort=createdAt&_order=asc')).toEqual([w.a, w.b, w.c]);
  });

  it('needs webhooks:read', async () => {
    const reader = await adminWith(t, ['webhooks:read']);
    const other = await adminWith(t, ['audit:read']);
    expect((await other.get('/admin/webhook-deliveries')).status).toBe(403);
    expect((await reader.anonymous('GET', '/admin/webhook-deliveries')).status).toBe(401);
  });
});

describe('GET /admin/webhook-deliveries/:id', () => {
  it('shows the delivery with the request that was sent and the merchant’s answer', async () => {
    const staff = await adminWith(t, ['webhooks:read']);
    const id = await insertMerchant(db, { name: 'Zain Mobile Hub' });
    const endpoint = await insertEndpoint(encryption(), db, id);
    const delivery = await insertDelivery(db, endpoint, {
      attempt: 2,
      responseCode: 502,
      responseBody: '<html>Bad gateway</html>',
      error: null,
    });
    const res = await staff.get(`/admin/webhook-deliveries/${delivery}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: delivery,
      responseCode: 502,
      responseBody: '<html>Bad gateway</html>',
      error: null,
      payload: { type: 'order.status_changed', data: { orderId: 48102, status: 'completed' } },
      client: { id, name: 'Zain Mobile Hub' },
    });
  });

  it('answers 404 for an unknown delivery and 403 without webhooks:read', async () => {
    const staff = await adminWith(t, ['webhooks:read']);
    expect((await staff.get('/admin/webhook-deliveries/999999')).status).toBe(404);
    const other = await adminWith(t, ['audit:read']);
    expect((await other.get('/admin/webhook-deliveries/1')).status).toBe(403);
  });
});

describe('POST /admin/webhook-deliveries/:id/retry', () => {
  async function failedDelivery(overrides: Partial<typeof s.webhookDeliveries.$inferInsert> = {}) {
    const clientId = await insertMerchant(db, { name: 'Zain Mobile Hub' });
    const endpoint = await insertEndpoint(encryption(), db, clientId);
    const id = await insertDelivery(db, endpoint, {
      status: 'failed',
      attempt: 8,
      responseCode: 500,
      nextRetryAt: null,
      ...overrides,
    });
    return { clientId, endpoint, id };
  }

  it('queues one more attempt now: pending, attempt + 1, due now, and adds the job', async () => {
    const staff = await adminWith(t, ['webhooks:update'], { name: 'Rami K.' });
    const { id, clientId } = await failedDelivery();
    const res = await staff.post(`/admin/webhook-deliveries/${id}/retry`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id,
      status: 'pending',
      attempt: 9,
      nextRetryAt: clock.now().toISOString(),
      responseCode: 500,
    });
    const [row] = await db.select().from(s.webhookDeliveries).where(eq(s.webhookDeliveries.id, id));
    expect(row).toMatchObject({ status: 'pending', attempt: 9 });
    const job = await t.app.get(QueuesService).queue('merchant-webhooks').getJob(`webhook-${id}-9`);
    expect(job?.data).toMatchObject({ deliveryId: id, attempt: 9 });
    expect(job?.opts.delay).toBe(0);

    const [audit] = await db.select().from(s.auditLogs);
    expect(audit).toMatchObject({
      actorName: 'Rami K.',
      action: 'retried webhook delivery of',
      entityType: 'merchant',
      entityId: clientId,
      entityLabel: 'Zain Mobile Hub',
    });
    expect(audit?.after).toMatchObject({ deliveryId: id, attempt: 9, status: 'pending' });
  });

  it('also resends a delivery that is still waiting for its next attempt', async () => {
    const staff = await adminWith(t, ['webhooks:update']);
    const { id } = await failedDelivery({
      status: 'pending',
      attempt: 3,
      nextRetryAt: new Date(clock.nowMs() + 40 * MINUTE),
    });
    const res = await staff.post(`/admin/webhook-deliveries/${id}/retry`);
    expect(res.body).toMatchObject({ status: 'pending', attempt: 4, nextRetryAt: clock.now().toISOString() });
  });

  it('refuses a delivery that already worked with 409 DELIVERY_SUCCEEDED and writes nothing', async () => {
    const staff = await adminWith(t, ['webhooks:update']);
    const { id } = await failedDelivery({ status: 'delivered', attempt: 1, responseCode: 200 });
    const res = await staff.post(`/admin/webhook-deliveries/${id}/retry`);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('DELIVERY_SUCCEEDED');
    expect(await db.select().from(s.auditLogs)).toEqual([]);
    const [row] = await db.select().from(s.webhookDeliveries).where(eq(s.webhookDeliveries.id, id));
    expect(row?.attempt).toBe(1);
  });

  it('answers 429 with Retry-After for a second retry of the same delivery within a minute, and rolls that one back', async () => {
    const staff = await adminWith(t, ['webhooks:update']);
    const { id } = await failedDelivery();
    expect((await staff.post(`/admin/webhook-deliveries/${id}/retry`)).status).toBe(200);
    const second = await staff.post(`/admin/webhook-deliveries/${id}/retry`);
    expect(second.status).toBe(429);
    expect(second.body.code).toBe('RATE_LIMITED');
    expect(Number(second.res.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    const [row] = await db.select().from(s.webhookDeliveries).where(eq(s.webhookDeliveries.id, id));
    expect(row?.attempt).toBe(9);
    expect(await db.select().from(s.auditLogs)).toHaveLength(1);
    // Another delivery has its own budget.
    const other = await failedDelivery();
    expect((await staff.post(`/admin/webhook-deliveries/${other.id}/retry`)).status).toBe(200);
  });

  it('answers 404 for an unknown delivery and 403 without webhooks:update', async () => {
    const staff = await adminWith(t, ['webhooks:update']);
    expect((await staff.post('/admin/webhook-deliveries/999999/retry')).status).toBe(404);
    const reader = await adminWith(t, ['webhooks:read']);
    const { id } = await failedDelivery();
    expect((await reader.post(`/admin/webhook-deliveries/${id}/retry`)).status).toBe(403);
    expect((await staff.withoutCsrf('POST', `/admin/webhook-deliveries/${id}/retry`)).status).toBe(403);
  });
});
