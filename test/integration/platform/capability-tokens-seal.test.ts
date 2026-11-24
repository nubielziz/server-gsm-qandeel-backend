// The one-off seal passes through the real queues (decision 054): migration capability_tokens_seal writes one outbox event per owning module,
// the relay turns each into its module's job on the maintenance queue, and the rows stored as issued get their keyed hash and encrypted copy,
// with a job_runs row per pass. Real Postgres and Redis (a private BullMQ prefix); the waits are polls for the effect.
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { inArray, sql } from 'drizzle-orm';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { schema as s } from '@src/infra/db';
import { QueueWorkersModule } from '@src/infra/queues';
import { RedisService } from '@src/infra/redis';
import { CHECKOUT_TOKENS_SEAL_EVENT, CHECKOUT_TOKENS_SEAL_JOB, CheckoutTokenSealModule } from '@src/modules/customers';
import { TRACKING_TOKENS_SEAL_EVENT, TRACKING_TOKENS_SEAL_JOB, TrackingTokenSealModule } from '@src/modules/orders';
import { OutboxRelayModule } from '@src/modules/platform';
import { TICKET_TOKENS_SEAL_EVENT, TICKET_TOKENS_SEAL_JOB, TicketTokenSealModule } from '@src/modules/support';
import { type TestApp, createTestApp } from '../../support/app';
import { tokenHashOf } from '../../support/capability-tokens';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { insertCheckout } from '../../support/growth';
import { eventually } from '../../support/infra';
import { insertOrderRow } from '../../support/orders';
import { deleteBullKeys, testBullPrefix } from '../../support/queues';
import { storefrontWorld } from '../../support/storefront';
import { insertCustomer, insertSupportTicket } from '../../support/support';

setDefaultTimeout(60_000);

const prefix = testBullPrefix();
let t: TestApp;

beforeAll(async () => {
  await testDb();
  t = await createTestApp({
    imports: [
      QueueWorkersModule,
      OutboxRelayModule,
      CheckoutTokenSealModule,
      TrackingTokenSealModule,
      TicketTokenSealModule,
    ],
    env: { BULL_PREFIX: prefix },
  });
  await resetDb();
});
afterAll(async () => {
  await resetDb();
  await deleteBullKeys(t.app.get(RedisService, { strict: false }).queue, prefix);
  await t.close();
  await closeTestDb();
});

describe('the seal passes of the link tokens', () => {
  it('the migration asks each owning module for its seal pass', async () => {
    const { db } = await testDb();
    const world = await storefrontWorld(db);
    const checkout = await insertCheckout(t, db, {
      serviceId: world.icloud.serviceId,
      createdAt: new Date('2026-11-01T10:00:00Z'),
    });
    const customer = await insertCustomer(db);
    const order = await insertOrderRow(db, {
      serviceId: world.icloud.serviceId,
      customerId: customer.id,
      source: 'store',
      publicToken: 'Old7kq2Zp9Xw4Ld1Hn6Rb3',
    });
    const ticket = await insertSupportTicket(db, { requesterId: customer.id });

    const file = readdirSync(join(import.meta.dir, '../../../drizzle')).find((name) =>
      name.endsWith('_capability_tokens_seal.sql'),
    );
    expect(file).toBeDefined();
    await db.execute(sql.raw(readFileSync(join(import.meta.dir, '../../../drizzle', file!), 'utf8')));
    const events = await db
      .select()
      .from(s.outboxEvents)
      .where(
        inArray(s.outboxEvents.type, [
          CHECKOUT_TOKENS_SEAL_EVENT,
          TRACKING_TOKENS_SEAL_EVENT,
          TICKET_TOKENS_SEAL_EVENT,
        ]),
      );
    expect(events.map((event) => event.type).sort()).toEqual(
      [CHECKOUT_TOKENS_SEAL_EVENT, TRACKING_TOKENS_SEAL_EVENT, TICKET_TOKENS_SEAL_EVENT].sort(),
    );

    const runs = await eventually(async () => {
      const rows = await db
        .select()
        .from(s.jobRuns)
        .where(inArray(s.jobRuns.job, [CHECKOUT_TOKENS_SEAL_JOB, TRACKING_TOKENS_SEAL_JOB, TICKET_TOKENS_SEAL_JOB]));
      return rows.length === 3 && rows.every((row) => row.status === 'succeeded') ? rows : undefined;
    }, 30_000);
    expect(runs.every((run) => run.trigger === 'event' && run.processed === 1)).toBe(true);

    const [session] = await db.select().from(s.checkoutSessions);
    expect(session).toMatchObject({ token: null, tokenHash: tokenHashOf(t, 'checkout', checkout.token) });
    const [orderRow] = await db.select().from(s.orders);
    expect(orderRow).toMatchObject({
      id: order.id,
      publicToken: null,
      publicTokenHash: tokenHashOf(t, 'tracking', 'Old7kq2Zp9Xw4Ld1Hn6Rb3'),
    });
    const [ticketRow] = await db.select().from(s.supportTickets);
    expect(ticketRow).toMatchObject({ id: ticket.id, token: null, tokenHash: tokenHashOf(t, 'ticket', ticket.token!) });
  });
});
