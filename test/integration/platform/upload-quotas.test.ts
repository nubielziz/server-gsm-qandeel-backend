// Integration tests of the upload quotas (decisions 053 and 064) through the upload routes: an account of a merchant rank, an account of a
// retail rank and a ticket link are held to their numbers (422 on `file` with the code `quota`), the rule follows the rank kind and never
// the route, the owner of every file is the account, generated documents and staff uploads never count, a refused upload leaves no
// object, and two uploads that run together cannot both take the last place.
import { afterAll, beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import { type Database, schema as s } from '@src/infra/db';
import { StorageService } from '@src/infra/storage';
import { openAccountSession } from '../../support/account-sessions';
import { makeAccount } from '../../support/accounts';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches } from '../../support/auth';
import { HOUR, TestClock } from '../../support/clock';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { multipartRequest } from '../../support/machine-orders';
import { type OrdersWorld, ordersWorld, portalFor } from '../../support/orders';
import { freshClientIp } from '../../support/pipeline-routes';
import { CONSOLE_ORIGIN } from '../../support/staff-console';
import { STORE_ORIGIN } from '../../support/store';
import { clearTicketChatLimits, insertSupportMessage, insertSupportTicket, supportStaff } from '../../support/support';

const MIB = 1024 * 1024;
const PDF = new TextEncoder().encode('%PDF-1.7\n1 0 obj << >> endobj\n%%EOF\n');
const clock = new TestClock('2026-11-10T09:00:00.000Z');
let t: TestApp;
let db: Database;
let world: OrdersWorld;

beforeAll(async () => {
  db = (await testDb()).db;
  t = await createTestApp({ clock });
});
beforeEach(async () => {
  clock.set('2026-11-10T09:00:00.000Z');
  await resetDb();
  await clearIdentityCaches(t);
  await clearTicketChatLimits(t);
  world = await ordersWorld(db);
});
afterAll(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await t.close();
  await closeTestDb();
});

/** Inserts file rows of an owner (no objects: the quota counts rows), stamped with the test clock's time. */
async function holdFiles(
  owner: { type: 'account' | 'staff'; id: number },
  count: number,
  options: { prefix?: string; size?: number } = {},
) {
  await db.insert(s.files).values(
    Array.from({ length: count }, () => ({
      bucket: 'gsm-files',
      key: `${options.prefix ?? 'files/2026/11/'}${crypto.randomUUID()}`,
      filename: 'held.pdf',
      mime: 'application/pdf',
      size: options.size ?? 100,
      sha256: 'a'.repeat(64),
      ownerType: owner.type,
      ownerId: owner.id,
      createdAt: clock.now(),
      updatedAt: clock.now(),
    })),
  );
}

const form = (bytes: Uint8Array = PDF) => {
  const body = new FormData();
  body.set('file', new File([bytes], 'doc.pdf', { type: 'application/pdf' }));
  return body;
};
const quotaOf = (res: {
  statusCode: number;
  json: () => { errors?: Array<{ field: string; code: string; message: string }> };
}) => res.json().errors?.[0];

async function merchantUpload(clientId: number, bytes?: Uint8Array) {
  const portal = await portalFor(t, clientId);
  return multipartRequest(t, '/client/files', form(bytes), portal.session.mutationHeaders);
}
async function retailUpload(accountId: number, bytes?: Uint8Array) {
  const session = await openAccountSession(t, accountId);
  return multipartRequest(
    t,
    '/store/v1/files',
    form(bytes),
    { ...session.mutationHeaders, origin: STORE_ORIGIN },
    freshClientIp(),
  );
}
async function ticketUpload(token: string, bytes?: Uint8Array) {
  return multipartRequest(t, `/store/v1/tickets/${token}/files`, form(bytes), {}, freshClientIp());
}

describe('an account of a merchant rank', () => {
  it('gives it 500 files and 5 GiB a day, owned by the account', async () => {
    const owner = { type: 'account' as const, id: world.merchant.id };
    await holdFiles(owner, 500);
    clock.advance(23 * HOUR);
    const refused = await merchantUpload(world.merchant.id);
    expect(refused.statusCode).toBe(422);
    expect(quotaOf(refused)!.message).toContain('500 files (5 GiB) in 24 hours');
    // The rows are 25 hours old: they no longer count.
    clock.advance(2 * HOUR);
    const accepted = await merchantUpload(world.merchant.id);
    expect(accepted.statusCode).toBe(201);
    // Decision 064: the row says `account` and the account id, not the old merchant word.
    const stored = accepted.json<{ id: number }>();
    const [row] = await db.select().from(s.files).where(eq(s.files.id, stored.id));
    expect(row).toMatchObject({ ownerType: 'account', ownerId: world.merchant.id });
  });

  it('counts the bytes of the last 24 hours', async () => {
    await holdFiles({ type: 'account', id: world.merchant.id }, 1, { size: 5 * 1024 * MIB });
    expect((await merchantUpload(world.merchant.id)).statusCode).toBe(422);
    clock.advance(25 * HOUR);
    expect((await merchantUpload(world.merchant.id)).statusCode).toBe(201);
  });

  it("counts the account's own files only, and the files of another account never", async () => {
    await holdFiles({ type: 'account', id: world.other.id }, 500);
    expect((await merchantUpload(world.merchant.id)).statusCode).toBe(201);
  });

  it('is not capped by the 30-file store rule, and has no 10-file rule of an account that waits for approval (decision 064)', async () => {
    // 40 files and 160 MiB: over the retail rule (30 files, 100 MiB), far under the merchant one.
    await holdFiles({ type: 'account', id: world.merchant.id }, 40, { size: 4 * MIB });
    expect((await merchantUpload(world.merchant.id)).statusCode).toBe(201);
    // The same holdings stop an account of a retail rank on its own route.
    const retail = await makeAccount(t, { rank: 'retail' });
    await holdFiles({ type: 'account', id: retail.id }, 30);
    const refused = await retailUpload(retail.id);
    expect(refused.statusCode).toBe(422);
    expect(quotaOf(refused)).toMatchObject({ field: 'file', code: 'quota' });
  });

  it('lets exactly one of two parallel uploads take the last place, under the lock of the account', async () => {
    await holdFiles({ type: 'account', id: world.merchant.id }, 499);
    const sessions = await Promise.all([portalFor(t, world.merchant.id), portalFor(t, world.merchant.id)]);
    const results = await Promise.all(
      sessions.map((portal) => multipartRequest(t, '/client/files', form(), portal.session.mutationHeaders)),
    );
    expect(results.map((res) => res.statusCode).sort()).toEqual([201, 422]);
    expect(await db.select().from(s.files).where(eq(s.files.ownerId, world.merchant.id))).toHaveLength(500);
  });

  it('refuses an obvious excess before an object is written', async () => {
    await holdFiles({ type: 'account', id: world.merchant.id }, 500);
    const put = spyOn(t.app.get(StorageService), 'put');
    try {
      const refused = await merchantUpload(world.merchant.id);
      expect(refused.statusCode).toBe(422);
      expect(put).not.toHaveBeenCalled();
    } finally {
      put.mockRestore();
    }
  });
});

describe('an account of a retail rank', () => {
  it('gives it 30 files and 100 MiB a day, receipts and ticket files together, owned by the account', async () => {
    const retail = await makeAccount(t, { rank: 'retail' });
    const owner = { type: 'account' as const, id: retail.id };
    await holdFiles(owner, 20);
    await holdFiles(owner, 9, { prefix: 'tickets-7/account-1/' });
    // The 30th file is the last one: the upload route writes the owner as the account (decision 064).
    const accepted = await retailUpload(retail.id);
    expect(accepted.statusCode).toBe(201);
    const [row] = await db
      .select()
      .from(s.files)
      .where(
        and(
          eq(s.files.ownerType, 'account'),
          eq(s.files.ownerId, retail.id),
          eq(s.files.id, accepted.json<{ id: number }>().id),
        ),
      );
    expect(row).toMatchObject({ ownerType: 'account', ownerId: retail.id });
    const refused = await retailUpload(retail.id);
    expect(refused.statusCode).toBe(422);
    expect(quotaOf(refused)).toMatchObject({ field: 'file', code: 'quota' });
    expect(quotaOf(refused)!.message).toContain('30 files (100 MiB) in 24 hours');
    clock.advance(25 * HOUR);
    expect((await retailUpload(retail.id)).statusCode).toBe(201);
  });

  it('counts 100 MiB of the last 24 hours', async () => {
    const retail = await makeAccount(t, { rank: 'retail' });
    await holdFiles({ type: 'account', id: retail.id }, 1, { size: 100 * MIB - PDF.length + 1 });
    expect((await retailUpload(retail.id)).statusCode).toBe(422);
  });

  it('lets exactly one of two parallel uploads take the last place', async () => {
    const retail = await makeAccount(t, { rank: 'retail' });
    await holdFiles({ type: 'account', id: retail.id }, 29);
    const results = await Promise.all([retailUpload(retail.id), retailUpload(retail.id)]);
    expect(results.map((res) => res.statusCode).sort()).toEqual([201, 422]);
    expect(await db.select().from(s.files).where(eq(s.files.ownerId, retail.id))).toHaveLength(30);
  });

  it('is held to the retail rule on both routes: an upload and a ticket link count the same files', async () => {
    const retail = await makeAccount(t, { rank: 'retail' });
    const ticket = await insertSupportTicket(db, { requesterId: retail.id, status: 'open' });
    await insertSupportMessage(db, ticket.id, { authorType: 'account', authorId: retail.id, body: 'Hello.' });
    await holdFiles({ type: 'account', id: retail.id }, 30, { prefix: `tickets-${ticket.id}/account-${retail.id}/` });
    expect((await retailUpload(retail.id)).statusCode).toBe(422);
    expect((await ticketUpload(ticket.token!)).statusCode).toBe(422);
  });
});

describe('a ticket link', () => {
  async function ticketOf(customerId: number) {
    const ticket = await insertSupportTicket(db, { requesterId: customerId, status: 'open' });
    await insertSupportMessage(db, ticket.id, { authorType: 'account', authorId: customerId, body: 'Hello.' });
    return { id: ticket.id, token: ticket.token! };
  }

  it('gives a ticket link 20 files a day', async () => {
    const customer = await makeAccount(t, { rank: 'retail' });
    const ticket = await ticketOf(customer.id);
    await holdFiles({ type: 'account', id: customer.id }, 20, {
      prefix: `tickets-${ticket.id}/account-${customer.id}/`,
    });
    const refused = await ticketUpload(ticket.token);
    expect(refused.statusCode).toBe(422);
    expect(quotaOf(refused)).toMatchObject({ field: 'file', code: 'quota' });
    expect(quotaOf(refused)!.message).toContain('This ticket can take at most 20 files');
    // Another ticket of the same customer has its own 20 (and the customer's 30 a day leaves room for 10 more).
    const other = await ticketOf(customer.id);
    expect((await ticketUpload(other.token)).statusCode).toBe(201);
    clock.advance(25 * HOUR);
    expect((await ticketUpload(ticket.token)).statusCode).toBe(201);
  });

  it("checks the customer's own quota as well", async () => {
    const customer = await makeAccount(t, { rank: 'retail' });
    const ticket = await ticketOf(customer.id);
    await holdFiles({ type: 'account', id: customer.id }, 30);
    const refused = await ticketUpload(ticket.token);
    expect(refused.statusCode).toBe(422);
    expect(quotaOf(refused)!.message).toContain('30 files (100 MiB) in 24 hours');
  });

  it('counts no staff upload', async () => {
    const staff = await supportStaff(t, ['support:*']);
    const customer = await makeAccount(t, { rank: 'retail' });
    const ticket = await ticketOf(customer.id);
    await holdFiles({ type: 'staff', id: staff.staffId }, 40, { prefix: 'tickets/staff-1/' });
    for (let n = 0; n < 3; n += 1) {
      const res = await multipartRequest(
        t,
        `/admin/support-tickets/${ticket.id}/files`,
        form(),
        { ...staff.session.mutationHeaders, origin: CONSOLE_ORIGIN },
        staff.ip,
      );
      expect(res.statusCode).toBe(201);
    }
  });
});
