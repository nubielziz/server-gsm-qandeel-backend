// The support seed (feature 28, slice B2): the demo's tickets carry what the live chat reads. Staff and the requester see the right unread
// marks through the real routes, public staff messages have a delivery channel, a merchant's thread opens in the portal, and one customer's
// follow-up carries a PDF that downloads. Runs the whole seed once, like the other seed tests.
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { existsSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { demoNumericId, demoRows, demoStatePath, loadDemoState } from '../../scripts/seed/demo-state';
import { runSeed } from '../../scripts/seed/run';
import { schema as s } from '../../src/infra/db';
import { type AdminApi, adminWith } from '../support/admin-api';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches } from '../support/auth';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { merchantSession } from '../support/notifications';
import { customerSession } from '../support/support-accounts';

setDefaultTimeout(180_000);

const frontendPresent = existsSync(demoStatePath());
let t: TestApp;
let staff: AdminApi;
let demoTickets: Array<{
  id: string;
  who: { type: 'customer' | 'client'; id: string };
  status: string;
  msgs: Array<{ by: string }>;
}> = [];

beforeAll(async () => {
  if (!frontendPresent) return;
  t = await createTestApp();
  await resetDb();
  await clearIdentityCaches(t);
  const demo = await loadDemoState();
  demoTickets = demoRows(demo, 'tickets');
  await runSeed((await testDb()).db, demo, t.config);
  staff = await adminWith(t, ['support:*']);
});
afterAll(async () => {
  if (!frontendPresent) return;
  await resetDb();
  await clearIdentityCaches(t);
  await t.close();
  await closeTestDb();
});

describe.skipIf(!frontendPresent)('the support seed of the live chat', () => {
  it('gives every ticket the newest message of each side, and a delivery channel to each public staff message', async () => {
    const { db } = await testDb();
    const tickets = await db.select().from(s.supportTickets);
    const messages = await db.select().from(s.ticketMessages);
    expect(tickets).toHaveLength(demoTickets.length);
    for (const ticket of tickets) {
      const thread = messages.filter((message) => message.ticketId === ticket.id);
      const requester = thread.filter((message) => message.authorType === ticket.requesterType);
      const replies = thread.filter((message) => message.authorType === 'staff' && !message.isInternal);
      expect(ticket.lastRequesterMessageId, ticket.number).toBe(requester.at(-1)?.id ?? null);
      expect(ticket.lastStaffMessageId, ticket.number).toBe(replies.at(-1)?.id ?? null);
      expect(ticket.replyMailedMessageId, ticket.number).toBe(replies.at(-1)?.id ?? null);
      expect(ticket.replyMailDueAt).toBeNull();
    }
    for (const message of messages) {
      const isReply = message.authorType === 'staff' && !message.isInternal;
      expect(message.notifyChannel, String(message.id)).toBe(isReply ? 'email' : null);
    }
  });

  it('shows staff the new tickets as unread and the picked-up ones as read, through the inbox', async () => {
    const list = await staff.get('/admin/support-tickets?_end=100');
    expect(list.status).toBe(200);
    const unread = new Map<string, boolean>(
      list.body.map((row: { number: string; hasUnread: boolean }) => [row.number, row.hasUnread]),
    );
    for (const ticket of demoTickets) {
      expect(unread.get(ticket.id), ticket.id).toBe(ticket.status === 'new');
    }
    // A reply the requester has not answered is unread for them; a resolved ticket's is read (checked on the merchant's side below).
    const detail = await staff.get(`/admin/support-tickets/${demoNumericId('T-4202')}`);
    expect(detail.body).toMatchObject({
      requesterSeenMessageId: expect.any(Number),
      staffSeenMessageId: expect.any(Number),
    });
  });

  it('opens a merchant’s seeded ticket in the portal with its thread, unread while support’s reply is unanswered', async () => {
    const { db } = await testDb();
    const open = demoTickets.find(
      (ticket) => ticket.who.type === 'client' && ticket.status === 'open' && ticket.msgs.at(-1)?.by === 'staff',
    );
    expect(open).toBeDefined();
    const clientId = demoNumericId(open!.who.id);
    const portal = await merchantSession(t, clientId);
    const list = await portal.call('GET', '/client/tickets');
    expect(list.status).toBe(200);
    const row = list.body.find((entry: { number: string }) => entry.number === open!.id);
    expect(row).toMatchObject({ lastMessageFrom: 'support', hasUnread: true });
    const thread = await portal.call('GET', `/client/tickets/${row.id}`);
    expect(thread.status).toBe(200);
    expect(thread.body.messages.map((message: { from: string }) => message.from)).toEqual(['you', 'support']);
    expect((await db.select().from(s.supportTickets).where(eq(s.supportTickets.id, row.id)))[0]?.token).toBeNull();
    // A resolved merchant ticket's reply was seen.
    const resolved = demoTickets.find((ticket) => ticket.who.type === 'client' && ticket.status === 'resolved');
    if (resolved) {
      const other = await merchantSession(t, demoNumericId(resolved.who.id));
      const mine = (await other.call('GET', '/client/tickets')).body.find(
        (entry: { number: string }) => entry.number === resolved.id,
      );
      expect(mine.hasUnread).toBe(false);
    }
  });

  it('puts one PDF on a customer’s follow-up: the customer sees and downloads it through the ticket page, staff through the console', async () => {
    const { db } = await testDb();
    const [stored] = await db.select().from(s.files);
    // The test stack has its object store (a machine without one runs the seed without the attachment, which this test does not cover).
    expect(stored).toBeDefined();
    const file = stored!;
    expect(file).toMatchObject({ ownerType: 'customer', mime: 'application/pdf', filename: 'payment-receipt.pdf' });
    const [carrier] = (await db.select().from(s.ticketMessages)).filter((row) => row.fileIds.includes(file.id));
    expect(carrier).toMatchObject({ authorType: 'customer', authorId: file.ownerId, isInternal: false });
    const [ticket] = await db.select().from(s.supportTickets).where(eq(s.supportTickets.id, carrier!.ticketId));
    const customer = await customerSession(t, file.ownerId);
    const mine = (await customer.call('GET', '/store/v1/me/tickets')).body.find(
      (row: { number: string }) => row.number === ticket!.number,
    );
    const page = await t.app.inject({ method: 'GET', url: `/store/v1/tickets/${mine.token}` });
    expect(page.json().messages.at(-1).attachments).toEqual([
      { id: file.id, filename: 'payment-receipt.pdf', mime: 'application/pdf', size: file.size },
    ]);
    const download = await t.app.inject({ method: 'GET', url: `/store/v1/tickets/${mine.token}/files/${file.id}` });
    expect(download.statusCode).toBe(302);
    expect((await staff.get(`/admin/support-tickets/${ticket!.id}/files/${file.id}`)).status).toBe(302);
    // Running the seed again attaches the same file and adds nothing.
    const again = await runSeed(db, await loadDemoState(), t.config);
    expect(again.filter((report) => report.table === 'files').map((report) => report.inserted)).toEqual([0]);
    expect(await db.select().from(s.files)).toHaveLength(1);
  });
});
