// Integration tests of the inbox on the live streams (feature 27, decision 037, plan § 8): an event item reaches its owner at once
// in the owner's language, nothing rings for a rolled-back change, nothing reaches another person with the same id, reads reach the
// owner's other streams, a campaign chunk reaches every connected recipient once, a cancel recounts, a reconnect replays (or
// resyncs), and the subscriber resyncs after a Redis outage. A listening test app on real Postgres and Redis.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { Redis } from 'ioredis';
import { parseEnv } from '../../src/config';
import { DbService, createDrizzle, createPool, onCommit, runInTransaction } from '../../src/infra/db';
import { RealtimeHub, RealtimePublisher } from '../../src/infra/realtime';
import { RedisService } from '../../src/infra/redis';
import { sql } from 'drizzle-orm';
import {
  CampaignFanOut,
  type NotificationInput,
  NotificationInbox,
  NotificationService,
} from '../../src/modules/platform';
import { type AdminApi, adminWith } from '../support/admin-api';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches, insertMerchant, insertRole, insertStaff, openSession } from '../support/auth';
import { createDraft, fanOutAll, fanOutWith, insertCustomer, sendNow } from '../support/campaigns';
import { TestClock } from '../support/clock';
import { TEST_DATABASE_URL, closeTestDb, resetDb, testDb } from '../support/db';
import { testInstanceEnv } from '../support/env';
import { createForwarder, eventually } from '../support/infra';
import { seedDefaultTemplates } from '../support/notifications';
import { deleteBullKeys, testBullPrefix } from '../support/queues';
import { SAME_ORIGIN, type TestStream, clearStreamLimits, listen, openStream } from '../support/stream';

const prefix = testBullPrefix();
const clock = new TestClock();
let t: TestApp;
let base: string;
const open: TestStream[] = [];
/** Every doorbell the test app published, as JSON text (a second subscriber on the same channel). */
const doorbells: string[] = [];
let listener: Redis;

async function stream(path: string, headers: Record<string, string>, on = base): Promise<TestStream> {
  const opened = await openStream(`${on}${path}`, headers);
  open.push(opened);
  return opened;
}

/** Takes `ready` and the snapshot's count. */
async function started(s: TestStream, unread = 0): Promise<TestStream> {
  expect(s.status).toBe(200);
  expect((await s.next()).event).toBe('ready');
  expect(await s.next()).toMatchObject({ event: 'unread.changed', data: { unread } });
  return s;
}

/** The headers of a same-origin EventSource request of a new session of an account. */
async function sessionHeaders(
  subject: { type: 'staff' | 'client' | 'customer'; id: number },
  app: TestApp = t,
): Promise<{ headers: Record<string, string>; mutation: Record<string, string> }> {
  const session = await openSession(app, subject);
  return { headers: { ...SAME_ORIGIN, ...session.headers }, mutation: session.mutationHeaders };
}

const enqueue = (input: NotificationInput) =>
  t.app.get(DbService).runInTransaction(({ tx }) => t.app.get(NotificationService).enqueue({ tx }, input));

/** An order mail for a customer, which also makes the in-app item `order.completed`. */
const orderMail = (customerId: number, orderId: string): NotificationInput => ({
  event: 'order.completed',
  recipient: { type: 'customer', id: customerId },
  channel: 'email',
  variables: { customerName: 'Dana', orderId, service: 'Vodafone UK iPhone Unlock', device: 'iPhone 15' },
  dedupeKey: `order-${orderId}-completed:email`,
});

/** Makes items for a customer directly (one transaction), as many as asked. */
async function addItems(customerId: number, count: number, from = 1): Promise<void> {
  await t.app.get(DbService).runInTransaction(async ({ tx }) => {
    for (let n = from; n < from + count; n++) {
      await t.app.get(NotificationInbox).add(tx, {
        recipient: { type: 'customer', id: customerId },
        event: 'order.completed',
        variables: { orderId: String(n), service: 'Unlock' },
        occurrence: `replay-${n}`,
      });
    }
  });
}

/** Rings `recount` for every type: a barrier frame (`unread.changed`) behind anything already written to the streams. */
const barrier = () =>
  t.app.get(RealtimePublisher).publish('inbox', 'recount', { types: ['staff', 'client', 'customer'] });

beforeAll(async () => {
  await testDb();
  t = await createTestApp({ clock, env: { BULL_PREFIX: prefix } });
  base = await listen(t);
  await eventually(() => (t.app.get(RealtimeHub).listening ? true : undefined));
  listener = new Redis(t.config.redis.cacheUrl, { lazyConnect: true, maxRetriesPerRequest: null });
  listener.on('error', () => undefined);
  listener.on('message', (_channel: string, message: string) => doorbells.push(message));
  await listener.subscribe(t.app.get(RealtimePublisher).channel);
});
afterAll(async () => {
  listener.disconnect();
  await deleteBullKeys(t.app.get(RedisService).queue, prefix);
  await t.close();
  await resetDb();
  await closeTestDb();
});
beforeEach(async () => {
  await resetDb();
  await seedDefaultTemplates((await testDb()).db);
  await clearIdentityCaches(t);
  await clearStreamLimits(t);
  doorbells.length = 0;
});
afterEach(async () => {
  for (const opened of open.splice(0)) opened.close();
  await eventually(() => (t.app.get(RealtimeHub).size === 0 ? true : undefined));
});

describe('an event item', () => {
  it("reaches the owner's streams in under a second, in each stream's language, with the count", async () => {
    const { db } = await testDb();
    const customerId = await insertCustomer(db, { name: 'Dana', locale: 'ar' });
    const { headers } = await sessionHeaders({ type: 'customer', id: customerId });
    const english = await started(await stream('/store/v1/me/stream?locale=en', headers));
    const saved = await started(await stream('/store/v1/me/stream', headers));
    const startedAt = performance.now();
    await enqueue(orderMail(customerId, '4021'));
    const frame = await english.next('notification.created');
    expect(performance.now() - startedAt).toBeLessThan(1000);
    expect(frame.id).toMatch(/^i\d+$/);
    expect(frame.data).toMatchObject({
      unread: 1,
      live: true,
      item: {
        id: Number(frame.id!.slice(1)),
        category: 'order',
        title: 'Order 4021 completed',
        body: 'Your order for Vodafone UK iPhone Unlock is complete.',
        link: '/account/orders',
        locale: 'en',
        readAt: null,
        campaignId: null,
        event: 'order.completed',
      },
    });
    // Without `?locale=` the stream speaks the customer's saved language.
    expect((await saved.next('notification.created')).data).toMatchObject({
      item: { title: 'تم تنفيذ طلبك 4021', locale: 'ar' },
      unread: 1,
    });
    // The doorbell carried ids only: no text, no name, no email address.
    const rung = await eventually(() => doorbells.find((text) => text.includes('"op":"created"')));
    expect(JSON.parse(rung)).toMatchObject({
      v: 1,
      topic: 'inbox',
      op: 'created',
      type: 'customer',
      ids: [customerId],
    });
    expect(rung).not.toMatch(/Order|Dana|Vodafone|@|تم/);
  });

  it('rings nothing for a rolled-back transaction', async () => {
    const { db } = await testDb();
    const customerId = await insertCustomer(db);
    const { headers } = await sessionHeaders({ type: 'customer', id: customerId });
    const s = await started(await stream('/store/v1/me/stream', headers));
    await t.app
      .get(DbService)
      .runInTransaction(async ({ tx }) => {
        await t.app.get(NotificationService).enqueue({ tx }, orderMail(customerId, '1'));
        throw new Error('the use case failed after the item');
      })
      .catch(() => undefined);
    await enqueue(orderMail(customerId, '2'));
    const frame = await s.next('notification.created');
    expect(frame.data.item.title).toBe('Order 2 completed');
    expect(frame.data.unread).toBe(1);
    expect(doorbells.filter((text) => text.includes('"op":"created"'))).toHaveLength(1);
  });

  it('keeps each transaction its own onCommit list when the pool makes transactions wait for a connection', async () => {
    const pool = createPool(TEST_DATABASE_URL, 1);
    const db = createDrizzle(pool);
    try {
      const ran: string[] = [];
      const work = (name: string, fail: boolean) =>
        runInTransaction(db, async ({ tx }) => {
          await tx.execute(sql`select pg_sleep(0.01)`);
          onCommit(() => void ran.push(name));
          if (fail) throw new Error(name);
        }).catch(() => undefined);
      await Promise.all([work('a', false), work('b', true), work('c', false), work('d', true), work('e', false)]);
      expect(ran.sort()).toEqual(['a', 'c', 'e']);
    } finally {
      await pool.end();
    }
  });

  it('never reaches another customer, a merchant or a staff member with the same id', async () => {
    const { db } = await testDb();
    const ownerId = await insertCustomer(db);
    const otherCustomer = await insertCustomer(db);
    const merchantId = await insertMerchant(db);
    const staffId = await insertStaff(db, await insertRole(db, ['orders:read']));
    expect([ownerId, merchantId, staffId]).toEqual([1, 1, 1]);
    const owner = await started(
      await stream('/store/v1/me/stream', (await sessionHeaders({ type: 'customer', id: ownerId })).headers),
    );
    const others = [
      await started(
        await stream('/store/v1/me/stream', (await sessionHeaders({ type: 'customer', id: otherCustomer })).headers),
      ),
      await started(await stream('/client/stream', (await sessionHeaders({ type: 'client', id: merchantId })).headers)),
      await started(await stream('/admin/stream', (await sessionHeaders({ type: 'staff', id: staffId })).headers)),
    ];
    await enqueue(orderMail(ownerId, '77'));
    expect((await owner.next('notification.created')).data.item.title).toBe('Order 77 completed');
    await barrier();
    for (const s of others) {
      // The barrier's count is the first frame after the start: nothing of the owner came before it.
      expect(await s.next()).toMatchObject({ event: 'unread.changed', data: { unread: 0 } });
    }
    expect(await owner.next()).toMatchObject({ event: 'unread.changed', data: { unread: 1 } });
  });
});

describe('reads', () => {
  it("reach the owner's other streams with the fresh count, one item and then all", async () => {
    const { db } = await testDb();
    const customerId = await insertCustomer(db);
    const phone = await sessionHeaders({ type: 'customer', id: customerId });
    const laptop = await sessionHeaders({ type: 'customer', id: customerId });
    const a = await started(await stream('/store/v1/me/stream', phone.headers));
    const b = await started(await stream('/store/v1/me/stream', laptop.headers));
    await enqueue(orderMail(customerId, '1'));
    await enqueue(orderMail(customerId, '2'));
    const first = (await b.next('notification.created')).data.item.id as number;
    const second = (await b.next('notification.created')).data.item.id as number;
    const read = await t.app.inject({
      method: 'POST',
      url: `/store/v1/me/notifications/${first}/read`,
      headers: phone.mutation,
    });
    expect(read.statusCode).toBe(204);
    expect(await b.next('notification.read')).toMatchObject({
      data: { ids: [first], all: false, upToId: null, unread: 1 },
    });
    // A second click changes nothing and rings nothing.
    await t.app.inject({ method: 'POST', url: `/store/v1/me/notifications/${first}/read`, headers: phone.mutation });
    const all = await t.app.inject({
      method: 'POST',
      url: '/store/v1/me/notifications/read-all',
      headers: { ...phone.mutation, 'content-type': 'application/json' },
      payload: JSON.stringify({ upToId: second }),
    });
    expect(JSON.parse(all.body)).toEqual({ updated: 1 });
    expect(await b.next('notification.read')).toMatchObject({
      data: { ids: [], all: true, upToId: second, unread: 0 },
    });
    expect(await a.next('notification.read')).toMatchObject({ data: { ids: [first] } });
    expect(await a.next('notification.read')).toMatchObject({ data: { all: true } });
    expect(doorbells.filter((text) => text.includes('"op":"read"'))).toHaveLength(2);
  });
});

describe('campaigns', () => {
  let admin: AdminApi;
  beforeEach(async () => {
    admin = await adminWith(t, ['*'], { name: 'Rami K.' });
  });

  /** A queued in-app campaign to the customers with an account. */
  async function campaign(): Promise<number> {
    const draft = await createDraft(admin, { channels: ['in_app'], audience: { customers: { hasAccount: true } } });
    expect((await sendNow(admin, draft.id)).status).toBe(202);
    return draft.id;
  }

  it('reach every connected recipient once through the fan-out, and a repeated chunk sends nothing', async () => {
    const { db } = await testDb();
    const ids = [
      await insertCustomer(db, { name: 'Dana' }),
      await insertCustomer(db, { name: 'Omar', locale: 'ar' }),
      await insertCustomer(db, { name: 'Lina' }),
    ];
    const offline = await insertCustomer(db);
    const streams = [];
    for (const id of ids) {
      streams.push(
        await started(await stream('/store/v1/me/stream', (await sessionHeaders({ type: 'customer', id })).headers)),
      );
    }
    const id = await campaign();
    fanOutWith(t, { chunkSize: 2, timeBudgetMs: 60_000 });
    await fanOutAll(t, id);
    const frames = await Promise.all(streams.map((s) => s.next('notification.created')));
    expect(frames.map((frame) => frame.data.item.title)).toEqual([
      'Maintenance for Dana',
      'صيانة لـ Omar',
      'Maintenance for Lina',
    ]);
    for (const frame of frames) expect(frame.data).toMatchObject({ unread: 1, live: true, item: { campaignId: id } });
    const chunkBells = doorbells.filter((text) => text.includes(`"campaignId":${id}`));
    expect(chunkBells).toHaveLength(2);
    expect(chunkBells.flatMap((text) => (JSON.parse(text) as { ids: number[] }).ids).sort()).toEqual(
      [...ids, offline].sort(),
    );
    // The same chunks again (a crash before the cursor moved): the items exist, nothing new is made or rung.
    await db.execute(sql`update notification_campaigns set status = 'queued', fanout_cursor = null where id = ${id}`);
    await fanOutAll(t, id);
    expect(doorbells.filter((text) => text.includes(`"campaignId":${id}`))).toHaveLength(2);
    await barrier();
    for (const s of streams) expect(await s.next()).toMatchObject({ event: 'unread.changed', data: { unread: 1 } });
  });

  it('a cancel recounts the connected bells: the items already made hide', async () => {
    const { db } = await testDb();
    const first = await insertCustomer(db);
    await insertCustomer(db);
    const s = await started(
      await stream('/store/v1/me/stream', (await sessionHeaders({ type: 'customer', id: first })).headers),
    );
    const id = await campaign();
    // One chunk, then the time budget is over: the campaign is still sending.
    fanOutWith(t, { chunkSize: 1, timeBudgetMs: 0 });
    expect(await t.app.get(CampaignFanOut).run(id)).toMatchObject({ outcome: 'continued' });
    expect((await s.next('notification.created')).data.unread).toBe(1);
    expect((await admin.post(`/admin/notification-campaigns/${id}/cancel`)).status).toBe(200);
    expect(await s.next('unread.changed')).toMatchObject({ data: { unread: 0 } });
  });
});

describe('a reconnect', () => {
  it('replays exactly the missed items with live false, by Last-Event-ID and by ?cursor=, then the count', async () => {
    const { db } = await testDb();
    const customerId = await insertCustomer(db);
    const { headers } = await sessionHeaders({ type: 'customer', id: customerId });
    const s = await started(await stream('/store/v1/me/stream', headers));
    await enqueue(orderMail(customerId, '1'));
    const seen = await s.next('notification.created');
    s.close();
    await eventually(() => (t.app.get(RealtimeHub).size === 0 ? true : undefined));
    await addItems(customerId, 3, 2);
    const resumes: Array<{ path: string; extra: Record<string, string> }> = [
      { path: '/store/v1/me/stream', extra: { 'last-event-id': seen.id! } },
      { path: `/store/v1/me/stream?cursor=${seen.id!}`, extra: {} },
    ];
    for (const { path, extra } of resumes) {
      const again = await stream(path, { ...headers, ...extra });
      expect(await again.next()).toMatchObject({ event: 'ready', data: { resumed: true } });
      const replayed = [await again.next(), await again.next(), await again.next()];
      expect(replayed.map((frame) => frame.event)).toEqual(Array(3).fill('notification.created'));
      expect(replayed.map((frame) => frame.data.item.title)).toEqual([
        'Order 2 completed',
        'Order 3 completed',
        'Order 4 completed',
      ]);
      for (const frame of replayed) expect(frame.data).toMatchObject({ live: false, unread: 4 });
      expect(replayed.map((frame) => Number(frame.id!.slice(1)))).toEqual(
        replayed.map((frame) => frame.data.item.id as number),
      );
      expect(await again.next()).toMatchObject({ event: 'unread.changed', data: { unread: 4 } });
      again.close();
      await eventually(() => (t.app.get(RealtimeHub).size === 0 ? true : undefined));
    }
  });

  it('sends resync instead of 51 missed items, and goes on from the newest id', async () => {
    const { db } = await testDb();
    const customerId = await insertCustomer(db);
    const { headers } = await sessionHeaders({ type: 'customer', id: customerId });
    await addItems(customerId, 1);
    const firstId = (await db.execute<{ id: number }>(sql`select max(id)::int as id from notification_inbox`)).rows[0]!
      .id;
    await addItems(customerId, 51, 2);
    const s = await stream('/store/v1/me/stream', { ...headers, 'last-event-id': `i${firstId}` });
    expect(await s.next()).toMatchObject({ event: 'ready', data: { resumed: true } });
    expect(await s.next()).toMatchObject({ event: 'resync', data: { topics: ['inbox'] } });
    expect(await s.next()).toMatchObject({ event: 'unread.changed', data: { unread: 52 } });
    await enqueue(orderMail(customerId, '900'));
    const next = await s.next('notification.created');
    expect(next.data.item.title).toBe('Order 900 completed');
    expect(next.id).toBe(`i${next.data.item.id as number}`);
  });

  it('treats a garbage cursor as a fresh start', async () => {
    const { db } = await testDb();
    const customerId = await insertCustomer(db);
    await addItems(customerId, 2);
    const { headers } = await sessionHeaders({ type: 'customer', id: customerId });
    const s = await stream('/store/v1/me/stream?cursor=garbage-x9', { ...headers, 'last-event-id': 'not-a-cursor' });
    expect(await s.next()).toMatchObject({ event: 'ready', data: { resumed: false } });
    expect(await s.next()).toMatchObject({ event: 'unread.changed', data: { unread: 2 } });
  });
});

describe('a Redis outage of the subscriber', () => {
  it('sends resync to every stream once the subscriber is back', async () => {
    const real = new URL(
      parseEnv({ NODE_ENV: 'test', DATABASE_URL_TEST: TEST_DATABASE_URL, ...testInstanceEnv() }).redis.cacheUrl,
    );
    const forwarder = await createForwarder({ host: real.hostname, port: Number(real.port || 6379) });
    await forwarder.start();
    const flaky = await createTestApp({
      env: { BULL_PREFIX: prefix, REDIS_CACHE_URL_TEST: `redis://127.0.0.1:${forwarder.port}${real.pathname}` },
    });
    try {
      const flakyBase = await listen(flaky);
      await eventually(() => (flaky.app.get(RealtimeHub).listening ? true : undefined));
      const { db } = await testDb();
      const customerId = await insertCustomer(db);
      await clearStreamLimits(flaky);
      const s = await started(
        await stream(
          '/store/v1/me/stream',
          (await sessionHeaders({ type: 'customer', id: customerId }, flaky)).headers,
          flakyBase,
        ),
      );
      await forwarder.stop();
      await eventually(() => (flaky.app.get(RealtimeHub).listening ? undefined : true));
      await forwarder.start();
      expect(await s.next('resync', 15_000)).toMatchObject({ data: { topics: ['inbox'] } });
      expect(s.isEnded).toBe(false);
      s.close();
      await eventually(() => (flaky.app.get(RealtimeHub).size === 0 ? true : undefined));
    } finally {
      await flaky.close();
      await forwarder.stop();
    }
  });
});
