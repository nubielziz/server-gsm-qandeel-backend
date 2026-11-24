// The seed of feature 17 (`bun run db:seed`): the demo's 15 tickets with their threads and its 8 reply templates, written as the frontend
// mocks show them, idempotent, and read back through the real routes. Needs the frontend checkout.
import { afterAll, beforeAll, beforeEach, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { existsSync } from 'node:fs';
import { eq, sql } from 'drizzle-orm';
import { parseEnv } from '@src/config';
import { schema as s } from '@src/infra/db';
import { demoStatePath, demoRows, loadDemoState } from '../../../scripts/seed/demo-state';
import { seedIdentity } from '../../../scripts/seed/identity';
import { seedSupport } from '../../../scripts/seed/support';
import { type AdminApi, adminWith } from '../../support/admin-api';
import { ensureRetailGroup } from '../../support/accounts';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches } from '../../support/auth';
import { TEST_DATABASE_URL, closeTestDb, resetDb, testDb } from '../../support/db';
import { testInstanceEnv } from '../../support/env';

setDefaultTimeout(60_000);

const config = parseEnv({ NODE_ENV: 'test', DATABASE_URL_TEST: TEST_DATABASE_URL, ...testInstanceEnv() });
const frontendPresent = existsSync(demoStatePath());
let t: TestApp;
let staff: AdminApi;

beforeAll(async () => {
  t = await createTestApp();
});
beforeEach(async () => {
  await resetDb();
  await clearIdentityCaches(t);
});
afterAll(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await t.close();
  await closeTestDb();
});

async function seed() {
  const { db } = await testDb();
  const demo = await loadDemoState();
  return db.transaction(async (tx) => ({
    identity: await seedIdentity(tx, demo, config),
    support: await seedSupport(tx, demo),
  }));
}
const reportOf = (reports: Array<{ table: string }>, table: string) => reports.find((report) => report.table === table);

describe.skipIf(!frontendPresent)('the support seed', () => {
  it('writes the demo’s tickets, messages and templates with their ids, and nothing twice', async () => {
    const demo = await loadDemoState();
    const tickets = demoRows<{ msgs: unknown[] }>(demo, 'tickets');
    const messages = tickets.reduce((sum, ticket) => sum + ticket.msgs.length, 0);
    const first = await seed();
    expect(reportOf(first.support, 'support_tickets')).toMatchObject({ inserted: 15, existing: 0 });
    expect(reportOf(first.support, 'ticket_messages')).toMatchObject({ inserted: messages, existing: 0 });
    expect(reportOf(first.support, 'reply_templates')).toMatchObject({ inserted: 8, existing: 0 });
    const again = (await seed()).support;
    expect(reportOf(again, 'support_tickets')).toMatchObject({ inserted: 0, existing: 15 });
    expect(reportOf(again, 'ticket_messages')).toMatchObject({ inserted: 0 });
    expect(reportOf(again, 'reply_templates')).toMatchObject({ inserted: 0, existing: 8 });

    const { db } = await testDb();
    const [ticket] = await db.select().from(s.supportTickets).where(eq(s.supportTickets.id, 4202));
    expect(ticket).toMatchObject({
      number: 'T-4202',
      subject: 'Phone still locked after unlock (SF-20471)',
      channel: 'web',
      requesterType: 'account',
      requesterId: 128,
      category: 'failed_unlock',
      priority: 'high',
      status: 'open',
      assigneeId: 2,
      csatScore: null,
    });
    // A ticket of a retail account gets a token nobody can guess; one of a merchant rank has none.
    expect(ticket!.token).toMatch(/^[A-Za-z0-9_-]{22}$/);
    const [merchantTicket] = await db.select().from(s.supportTickets).where(eq(s.supportTickets.id, 4214));
    expect(merchantTicket).toMatchObject({ requesterType: 'account', requesterId: 2, token: null });
    // The next ticket takes the next number.
    const next = await db.execute<{ id: string }>(
      sql`select nextval(pg_get_serial_sequence('support_tickets', 'id')) as id`,
    );
    expect(Number(next.rows[0]!.id)).toBe(4216);
  });

  it('shows through the inbox what the mock shows: the statuses in the console’s words, the threads, the late ones, the templates', async () => {
    await seed();
    const { db } = await testDb();
    // The shop accounts are seeded with the customers of feature 14b: the demo's customer 28 is the retail account 128 (the numbers of the
    // console's mocks), made here to see the join.
    await db
      .insert(s.clients)
      .overridingSystemValue()
      .values({
        id: 128,
        email: 'victor@mail.example',
        name: 'Victor Hale',
        groupId: await ensureRetailGroup(db),
        hasAccount: false,
        status: 'active',
        referralCode: 'REF-128',
      });
    staff = await adminWith(t, ['support:*'], { name: 'Rami K.' });

    const demo = await loadDemoState();
    const demoTickets = demoRows<{ status: string }>(demo, 'tickets');
    for (const status of ['new', 'open', 'pending', 'resolved']) {
      const res = await staff.get(`/admin/support-tickets?status=${status}&_end=100`);
      expect(res.total, status).toBe(demoTickets.filter((ticket) => ticket.status === status).length);
    }
    const detail = await staff.get('/admin/support-tickets/4202');
    expect(detail.status).toBe(200);
    expect(detail.body).toMatchObject({
      number: 'T-4202',
      status: 'open',
      // Decision 047: the support role of this test does not hold clients:read, so the address comes masked.
      requester: { name: 'Victor Hale', email: 'vi•••@mail.example', rankKind: 'retail' },
      assignee: { id: 2, name: 'Lina S.' },
      replyChannels: ['email'],
    });
    expect(
      detail.body.messages.map((message: { authorType: string; authorName: string }) => [
        message.authorType,
        message.authorName,
      ]),
    ).toEqual([
      ['account', 'Victor Hale'],
      ['staff', 'Lina S.'],
      ['account', 'Victor Hale'],
    ]);
    // The customer spoke last on this open ticket, so its reply is awaited.
    expect(detail.body.slaDueAt).not.toBeNull();

    const resolved = (await staff.get('/admin/support-tickets?status=resolved&_end=100')).body as Array<{
      resolvedAt: string | null;
      slaDueAt: string | null;
    }>;
    expect(resolved.every((row) => row.resolvedAt !== null && row.slaDueAt === null)).toBe(true);
    // The retired rating is neither seeded nor sent: the column stays empty and the row has no such field.
    expect(resolved.length).toBeGreaterThan(0);
    expect(resolved.every((row) => !('csatScore' in row))).toBe(true);

    const templates = await staff.get('/admin/reply-templates?_end=200');
    expect(templates.total).toBe(8);
    expect(templates.body.find((row: { id: number }) => row.id === 1)).toMatchObject({
      title: 'Order is in progress',
      category: 'delay',
      shortcut: '',
      createdBy: 1,
    });
    expect(templates.body.find((row: { id: number }) => row.id === 1).body).toContain('{{name}}');
  });
});
