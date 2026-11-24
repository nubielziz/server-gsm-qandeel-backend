// Integration tests of the file downloads (feature 5, MISMATCHES B154): GET /admin/files/:id and GET /client/files/:id answer 302 to a
// presigned link that expires after 5 minutes; a merchant reaches only its own files, and anything else is 404. Decision 047: a staff download
// also needs the read permission of every kind of record that uses the file, and identity documents and payment proofs are audited.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { schema as s } from '@src/infra/db';
import { type AdminApi, adminWith } from '../../support/admin-api';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches, insertMerchant } from '../../support/auth';
import { TestClock } from '../../support/clock';
import { insertGateway, insertInvoiceRow, insertPendingPayment } from '../../support/billing';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { insertOrderRow, json, type OrdersWorld, ordersWorld, portalFor } from '../../support/orders';
import { insertSupportMessage, insertSupportTicket, insertCustomer } from '../../support/support';

const clock = new TestClock();
let t: TestApp;
let world: OrdersWorld;
let staff: AdminApi;

beforeAll(async () => {
  t = await createTestApp({ clock });
});
beforeEach(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  world = await ordersWorld((await testDb()).db);
  staff = await adminWith(t, ['files:read']);
});
afterAll(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await t.close();
  await closeTestDb();
});

/** The audit rows of a download action, oldest first. */
async function opened(action: string) {
  return world.db.select().from(s.auditLogs).where(eq(s.auditLogs.action, action)).orderBy(s.auditLogs.id);
}

async function insertFile(ownerType: string, ownerId: number, filename = 'result file.zip'): Promise<number> {
  const [row] = await world.db
    .insert(s.files)
    .values({
      bucket: 'gsm-files-test',
      // The object key is a safe name; the download name is the stored file name.
      key: `files/${crypto.randomUUID()}.bin`,
      filename,
      mime: 'application/zip',
      size: 1234,
      sha256: 'a'.repeat(64),
      ownerType,
      ownerId,
    })
    .returning({ id: s.files.id });
  return row!.id;
}

/** The query parameters of a presigned URL, for asserting the 5-minute lifetime and the download name. */
function linkOf(location: string | undefined): URL {
  expect(location).toBeDefined();
  return new URL(location!);
}

describe('GET /admin/files/:id', () => {
  it('redirects to a presigned link that lives 5 minutes, with the stored name as the download name', async () => {
    const id = await insertFile('staff', staff.staffId, 'Xiaomi EDL.zip');
    const res = await staff.get(`/admin/files/${id}`);
    expect(res.status).toBe(302);
    expect(res.res.body).toBe('');
    expect(res.res.headers['cache-control']).toBe('no-store');
    const link = linkOf(res.res.headers.location);
    expect(link.searchParams.get('X-Amz-Expires')).toBe('300');
    expect(link.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
    expect(decodeURIComponent(link.searchParams.get('response-content-disposition') ?? '')).toContain('attachment');
    expect(decodeURIComponent(link.searchParams.get('response-content-disposition') ?? '')).toContain('Xiaomi EDL.zip');
    expect(link.pathname).toContain('/gsm-files');
  });

  it('serves an upload nothing uses, and a listing picture, with files:read alone', async () => {
    const upload = await insertFile('staff', staff.staffId, 'picture.png');
    expect((await staff.get(`/admin/files/${upload}`)).status).toBe(302);
    // The logo of a payment method is public anyway: no record kind of the list claims it.
    const logo = await insertFile('staff', staff.staffId, 'logo.png');
    await insertGateway(t, world.db, { logoFileId: logo });
    expect((await staff.get(`/admin/files/${logo}`)).status).toBe(302);
  });

  it('needs clients:read to open a merchant upload nothing uses yet, and customers:read for a customer upload', async () => {
    const merchantUpload = await insertFile('client', world.other.id, 'passport-not-submitted.pdf');
    const denied = await staff.get(`/admin/files/${merchantUpload}`);
    expect(denied.status).toBe(403);
    expect(denied.body.detail).toBe('You need the clients:read permission to do this.');
    const customer = await insertCustomer(world.db);
    const customerUpload = await insertFile('customer', customer.id, 'receipt.png');
    const deniedCustomer = await staff.get(`/admin/files/${customerUpload}`);
    expect(deniedCustomer.status).toBe(403);
    expect(deniedCustomer.body.detail).toBe('You need the customers:read permission to do this.');
    const reader = await adminWith(t, ['files:read', 'clients:read', 'customers:read']);
    expect((await reader.get(`/admin/files/${merchantUpload}`)).status).toBe(302);
    expect((await reader.get(`/admin/files/${customerUpload}`)).status).toBe(302);
  });

  it('needs clients:read to open an identity document stored earlier, and audits every download under the merchant', async () => {
    const file = await insertFile('client', world.other.id, 'passport.pdf');
    const [submission] = await world.db
      .insert(s.kycSubmissions)
      .values({ clientId: world.other.id, fileIds: [file] })
      .returning();
    const denied = await staff.get(`/admin/files/${file}`);
    expect(denied.status).toBe(403);
    expect(denied.body).toMatchObject({
      code: 'FORBIDDEN',
      detail: 'You need the clients:read permission to do this.',
    });
    expect(await opened('opened an identity document of')).toHaveLength(0);

    const reader = await adminWith(t, ['files:read', 'clients:read'], { name: 'Nadia' });
    expect((await reader.get(`/admin/files/${file}`)).status).toBe(302);
    const [first] = await opened('opened an identity document of');
    expect(first).toMatchObject({
      entityType: 'merchant',
      entityId: world.other.id,
      entityLabel: world.other.name,
      actorId: reader.staffId,
      after: { fileId: file, kycSubmissionId: submission!.id },
    });
    expect((await reader.get(`/admin/files/${file}`)).status).toBe(302);
    expect(await opened('opened an identity document of')).toHaveLength(2);
  });

  it('needs payments:read to open a payment receipt, and audits it under the payment', async () => {
    const receipt = await insertFile('client', world.merchant.id, 'receipt.pdf');
    const gatewayId = await insertGateway(t, world.db);
    const invoice = await insertInvoiceRow(world.db, world.merchant.id);
    const payment = await insertPendingPayment(world.db, invoice, gatewayId, { receiptFileId: receipt });
    const denied = await staff.get(`/admin/files/${receipt}`);
    expect(denied.status).toBe(403);
    expect(denied.body.detail).toBe('You need the payments:read permission to do this.');
    expect(await opened('opened the payment proof of')).toHaveLength(0);

    const reader = await adminWith(t, ['files:read', 'payments:read']);
    expect((await reader.get(`/admin/files/${receipt}`)).status).toBe(302);
    const rows = await opened('opened the payment proof of');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      entityType: 'payment',
      entityId: payment.id,
      entityLabel: `PAY-${payment.id}`,
      after: { fileId: receipt },
    });
  });

  it('adds the read permission of every other kind, and all of them for a file used twice', async () => {
    const { db, merchant, auto } = world;
    // An order result, an invoice PDF and a ticket attachment each need the permission of their own page, and write no audit row.
    const result = await insertFile('staff', staff.staffId, 'result.zip');
    await insertOrderRow(db, { clientId: merchant.id, serviceId: auto.serviceId, resultFileId: result });
    const pdf = await insertFile('staff', staff.staffId, 'invoice.pdf');
    await insertInvoiceRow(db, merchant.id, { pdfFileId: pdf });
    const attachment = await insertFile('client', merchant.id, 'screenshot.png');
    const customer = await insertCustomer(db);
    const ticket = await insertSupportTicket(db, { requesterId: customer.id });
    await insertSupportMessage(db, ticket.id, { authorType: 'customer', authorId: customer.id, fileIds: [attachment] });
    for (const [file, permission] of [
      [result, 'orders:read'],
      [pdf, 'invoices:read'],
      [attachment, 'support:read'],
    ] as const) {
      const denied = await staff.get(`/admin/files/${file}`);
      expect(denied.status, permission).toBe(403);
      expect(denied.body.detail, permission).toBe(`You need the ${permission} permission to do this.`);
      const reader = await adminWith(t, ['files:read', permission]);
      expect((await reader.get(`/admin/files/${file}`)).status, permission).toBe(302);
    }
    // A file that is an order's input and an identity document stored earlier needs both: the first missing one (in the order of the kinds) is named.
    const both = await insertFile('client', merchant.id, 'both.pdf');
    await insertOrderRow(db, {
      clientId: merchant.id,
      serviceId: auto.serviceId,
      inputFileId: both,
      imei: '358240051111110',
    });
    await db.insert(s.kycSubmissions).values({ clientId: merchant.id, fileIds: [both] });
    const ordersOnly = await adminWith(t, ['files:read', 'orders:read']);
    const refused = await ordersOnly.get(`/admin/files/${both}`);
    expect(refused.status).toBe(403);
    expect(refused.body.detail).toBe('You need the clients:read permission to do this.');
    const identityOnly = await adminWith(t, ['files:read', 'clients:read']);
    expect((await identityOnly.get(`/admin/files/${both}`)).body.detail).toBe(
      'You need the orders:read permission to do this.',
    );
    const everything = await adminWith(t, ['files:read', 'clients:read', 'orders:read']);
    expect((await everything.get(`/admin/files/${both}`)).status).toBe(302);
    // The kinds that are not audited leave no row.
    expect(await opened('opened the payment proof of')).toHaveLength(0);
    expect((await opened('opened an identity document of')).length).toBe(1);
  });

  it('needs disputes:read for the evidence of a dispute and customers:privacy for the file of a data request', async () => {
    const { db, merchant } = world;
    const customer = await insertCustomer(db);
    const gatewayId = await insertGateway(t, db);
    const invoice = await insertInvoiceRow(db, merchant.id);
    const payment = await insertPendingPayment(db, invoice, gatewayId);
    const evidence = await insertFile('staff', staff.staffId, 'evidence.pdf');
    await db.insert(s.disputes).values({
      paymentId: payment.id,
      customerId: customer.id,
      gatewayDisputeId: 'dp_evidence',
      reasonCode: 'fraudulent',
      amount: '10.0000',
      currency: 'USD',
      evidenceDueAt: new Date('2026-12-01T00:00:00.000Z'),
      evidenceFileIds: [evidence],
    });
    const exported = await insertFile('staff', staff.staffId, 'export.zip');
    await db.insert(s.dataRequests).values({
      customerId: customer.id,
      kind: 'export',
      status: 'completed',
      dueAt: new Date('2026-12-01T00:00:00.000Z'),
      fileId: exported,
    });
    for (const [file, permission] of [
      [evidence, 'disputes:read'],
      [exported, 'customers:privacy'],
    ] as const) {
      // files:read alone is refused, naming the permission of the record that uses the file; another page's permission does not help.
      const denied = await staff.get(`/admin/files/${file}`);
      expect(denied.status, permission).toBe(403);
      expect(denied.body.detail, permission).toBe(`You need the ${permission} permission to do this.`);
      const other = await adminWith(t, ['files:read', 'orders:read', 'customers:read']);
      expect((await other.get(`/admin/files/${file}`)).status, permission).toBe(403);
      const reader = await adminWith(t, ['files:read', permission]);
      expect((await reader.get(`/admin/files/${file}`)).status, permission).toBe(302);
    }
    // Neither kind is audited as an identity document or a payment proof.
    expect(await opened('opened an identity document of')).toHaveLength(0);
    expect(await opened('opened the payment proof of')).toHaveLength(0);
  });

  it('answers 404 for an unknown id, 403 without files:read, 401 without a session and 422 for a bad id', async () => {
    const id = await insertFile('client', world.merchant.id);
    const missing = await staff.get('/admin/files/999999');
    expect(missing.status).toBe(404);
    expect(missing.body).toMatchObject({ code: 'NOT_FOUND', detail: 'No file with this id.' });
    const nobody = await adminWith(t, ['orders:read']);
    expect((await nobody.get(`/admin/files/${id}`)).status).toBe(403);
    expect((await staff.anonymous('GET', `/admin/files/${id}`)).status).toBe(401);
    expect((await staff.get('/admin/files/abc')).status).toBe(422);
  });
});

describe('GET /client/files/:id', () => {
  it('redirects a merchant to its own upload, and to the input or result file of its own order', async () => {
    const { db, merchant, auto } = world;
    const upload = await insertFile('client', merchant.id, 'input.bin');
    const result = await insertFile('staff', staff.staffId, 'result.zip');
    const input = await insertFile('client', world.other.id, 'someone-elses-name.bin');
    await insertOrderRow(db, { clientId: merchant.id, serviceId: auto.serviceId, resultFileId: result });
    const portal = await portalFor(t, merchant.id);
    for (const id of [upload, result]) {
      const res = await portal.get(`/client/files/${id}`);
      expect(res.statusCode).toBe(302);
      expect(res.body).toBe('');
      expect(res.headers['cache-control']).toBe('no-store');
      expect(linkOf(res.headers.location).searchParams.get('X-Amz-Expires')).toBe('300');
    }
    // The other merchant's upload is not reachable until one of this merchant's orders points at it.
    expect((await portal.get(`/client/files/${input}`)).statusCode).toBe(404);
    await insertOrderRow(db, { clientId: merchant.id, serviceId: auto.serviceId, inputFileId: input, imei: 'x' });
    expect((await portal.get(`/client/files/${input}`)).statusCode).toBe(302);
  });

  it("answers 404 for another merchant's file and an unknown id, never 403", async () => {
    const { other, merchant } = world;
    const foreign = await insertFile('client', other.id);
    const staffFile = await insertFile('staff', staff.staffId);
    const portal = await portalFor(t, merchant.id);
    for (const id of [foreign, staffFile, 999999]) {
      const res = await portal.get(`/client/files/${id}`);
      expect(res.statusCode).toBe(404);
      expect(json(res).code).toBe('NOT_FOUND');
    }
  });

  it('lets a merchant waiting for approval read its own uploads (B153) but nothing of its orders', async () => {
    const { db } = world;
    const pendingId = await insertMerchant(db, { status: 'pending' });
    const own = await insertFile('client', pendingId, 'document.pdf');
    const portal = await portalFor(t, pendingId);
    expect((await portal.get(`/client/files/${own}`)).statusCode).toBe(302);
    expect((await portal.get('/client/orders')).statusCode).toBe(403);
  });

  it('refuses a call without a session and a suspended merchant', async () => {
    const { db, merchant } = world;
    const id = await insertFile('client', merchant.id);
    expect((await t.app.inject({ method: 'GET', url: `/client/files/${id}` })).statusCode).toBe(401);
    const portal = await portalFor(t, merchant.id);
    await db.update(s.clients).set({ status: 'suspended' }).where(eq(s.clients.id, merchant.id));
    await clearIdentityCaches(t);
    const res = await portal.get(`/client/files/${id}`);
    expect(res.statusCode).toBe(403);
    expect(json(res).code).toBe('ACCOUNT_SUSPENDED');
  });
});
