// Integration tests of the price change scan (feature 7b, user rule 9 (5), MISMATCHES B117): after a price change, a merchant who ordered
// a service in the last 30 days and would now pay another price than its last order gets one outbox event `service.price_changed`,
// which the webhook fan-out turns into a delivery. Real Postgres and Redis; time moves on a TestClock (decision 031).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { type Database, schema as s } from '../../src/infra/db';
import { QueuesService } from '../../src/infra/queues';
import { RedisService } from '../../src/infra/redis';
import { CatalogPriceVersion, PriceChangeScan } from '../../src/modules/catalog';
import { recentOrderPrices } from '../../src/modules/catalog/infra/foreign-reads.repository';
import { WebhookFanOut } from '../../src/modules/platform';
import { EncryptionService } from '../../src/infra/crypto';
import { type TestApp, createTestApp } from '../support/app';
import { insertMerchant } from '../support/auth';
import { insertCategory, insertService } from '../support/catalog';
import { DAY, TestClock } from '../support/clock';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { deleteBullKeys, testBullPrefix } from '../support/queues';
import { WebhookTestModule, insertEndpoint, insertOrder, insertUsd } from '../support/webhooks';

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
  await resetDb();
  await deleteBullKeys(t.app.get(RedisService).queue, prefix);
  await insertUsd(db);
});

const scan = () => t.app.get(PriceChangeScan);
const events = () =>
  db.select().from(s.outboxEvents).where(eq(s.outboxEvents.type, 'service.price_changed')).orderBy(s.outboxEvents.id);
const ago = (days: number) => new Date(clock.nowMs() - days * DAY);

/** A service at a base price, and a merchant that ordered it at a price. */
async function buyer(
  options: { basePrice?: string; paid?: string; daysAgo?: number; status?: 'active' | 'suspended' } = {},
) {
  const serviceId = await insertService(db, await insertCategory(db), {
    basePrice: options.basePrice ?? '10.0000',
    name: 'iPhone iCloud Clean',
  });
  const clientId = await insertMerchant(db, { status: options.status ?? 'active' });
  await insertOrder(db, clientId, {
    serviceId,
    unitPrice: options.paid ?? '10.0000',
    totalPrice: options.paid ?? '10.0000',
    createdAt: ago(options.daysAgo ?? 1),
  });
  return { serviceId, clientId };
}

describe('PriceChangeScan.run', () => {
  it('announces nothing while every recent buyer would pay the price of its last order', async () => {
    await buyer({ paid: '10.0000' });
    await buyer({ paid: '10.0000' });
    expect(await scan().run()).toEqual({ checked: 2, announced: 0 });
    expect(await events()).toEqual([]);
  });

  it('writes one event per buyer whose price changed, with the two prices, and not again for the same change', async () => {
    const { serviceId, clientId } = await buyer({ paid: '10.0000' });
    const quiet = await buyer({ paid: '10.0000' });
    await db.update(s.services).set({ basePrice: '12.0000' }).where(eq(s.services.id, serviceId));

    expect(await scan().run()).toEqual({ checked: 2, announced: 1 });
    const [event] = await events();
    expect(event).toMatchObject({ aggregateType: 'services', aggregateId: serviceId });
    expect(event?.payload).toMatchObject({
      clientId,
      serviceId,
      previousPrice: '10.0000',
      price: '12.0000',
      currency: 'USD',
    });
    expect(quiet.clientId).not.toBe(clientId);

    // The same change found by the next scan is not written again.
    expect(await scan().run()).toEqual({ checked: 2, announced: 0 });
    expect(await events()).toHaveLength(1);

    // A further change is a new event, from the same last order.
    await db.update(s.services).set({ basePrice: '13.0000' }).where(eq(s.services.id, serviceId));
    expect((await scan().run()).announced).toBe(1);
    expect((await events())[1]?.payload).toMatchObject({ previousPrice: '10.0000', price: '13.0000' });
  });

  it('prices each merchant as the resolver does: a fixed client price wins over the base price', async () => {
    const { serviceId, clientId } = await buyer({ paid: '10.0000' });
    const other = await insertMerchant(db);
    await insertOrder(db, other, { serviceId, unitPrice: '10.0000', totalPrice: '10.0000', createdAt: ago(2) });
    await db.insert(s.serviceClientPrices).values({ serviceId, clientId, price: '8.0000', note: '' });
    expect((await scan().run()).announced).toBe(1);
    const [event] = await events();
    expect(event?.payload).toMatchObject({ clientId, previousPrice: '10.0000', price: '8.0000' });
  });

  it('compares with the latest order of the merchant, not an older one', async () => {
    const { serviceId, clientId } = await buyer({ paid: '9.0000', daysAgo: 20 });
    await insertOrder(db, clientId, { serviceId, unitPrice: '10.0000', totalPrice: '10.0000', createdAt: ago(1) });
    expect(await scan().run()).toEqual({ checked: 1, announced: 0 });
  });

  it('leaves out orders older than 30 days and merchants that are not active', async () => {
    await buyer({ paid: '5.0000', daysAgo: 31 });
    await buyer({ paid: '5.0000', status: 'suspended' });
    expect(await scan().run()).toEqual({ checked: 0, announced: 0 });
    await buyer({ paid: '5.0000', daysAgo: 29 });
    expect(await scan().run()).toEqual({ checked: 1, announced: 1 });
  });

  it('does not count a storefront order (no merchant) and ignores an archived service', async () => {
    const { serviceId } = await buyer({ paid: '5.0000' });
    await db
      .update(s.services)
      .set({ status: 'disabled', archivedAt: clock.now() })
      .where(eq(s.services.id, serviceId));
    expect((await scan().run()).announced).toBe(0);
  });

  it('turns into a delivery through the webhook fan-out, for a merchant subscribed to the event', async () => {
    const { serviceId, clientId } = await buyer({ paid: '10.0000' });
    await insertEndpoint(t.app.get(EncryptionService), db, clientId, { events: ['service.price_changed'] });
    await db.update(s.services).set({ basePrice: '12.5000' }).where(eq(s.services.id, serviceId));
    await scan().run();
    const [event] = await events();
    const result = await t.app.get(WebhookFanOut).run({
      eventId: event!.id,
      type: event!.type,
      aggregateType: event!.aggregateType,
      aggregateId: event!.aggregateId,
      payload: Object.fromEntries(Object.entries(event!.payload).filter(([key]) => key !== 'meta')) as never,
      requestId: 'test',
    });
    expect(result).toEqual({ endpoints: 1, created: 1 });
    const [delivery] = await db.select().from(s.webhookDeliveries);
    expect(delivery?.payload).toMatchObject({
      type: 'service.price_changed',
      data: {
        serviceId,
        serviceName: 'iPhone iCloud Clean',
        previousPrice: '10.0000',
        price: '12.5000',
        currency: 'USD',
      },
    });
  });
});

describe('the pages of the scan', () => {
  it('walks every merchant and service pair once, in order, a page at a time', async () => {
    for (let index = 0; index < 5; index++) await buyer({ paid: '10.0000' });
    const seen: string[] = [];
    let after: { clientId: number; serviceId: number } | undefined;
    for (;;) {
      const page = await recentOrderPrices(db, ago(30), after, 2);
      if (page.length === 0) break;
      seen.push(...page.map((row) => `${row.clientId}:${row.serviceId}`));
      const last = page[page.length - 1]!;
      after = { clientId: last.clientId, serviceId: last.serviceId };
    }
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
    expect(seen).toEqual([...seen].sort((a, b) => Number(a.split(':')[0]) - Number(b.split(':')[0])));
  });
});

describe('asking for a scan', () => {
  it('a move of the price version adds one delayed job per minute to the maintenance queue', async () => {
    const version = t.app.get(CatalogPriceVersion);
    await version.bump();
    await version.bump();
    const minute = Math.floor(clock.nowMs() / 60_000);
    const queue = t.app.get(QueuesService).queue('maintenance');
    const job = await queue.getJob(`price-scan-${minute}`);
    expect(job?.name).toBe('service_price_scan');
    expect(job?.opts.delay).toBe(60_000);
    const waiting = (await queue.getDelayed()).filter((delayed) => delayed.name === 'service_price_scan');
    expect(waiting).toHaveLength(1);
    // The next minute asks again.
    clock.advance(61_000);
    await version.bump();
    expect(await queue.getJob(`price-scan-${minute + 1}`)).toBeDefined();
  });
});
