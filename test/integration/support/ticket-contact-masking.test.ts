// Integration tests of the contact masking of the support inbox (decisions 047 and 064): the address of a ticket's requester, of either rank, is
// masked unless the caller holds `clients:read`, in the list, in one ticket, in the answer of a change, in the thread's author names, in the
// search and in the live frames of the staff stream. The address of a merchant rank is no longer shown in full to everybody. Real Postgres and
// Redis, with a test clock.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { type AdminApi } from '../../support/admin-api';
import { ensureRetailGroup } from '../../support/accounts';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches } from '../../support/auth';
import { TestClock } from '../../support/clock';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import {
  insertClient,
  insertCustomer,
  insertSupportMessage,
  insertSupportTicket,
  seedSupportTemplates,
  supportStaff,
} from '../../support/support';

const NOW = '2026-11-08T12:00:00.000Z';
const clock = new TestClock(NOW);
let t: TestApp;
let plain: AdminApi;
let reader: AdminApi;

beforeAll(async () => {
  t = await createTestApp({ clock });
});
beforeEach(async () => {
  clock.set(NOW);
  await resetDb();
  await clearIdentityCaches(t);
  const { db } = await testDb();
  // the reset removed the one retail rank that the migrations insert; the console reads it to tell the requester's rank
  await ensureRetailGroup(db);
  await seedSupportTemplates(db);
  // One role without and one with the permission that decides the masking.
  plain = await supportStaff(t, ['support:*'], 'Lina S.');
  reader = await supportStaff(t, ['support:*', 'clients:read'], 'Rami K.');
});
afterAll(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await t.close();
  await closeTestDb();
});

/** A retail account and a merchant rank, each with a ticket and a message of its own. */
async function twoRequesters() {
  const { db } = await testDb();
  const buyer = await insertCustomer(db, { name: 'Victor Hale', email: 'victor@mail.example' });
  const merchant = await insertClient(db, { name: 'Zain Mobile Hub', email: 'desk@zain-hub.example' });
  const mine = await insertSupportTicket(db, { requesterId: buyer.id, subject: 'Buyer', status: 'open' });
  const theirs = await insertSupportTicket(db, {
    requesterId: merchant.id,
    subject: 'Merchant',
    status: 'open',
    token: null,
  });
  for (const [ticket, account] of [
    [mine, buyer],
    [theirs, merchant],
  ] as const) {
    await insertSupportMessage(db, ticket.id, {
      authorType: 'account',
      authorId: account.id,
      body: 'Hello.',
      createdAt: new Date(clock.nowMs() - 60_000),
    });
  }
  return { db, buyer, merchant, mine, theirs };
}

describe('the requester address in the support inbox (decision 047, for every rank)', () => {
  it('masks the address of a retail account and of a merchant rank without clients:read: list, one ticket and the answer of a change', async () => {
    const { mine, theirs } = await twoRequesters();
    const emails = async (api: AdminApi) => {
      const list = (await api.get('/admin/support-tickets?_sort=id&_order=asc')).body;
      return {
        list: list.map((row: { requester: { email: string } }) => row.requester.email),
        buyer: (await api.get(`/admin/support-tickets/${mine.id}`)).body.requester.email,
        merchant: (await api.get(`/admin/support-tickets/${theirs.id}`)).body.requester.email,
        updated: (await api.patch(`/admin/support-tickets/${theirs.id}`, { priority: 'high' })).body.requester.email,
      };
    };
    expect(await emails(plain)).toEqual({
      list: ['vi•••@mail.example', 'de•••@zain-hub.example'],
      buyer: 'vi•••@mail.example',
      merchant: 'de•••@zain-hub.example',
      updated: 'de•••@zain-hub.example',
    });
    expect(await emails(reader)).toEqual({
      list: ['victor@mail.example', 'desk@zain-hub.example'],
      buyer: 'victor@mail.example',
      merchant: 'desk@zain-hub.example',
      updated: 'desk@zain-hub.example',
    });
  });

  it('tells the rank kind of each requester, and keeps a full address out of every answer of the caller without the permission', async () => {
    const { mine, theirs } = await twoRequesters();
    const list = (await plain.get('/admin/support-tickets?_sort=id&_order=asc')).body;
    expect(list.map((row: { requester: { rankKind: string } }) => row.requester.rankKind)).toEqual([
      'retail',
      'merchant',
    ]);
    expect(list.map((row: { requesterType: string }) => row.requesterType)).toEqual(['account', 'account']);
    for (const id of [mine.id, theirs.id]) {
      const text = JSON.stringify((await plain.get(`/admin/support-tickets/${id}`)).body);
      expect(text).not.toContain('victor@mail');
      expect(text).not.toContain('desk@zain-hub');
    }
  });

  it('finds an account by its address only for a caller who holds clients:read, whatever its rank', async () => {
    await twoRequesters();
    const subjects = async (api: AdminApi, query: string) =>
      (await api.get(`/admin/support-tickets?${query}&_sort=id&_order=asc`)).body.map(
        (row: { subject: string }) => row.subject,
      );
    expect(await subjects(reader, 'q=victor@mail')).toEqual(['Buyer']);
    expect(await subjects(reader, 'q=zain-hub.example')).toEqual(['Merchant']);
    expect(await subjects(plain, 'q=victor@mail')).toEqual([]);
    expect(await subjects(plain, 'q=zain-hub.example')).toEqual([]);
    // The name is not an address: it still matches for everybody.
    expect(await subjects(plain, 'q=zain%20mobile')).toEqual(['Merchant']);
  });

  it('labels an account without a name by its masked address for every caller, a merchant rank included', async () => {
    const { db } = await testDb();
    const nameless = await insertClient(db, { name: '', email: 'ops@zain-hub.example' });
    const ticket = await insertSupportTicket(db, { requesterId: nameless.id, subject: 'Nameless', token: null });
    await insertSupportMessage(db, ticket.id, {
      authorType: 'account',
      authorId: nameless.id,
      body: 'Where is my statement?',
    });
    for (const api of [plain, reader]) {
      const one = (await api.get(`/admin/support-tickets/${ticket.id}`)).body;
      expect(one.requester.name).toBe('op•••@zain-hub.example');
      expect(one.messages.map((message: { authorName: string }) => message.authorName)).toEqual([
        'op•••@zain-hub.example',
      ]);
    }
    expect(JSON.stringify((await plain.get(`/admin/support-tickets/${ticket.id}`)).body)).not.toContain('ops@zain-hub');
  });
});
