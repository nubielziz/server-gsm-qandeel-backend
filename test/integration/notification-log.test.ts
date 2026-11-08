// Integration tests of the notification log routes (feature 12a, RULES settings 11, M172): the list with its filters, sorts and search, the
// recipient masked by the server for each kind of recipient, the error of a failed message and the single read with its payload.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { schema as s } from '../../src/infra/db';
import { type AdminApi, adminWith } from '../support/admin-api';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches, insertMerchant } from '../support/auth';
import { TestClock } from '../support/clock';
import { closeTestDb, resetDb, testDb } from '../support/db';

const clock = new TestClock('2026-11-01T10:00:00.000Z');
let t: TestApp;
let owner: AdminApi;

beforeAll(async () => {
  t = await createTestApp({ clock });
});
afterAll(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await t.close();
  await closeTestDb();
});
beforeEach(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  owner = await adminWith(t, ['*']);
});

const ids = (body: Array<{ id: number }>) => body.map((row) => row.id);

/** A small log: a merchant's mail and Telegram messages, a customer's mail and a staff member's mail, in every status, over four hours. */
async function history() {
  const { db } = await testDb();
  const merchant = await insertMerchant(db, {
    name: 'Zain Mobile Hub',
    email: 'ops@zainmobilehub.example',
    telegramChatId: '7001234',
  });
  const [customer] = await db
    .insert(s.customers)
    .values({ email: 'daniel.whitmore@example.com', name: 'Daniel' })
    .returning({ id: s.customers.id });
  const staffId = owner.staffId;
  const at = (hours: number) => new Date(clock.nowMs() - hours * 3_600_000);
  const rows = await db
    .insert(s.notifications)
    .values([
      {
        recipientType: 'client',
        recipientId: merchant,
        channel: 'email',
        event: 'wallet.low_balance',
        status: 'sent',
        sentAt: at(4),
        attempts: 1,
        payload: { variables: { available: '42.50' } },
        createdAt: at(4),
      },
      {
        recipientType: 'client',
        recipientId: merchant,
        channel: 'telegram',
        event: 'wallet.low_balance',
        status: 'sent',
        sentAt: at(3),
        attempts: 1,
        createdAt: at(3),
      },
      {
        recipientType: 'customer',
        recipientId: customer!.id,
        channel: 'email',
        event: 'order.completed',
        status: 'failed',
        attempts: 5,
        error: 'The mailbox does not exist.',
        createdAt: at(2),
      },
      {
        recipientType: 'staff',
        recipientId: staffId,
        channel: 'email',
        event: 'alert.opened',
        status: 'queued',
        createdAt: at(1),
      },
    ])
    .returning({ id: s.notifications.id });
  const [lowEmail, lowTelegram, failed, queued] = rows.map((row) => row.id) as [number, number, number, number];
  return { merchant, lowEmail, lowTelegram, failed, queued };
}

describe('GET /admin/notifications', () => {
  it('lists newest first with the exact total, the wire fields and no payload', async () => {
    const { lowEmail, lowTelegram, failed, queued } = await history();
    const res = await owner.get('/admin/notifications');
    expect(res.status).toBe(200);
    expect(res.total).toBe(4);
    expect(ids(res.body)).toEqual([queued, failed, lowTelegram, lowEmail]);
    expect(res.body[3]).toEqual({
      id: lowEmail,
      recipientType: 'client',
      recipientId: expect.any(Number),
      channel: 'email',
      event: 'wallet.low_balance',
      status: 'sent',
      recipient: 'o***@zainmobilehub.example',
      attempts: 1,
      sentAt: '2026-11-01T06:00:00.000Z',
      error: null,
      createdAt: '2026-11-01T06:00:00.000Z',
      updatedAt: expect.any(String),
    });
    expect(res.body.every((row: object) => !('payload' in row))).toBe(true);
  });

  it('masks the recipient on the server for a merchant, a Telegram chat, a customer and a staff member, never the whole address', async () => {
    const { lowEmail, lowTelegram, failed, queued } = await history();
    const byId = new Map<number, { recipient: string }>(
      (await owner.get('/admin/notifications')).body.map((row: { id: number; recipient: string }) => [row.id, row]),
    );
    expect(byId.get(lowEmail)?.recipient).toBe('o***@zainmobilehub.example');
    expect(byId.get(lowTelegram)?.recipient).toBe('@7***');
    expect(byId.get(failed)?.recipient).toBe('d***@example.com');
    expect(byId.get(queued)?.recipient).toMatch(/^.\*\*\*@/);
    const text = JSON.stringify([...byId.values()]);
    expect(text).not.toContain('ops@zainmobilehub');
    expect(text).not.toContain('daniel.whitmore');
    expect(text).not.toContain('7001234');
  });

  it('shows only a mask for a recipient that is gone', async () => {
    const { merchant, lowEmail } = await history();
    const { db } = await testDb();
    await db.delete(s.clients).where(eq(s.clients.id, merchant));
    const res = await owner.get(`/admin/notifications/${lowEmail}`);
    expect(res.body.recipient).toBe('***');
  });

  it('carries the error of a failed message and null for the others', async () => {
    const { failed, lowEmail } = await history();
    const rows = (await owner.get('/admin/notifications')).body;
    expect(rows.find((row: { id: number }) => row.id === failed)).toMatchObject({
      status: 'failed',
      attempts: 5,
      sentAt: null,
      error: 'The mailbox does not exist.',
    });
    expect(rows.find((row: { id: number }) => row.id === lowEmail).error).toBeNull();
  });

  it('filters by status (equal and not equal), channel, event and recipient type', async () => {
    const { lowEmail, lowTelegram, failed, queued } = await history();
    const list = async (query: string) => ids((await owner.get(`/admin/notifications?${query}`)).body);
    expect(await list('status=failed')).toEqual([failed]);
    expect(await list('status_ne=sent')).toEqual([queued, failed]);
    expect(await list('channel=telegram')).toEqual([lowTelegram]);
    expect(await list('event=wallet.low_balance')).toEqual([lowTelegram, lowEmail]);
    expect(await list('recipientType=customer')).toEqual([failed]);
    expect(await list('recipientType=staff&status=queued')).toEqual([queued]);
    expect((await owner.get('/admin/notifications?status=nope')).status).toBe(422);
  });

  it('searches the event and the address, sorts, pages and counts the whole filter', async () => {
    const { lowEmail, lowTelegram, failed } = await history();
    const list = async (query: string) => await owner.get(`/admin/notifications?${query}`);
    expect(ids((await list('q=ORDER.completed')).body)).toEqual([failed]);
    // The search reads the account's address only as a whole: the merchant's Telegram message is found by its full email too.
    expect(ids((await list('q=OPS@zainmobilehub.example')).body)).toEqual([lowTelegram, lowEmail]);
    expect(ids((await list('q=daniel.whitmore@example.com')).body)).toEqual([failed]);
    expect(ids((await list('_sort=createdAt&_order=asc')).body)[0]).toBe(lowEmail);
    const page = await list('_sort=id&_order=asc&_start=1&_end=3');
    expect(page.total).toBe(4);
    expect(page.body).toHaveLength(2);
  });

  it('never matches the recipient address by a part of it, only by the whole address', async () => {
    const { lowEmail, lowTelegram, failed } = await history();
    const list = async (query: string) => await owner.get(`/admin/notifications?${query}`);
    // A part of an address (a prefix, the domain, a middle piece, the masked form) finds nothing by recipient.
    for (const part of ['zainmobilehub', 'ops@', 'ops@zainmobilehub', 'whitmore', 'example.com', 'd***@example.com'])
      expect(ids((await list(`q=${encodeURIComponent(part)}`)).body)).toEqual([]);
    expect((await list('q=whitmore')).total).toBe(0);
    // The whole address finds the row, in any letter case; the event search still works with a part.
    expect(ids((await list(`q=${encodeURIComponent('Daniel.Whitmore@Example.com')}`)).body)).toEqual([failed]);
    expect((await list('q=ops@zainmobilehub.example')).total).toBe(2);
    expect(ids((await list('q=low_bal')).body)).toEqual([lowTelegram, lowEmail]);
  });

  it('needs a session and the notifications:read permission', async () => {
    await history();
    expect((await owner.anonymous('GET', '/admin/notifications')).status).toBe(401);
    const nobody = await adminWith(t, ['orders:read']);
    expect((await nobody.get('/admin/notifications')).body.code).toBe('FORBIDDEN');
    expect((await (await adminWith(t, ['notifications:read'])).get('/admin/notifications')).status).toBe(200);
  });
});

describe('GET /admin/notifications/:id', () => {
  it('adds the payload the message was built from, and answers 404 for an unknown id', async () => {
    const { lowEmail } = await history();
    const res = await owner.get(`/admin/notifications/${lowEmail}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: lowEmail, status: 'sent', payload: { variables: { available: '42.50' } } });
    expect((await owner.get('/admin/notifications/99999')).body.code).toBe('NOT_FOUND');
    expect((await owner.get('/admin/notifications/abc')).status).toBe(422);
    const nobody = await adminWith(t, ['orders:read']);
    expect((await nobody.get(`/admin/notifications/${lowEmail}`)).body.code).toBe('FORBIDDEN');
  });

  it('never gives back the Telegram chat id, not in the recipient and not in the payload the bot’s answers carry', async () => {
    const { merchant } = await history();
    const { db } = await testDb();
    const [answer] = await db
      .insert(s.notifications)
      .values({
        recipientType: 'client',
        recipientId: merchant,
        channel: 'telegram',
        event: 'telegram.unlinked',
        status: 'sent',
        attempts: 1,
        payload: { variables: { merchantName: 'Zain Mobile Hub' }, chatId: '987654321' },
      })
      .returning({ id: s.notifications.id });
    const res = await owner.get(`/admin/notifications/${answer!.id}`);
    expect(res.status).toBe(200);
    expect(res.body.recipient).toBe('@7***');
    expect(res.body.payload).toEqual({ variables: { merchantName: 'Zain Mobile Hub' }, chatId: '@9***' });
    expect(JSON.stringify(res.body)).not.toContain('987654321');
    expect(JSON.stringify(res.body)).not.toContain('7001234');
    // The list leaves the payload out, so it cannot leak it either.
    expect(JSON.stringify((await owner.get('/admin/notifications')).body)).not.toContain('987654321');
  });

  it('masks a chatId key at any depth of the payload (under variables, in nested objects and in arrays)', async () => {
    const { merchant } = await history();
    const { db } = await testDb();
    const [row] = await db
      .insert(s.notifications)
      .values({
        recipientType: 'client',
        recipientId: merchant,
        channel: 'telegram',
        event: 'telegram.unlinked',
        status: 'sent',
        attempts: 1,
        payload: {
          variables: { merchantName: 'Zain Mobile Hub', chatId: '555111222' },
          context: { from: { chatId: '666333444' }, history: [{ chatId: '777888999' }, 'plain text', 42, null] },
          chats: [[{ chatId: '444222000' }]],
        },
      })
      .returning({ id: s.notifications.id });
    const res = await owner.get(`/admin/notifications/${row!.id}`);
    expect(res.status).toBe(200);
    expect(res.body.payload).toEqual({
      variables: { merchantName: 'Zain Mobile Hub', chatId: '@5***' },
      context: { from: { chatId: '@6***' }, history: [{ chatId: '@7***' }, 'plain text', 42, null] },
      chats: [[{ chatId: '@4***' }]],
    });
    const text = JSON.stringify([res.body, (await owner.get('/admin/notifications')).body]);
    for (const chat of ['555111222', '666333444', '777888999', '444222000']) expect(text).not.toContain(chat);
  });
});
