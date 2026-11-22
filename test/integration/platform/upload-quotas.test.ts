// Integration tests of the upload quotas (decision 053) through the upload routes: a merchant that waits for approval, an approved merchant, a
// customer and a ticket link are held to their numbers (422 on `file` with the code `quota`), generated documents and staff uploads never
// count, a refused upload leaves no object, and two uploads that run together cannot both take the last place.
import { afterAll, beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { eq } from 'drizzle-orm';
import { type Database, schema as s } from '@src/infra/db';
import { StorageService } from '@src/infra/storage';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches, openSession } from '../../support/auth';
import { DAY, HOUR, TestClock } from '../../support/clock';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { multipartRequest } from '../../support/machine-orders';
import { type OrdersWorld, ordersWorld, portalFor } from '../../support/orders';
import { freshClientIp } from '../../support/pipeline-routes';
import { CONSOLE_ORIGIN } from '../../support/staff-console';
import { makeCustomer, STORE_ORIGIN } from '../../support/store';
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
  owner: { type: 'client' | 'customer' | 'staff'; id: number },
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
async function customerUpload(customerId: number, bytes?: Uint8Array) {
  const session = await openSession(t, { type: 'customer', id: customerId });
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

describe('a merchant that waits for approval', () => {
  beforeEach(async () => {
    await db.update(s.clients).set({ status: 'pending' }).where(eq(s.clients.id, world.merchant.id));
  });

  it('keeps a merchant waiting for approval to 10 files and 50 MiB', async () => {
    const owner = { type: 'client' as const, id: world.merchant.id };
    await holdFiles(owner, 10);
    // Generated documents of the merchant (an invoice, a receipt) never count.
    await holdFiles(owner, 5, { prefix: 'invoices/2026/11/' });
    const put = spyOn(t.app.get(StorageService), 'put');
    try {
      const refused = await merchantUpload(world.merchant.id);
      expect(refused.statusCode).toBe(422);
      expect(quotaOf(refused)).toMatchObject({ field: 'file', code: 'quota' });
      expect(quotaOf(refused)!.message).toContain('10 uploaded files (50 MiB)');
      // The obvious refusal stores no object.
      expect(put).not.toHaveBeenCalled();
    } finally {
      put.mockRestore();
    }
    expect(await db.select().from(s.files).where(eq(s.files.ownerId, world.merchant.id))).toHaveLength(15);
  });

  it('allows the 10th file and refuses the 11th', async () => {
    await holdFiles({ type: 'client', id: world.merchant.id }, 9);
    expect((await merchantUpload(world.merchant.id)).statusCode).toBe(201);
    expect((await merchantUpload(world.merchant.id)).statusCode).toBe(422);
  });

  it('counts bytes: 50 MiB held leaves no room for one more byte', async () => {
    await holdFiles({ type: 'client', id: world.merchant.id }, 1, { size: 50 * MIB - PDF.length + 1 });
    const refused = await merchantUpload(world.merchant.id);
    expect(refused.statusCode).toBe(422);
    expect(quotaOf(refused)).toMatchObject({ field: 'file', code: 'quota' });
    await resetDb();
    world = await ordersWorld(db);
    await db.update(s.clients).set({ status: 'pending' }).where(eq(s.clients.id, world.merchant.id));
    await holdFiles({ type: 'client', id: world.merchant.id }, 1, { size: 50 * MIB - PDF.length });
    expect((await merchantUpload(world.merchant.id)).statusCode).toBe(201);
  });

  it('counts everything the merchant holds, however old', async () => {
    await holdFiles({ type: 'client', id: world.merchant.id }, 10);
    clock.advance(30 * DAY);
    expect((await merchantUpload(world.merchant.id)).statusCode).toBe(422);
  });

  it('lets exactly one of two parallel uploads take the last place', async () => {
    await holdFiles({ type: 'client', id: world.merchant.id }, 9);
    const sessions = await Promise.all([portalFor(t, world.merchant.id), portalFor(t, world.merchant.id)]);
    const results = await Promise.all(
      sessions.map((portal) => multipartRequest(t, '/client/files', form(), portal.session.mutationHeaders)),
    );
    expect(results.map((res) => res.statusCode).sort()).toEqual([201, 422]);
    expect(await db.select().from(s.files).where(eq(s.files.ownerId, world.merchant.id))).toHaveLength(10);
  });
});

describe('an approved merchant', () => {
  it('gives an approved merchant 500 files and 5 GiB a day', async () => {
    const owner = { type: 'client' as const, id: world.merchant.id };
    await holdFiles(owner, 500);
    clock.advance(23 * HOUR);
    const refused = await merchantUpload(world.merchant.id);
    expect(refused.statusCode).toBe(422);
    expect(quotaOf(refused)!.message).toContain('500 files (5 GiB) in 24 hours');
    // The rows are 25 hours old: they no longer count.
    clock.advance(2 * HOUR);
    expect((await merchantUpload(world.merchant.id)).statusCode).toBe(201);
  });

  it('counts the bytes of the last 24 hours', async () => {
    await holdFiles({ type: 'client', id: world.merchant.id }, 1, { size: 5 * 1024 * MIB });
    expect((await merchantUpload(world.merchant.id)).statusCode).toBe(422);
    clock.advance(25 * HOUR);
    expect((await merchantUpload(world.merchant.id)).statusCode).toBe(201);
  });

  it("counts the merchant's own files only, and the files of another merchant never", async () => {
    await holdFiles({ type: 'client', id: world.other.id }, 500);
    expect((await merchantUpload(world.merchant.id)).statusCode).toBe(201);
  });
});

describe('a customer', () => {
  it('gives a customer 30 files and 100 MiB a day, receipts and ticket files together', async () => {
    const customer = await makeCustomer(t);
    const owner = { type: 'customer' as const, id: customer.id };
    await holdFiles(owner, 20);
    await holdFiles(owner, 10, { prefix: 'tickets-7/customer-1/' });
    const refused = await customerUpload(customer.id);
    expect(refused.statusCode).toBe(422);
    expect(quotaOf(refused)).toMatchObject({ field: 'file', code: 'quota' });
    expect(quotaOf(refused)!.message).toContain('30 files (100 MiB) in 24 hours');
    clock.advance(25 * HOUR);
    expect((await customerUpload(customer.id)).statusCode).toBe(201);
  });

  it('counts 100 MiB of the last 24 hours', async () => {
    const customer = await makeCustomer(t);
    await holdFiles({ type: 'customer', id: customer.id }, 1, { size: 100 * MIB - PDF.length + 1 });
    expect((await customerUpload(customer.id)).statusCode).toBe(422);
  });
});

describe('a ticket link', () => {
  async function ticketOf(customerId: number) {
    const ticket = await insertSupportTicket(db, { requesterId: customerId, status: 'open' });
    await insertSupportMessage(db, ticket.id, { authorType: 'customer', authorId: customerId, body: 'Hello.' });
    return { id: ticket.id, token: ticket.token! };
  }

  it('gives a ticket link 20 files a day', async () => {
    const customer = await makeCustomer(t);
    const ticket = await ticketOf(customer.id);
    await holdFiles({ type: 'customer', id: customer.id }, 20, {
      prefix: `tickets-${ticket.id}/customer-${customer.id}/`,
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
    const customer = await makeCustomer(t);
    const ticket = await ticketOf(customer.id);
    await holdFiles({ type: 'customer', id: customer.id }, 30);
    const refused = await ticketUpload(ticket.token);
    expect(refused.statusCode).toBe(422);
    expect(quotaOf(refused)!.message).toContain('30 files (100 MiB) in 24 hours');
  });

  it('counts no staff upload', async () => {
    const staff = await supportStaff(t, ['support:*']);
    const customer = await makeCustomer(t);
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
