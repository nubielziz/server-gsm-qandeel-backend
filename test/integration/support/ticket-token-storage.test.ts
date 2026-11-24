// The ticket link token at rest (decision 054): a new ticket keeps it only as a keyed hash and an encrypted copy, which the receipt mail
// and the account list reveal; a resolved ticket's link ends 180 days after the resolution and a reopen opens it again; anonymization clears
// every form; the one-off seal pass converts the old rows once. Real Postgres and Redis, with a test clock.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { type Database, schema as s } from '@src/infra/db';
import { TicketTokenSeal, TicketTokenSealModule } from '@src/modules/support';
import { type AdminApi, adminWith } from '../../support/admin-api';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches } from '../../support/auth';
import { revealedToken, tokenHashOf } from '../../support/capability-tokens';
import { DAY, SECOND, TestClock } from '../../support/clock';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { mailbox } from '../../support/notifications';
import { freshClientIp } from '../../support/pipeline-routes';
import { makeCustomer } from '../../support/store';
import {
  clearTicketChatLimits,
  clearTicketEmailLimits,
  insertSupportTicket,
  seedSupportTemplates,
  sendTicketMails,
  supportStaff,
} from '../../support/support';
import { clearTicketOpenLimits, customerSession } from '../../support/support-accounts';

const NOW = '2026-11-15T10:00:00.000Z';
const clock = new TestClock(NOW);
let t: TestApp;
let db: Database;
let staff: AdminApi;

beforeAll(async () => {
  ({ db } = await testDb());
  t = await createTestApp({ clock, imports: [TicketTokenSealModule] });
});
beforeEach(async () => {
  clock.set(NOW);
  await resetDb();
  await seedSupportTemplates(db);
  await clearIdentityCaches(t);
  await clearTicketChatLimits(t);
  await clearTicketOpenLimits(t);
  await clearTicketEmailLimits(t);
  mailbox(t).reset();
  staff = await supportStaff(t, ['support:*'], 'Lina S.');
});
afterAll(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await t.close();
  await closeTestDb();
});

const show = (token: string) =>
  t.app.inject({ method: 'GET', url: `/store/v1/tickets/${token}`, remoteAddress: freshClientIp() });
const ticketByNumber = async (number: string) =>
  (await db.select().from(s.supportTickets).where(eq(s.supportTickets.number, number)))[0]!;
const ticketById = async (id: number) =>
  (await db.select().from(s.supportTickets).where(eq(s.supportTickets.id, id)))[0]!;

/** A signed-in customer who opens a ticket from the account; answers the ticket row and its token. */
async function openFromAccount() {
  const customer = await makeCustomer(t, { name: 'Victor Hale' });
  const session = await customerSession(t, customer.id);
  const opened = await session.call('POST', '/store/v1/me/tickets', {
    subject: 'Where is my unlock?',
    message: 'Still waiting.',
  });
  expect(opened.status).toBe(201);
  return { customer, session, token: opened.body.token as string, row: await ticketByNumber(opened.body.number) };
}

describe('the ticket link token at rest', () => {
  it('stores a new ticket token only as a keyed hash and an encrypted copy', async () => {
    const { session, token, row } = await openFromAccount();
    expect(row.token).toBeNull();
    expect(row.tokenHash).toBe(tokenHashOf(t, 'ticket', token));
    expect(row.tokenEnc).not.toContain(token);
    expect(revealedToken(t, 'ticket', { enc: row.tokenEnc, plain: row.token })).toBe(token);
    expect((await show(token)).statusCode).toBe(200);
    // The account list and the receipt mail show the token again (revealed from the copy).
    expect((await session.call('GET', '/store/v1/me/tickets')).body[0]).toMatchObject({ token });
    await sendTicketMails(t);
    expect(mailbox(t).sent.some((mail) => mail.text.includes(`/support/tickets/${token}`))).toBe(true);
  });

  it("a resolved ticket's link ends 180 days after resolution and reopening opens it again", async () => {
    const { token, row } = await openFromAccount();
    expect((await staff.patch(`/admin/support-tickets/${row.id}`, { status: 'resolved' })).status).toBe(200);
    clock.advance(180 * DAY - SECOND);
    expect((await show(token)).statusCode).toBe(200);
    clock.advance(2 * SECOND);
    const ended = await show(token);
    expect(ended.statusCode).toBe(404);
    expect(ended.json<{ code: string }>().code).toBe('NOT_FOUND');
    // Half a year later the first staff session has ended: a colleague signed in now reopens the ticket.
    const later = await supportStaff(t, ['support:*'], 'Omar K.');
    expect((await later.patch(`/admin/support-tickets/${row.id}`, { status: 'open' })).status).toBe(200);
    expect((await show(token)).statusCode).toBe(200);
  });

  it('anonymization clears every form of the link', async () => {
    const { customer, token, row } = await openFromAccount();
    const bystander = await openFromAccount();
    const privacy = await adminWith(t, ['customers:*']);
    expect((await privacy.post(`/admin/clients/${customer.id}/anonymize`)).status).toBe(204);
    expect(await ticketById(row.id)).toMatchObject({ token: null, tokenHash: null, tokenEnc: null });
    expect((await show(token)).statusCode).toBe(404);
    expect((await ticketById(bystander.row.id)).tokenHash).toBe(bystander.row.tokenHash);
    expect((await show(bystander.token)).statusCode).toBe(200);
  });

  it('the seal pass converts the old rows once', async () => {
    const customer = await makeCustomer(t, { name: 'Old Buyer' });
    const old = await insertSupportTicket(db, { requesterId: customer.id });
    expect((await show(old.token!)).statusCode).toBe(200);
    expect(await t.app.get(TicketTokenSeal).run()).toEqual({ sealed: 1, unchanged: 0 });
    const row = await ticketById(old.id);
    expect(row).toMatchObject({ token: null, tokenHash: tokenHashOf(t, 'ticket', old.token!) });
    expect(row.updatedAt).toEqual(old.updatedAt);
    expect((await show(old.token!)).statusCode).toBe(200);
    expect(await t.app.get(TicketTokenSeal).run()).toEqual({ sealed: 0, unchanged: 0 });
  });
});
