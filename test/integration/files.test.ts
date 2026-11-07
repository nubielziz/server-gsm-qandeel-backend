// Integration tests of the file downloads (feature 5, MISMATCHES B154): GET /admin/files/:id and GET /client/files/:id answer 302 to a
// presigned link that expires after 5 minutes; a merchant reaches only its own files, and anything else is 404.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { schema as s } from '../../src/infra/db';
import { type AdminApi, adminWith } from '../support/admin-api';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches, insertMerchant } from '../support/auth';
import { TestClock } from '../support/clock';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { insertOrderRow, json, type OrdersWorld, ordersWorld, portalFor } from '../support/orders';

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
    const id = await insertFile('client', world.merchant.id, 'Xiaomi EDL.zip');
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

  it('serves any file to a staff member who holds files:read (an order result, a KYC document)', async () => {
    const kyc = await insertFile('client', world.other.id, 'passport.pdf');
    expect((await staff.get(`/admin/files/${kyc}`)).status).toBe(302);
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
    const own = await insertFile('client', pendingId, 'kyc.pdf');
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
