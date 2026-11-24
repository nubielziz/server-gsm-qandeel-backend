// Integration tests of the merchants' file uploads (feature 7a, MISMATCHES B157): POST /client/files and GET /client/files/:id, the limits,
// the owner rule, the name and media type clean-up, and a File service order that uses the upload.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { eq } from 'drizzle-orm';
import { schema as s } from '@src/infra/db';
import { StorageService } from '@src/infra/storage';
import { SESSION_COOKIE_NAMES } from '@src/modules/identity';
import { MaintenanceService } from '@src/modules/platform';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches } from '../../support/auth';
import { insertGateway, insertInvoiceRow, insertPendingPayment } from '../../support/billing';
import { insertCategory, insertService } from '../../support/catalog';
import { TestClock } from '../../support/clock';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { body, clearApiKeyCaches, multipartRequest } from '../../support/machine-orders';
import { type OrdersWorld, insertOrderRow, json, ordersWorld, portalFor } from '../../support/orders';
import { freshClientIp } from '../../support/pipeline-routes';
import { insertCustomer, insertSupportMessage, insertSupportTicket } from '../../support/support';

const clock = new TestClock();
let t: TestApp;
let world: OrdersWorld;

beforeAll(async () => {
  t = await createTestApp({ clock });
});
afterAll(async () => {
  await resetDb();
  await t.close();
  await closeTestDb();
});
beforeEach(async () => {
  clock.reset();
  await resetDb();
  await clearIdentityCaches(t);
  await clearApiKeyCaches(t);
  await t.app.get(MaintenanceService).invalidate();
  const { db } = await testDb();
  world = await ordersWorld(db);
});

const bytes = (text: string) => new TextEncoder().encode(text);
const sha256 = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');

describe('POST /client/files: the session is judged before the body is read (decision 053)', () => {
  const MIB = 1024 * 1024;

  /** Sends 30 MiB of a multipart body in chunks, without a length, and counts the chunks the server asked for. */
  async function chunked(
    headers: Record<string, string>,
    { url = '/client/files', contentType = 'multipart/form-data; boundary=gsm' } = {},
  ) {
    let produced = 0;
    function* chunks() {
      for (let index = 0; index < 30; index += 1) {
        produced += 1;
        yield Buffer.alloc(MIB, 97);
      }
    }
    const res = await t.app.inject({
      method: 'POST',
      url,
      remoteAddress: freshClientIp(),
      headers: { ...headers, 'content-type': contentType },
      payload: Readable.from(chunks()),
    });
    return { res, produced: () => produced };
  }

  it('reads a multipart body of the portal only with a live session', async () => {
    const none = await chunked({});
    expect(none.res.statusCode).toBe(401);
    expect(body(none.res)).toMatchObject({ code: 'UNAUTHORIZED' });
    // The server never asked for the body: it answered at the request's headers.
    expect(none.produced()).toBeLessThan(5);
    // A random cookie of the right shape names no session: refused the same way, before the body.
    const random = await chunked({ cookie: `${SESSION_COOKIE_NAMES.client}=${'a'.repeat(43)}` });
    expect(random.res.statusCode).toBe(401);
    expect(random.produced()).toBeLessThan(5);
    // The cookie of another audience (staff) is not a merchant session.
    const staff = await chunked({ cookie: `${SESSION_COOKIE_NAMES.staff}=${'a'.repeat(43)}` });
    expect(staff.res.statusCode).toBe(401);
  });

  it('judges a content type that starts with whitespace the way the body parser reads it', async () => {
    // Fastify drops leading whitespace (a leading U+00A0 reaches the server as a header byte) before it picks the multipart parser.
    for (const contentType of ['\u00a0multipart/form-data; boundary=gsm', '\u000bMultipart/Form-Data; boundary=gsm']) {
      const none = await chunked({}, { contentType });
      expect(none.res.statusCode, JSON.stringify(contentType)).toBe(401);
      expect(body(none.res)).toMatchObject({ code: 'UNAUTHORIZED' });
      expect(none.produced(), JSON.stringify(contentType)).toBeLessThan(5);
      const random = await chunked({ cookie: `${SESSION_COOKIE_NAMES.client}=${'a'.repeat(43)}` }, { contentType });
      expect(random.res.statusCode).toBe(401);
      expect(random.produced()).toBeLessThan(5);
    }
  });

  it('refuses a multipart body of a route that takes none before reading it, with a content type that starts with whitespace', async () => {
    for (const url of ['/admin/staff', '/client/orders']) {
      for (const contentType of ['multipart/form-data; boundary=gsm', '\u00a0multipart/form-data; boundary=gsm']) {
        const refused = await chunked({}, { url, contentType });
        expect(refused.res.statusCode, `${url} ${JSON.stringify(contentType)}`).toBe(415);
        expect(refused.produced(), `${url} ${JSON.stringify(contentType)}`).toBeLessThan(5);
      }
    }
  });

  it('a live session still uploads', async () => {
    const portal = await portalFor(t, world.merchant.id);
    const form = new FormData();
    form.set('file', new File([bytes('%PDF-1.4')], 'passport.pdf', { type: 'application/pdf' }));
    const res = await multipartRequest(t, '/client/files', form, portal.session.mutationHeaders);
    expect(res.statusCode).toBe(201);
  });

  it('judges a live session of a merchant that is not approved yet like any other: the guard decides the rest', async () => {
    const { db } = await testDb();
    await db.update(s.clients).set({ status: 'pending' }).where(eq(s.clients.id, world.merchant.id));
    const portal = await portalFor(t, world.merchant.id);
    const form = new FormData();
    form.set('file', new File([bytes('%PDF-1.4')], 'document.pdf', { type: 'application/pdf' }));
    const res = await multipartRequest(t, '/client/files', form, portal.session.mutationHeaders);
    // A merchant waiting for approval may upload (B153): the stage does not turn it away.
    expect(res.statusCode).toBe(201);
  });
});

describe('POST /client/files', () => {
  /** A multipart request with the merchant portal session and CSRF header. */
  async function upload(
    portal: Awaited<ReturnType<typeof portalFor>>,
    file: { name: string; data: Uint8Array; type?: string } | undefined,
    headers = portal.session.mutationHeaders,
  ) {
    const form = new FormData();
    if (file) form.set('file', new File([file.data], file.name, { type: file.type ?? 'application/pdf' }));
    return multipartRequest(t, '/client/files', form, headers);
  }

  it('stores the file for the signed-in merchant: 201, the row, the object, the size and the SHA-256, and the merchant can open it', async () => {
    const { db } = await testDb();
    const portal = await portalFor(t, world.merchant.id);
    const data = bytes('%PDF-1.4');
    const res = await upload(portal, { name: 'passport.pdf', data });
    expect(res.statusCode).toBe(201);
    const stored = body(res);
    expect(stored).toEqual({
      id: expect.any(Number),
      filename: 'passport.pdf',
      size: 8,
      mime: 'application/pdf',
      sha256: sha256(data),
      createdAt: expect.any(String),
    });
    const [row] = await db.select().from(s.files).where(eq(s.files.id, stored.id));
    expect(row).toMatchObject({ ownerType: 'client', ownerId: world.merchant.id, size: 8, sha256: sha256(data) });
    // The object key is built by the server, never from the name the client sent.
    expect(row!.key).toMatch(/^files\/\d{4}\/\d{2}\/[0-9a-f-]{36}$/);
    const object = await t.app.get(StorageService).get(row!.key);
    expect(object).not.toBeNull();
    expect(Buffer.from(await new Response(object!.body as unknown as ReadableStream).arrayBuffer()).toString()).toBe(
      '%PDF-1.4',
    );
    // No audit row for a merchant's own upload (B121).
    expect(await db.select().from(s.auditLogs)).toHaveLength(0);
    expect((await portal.get(`/client/files/${stored.id}`)).statusCode).toBe(302);
    const other = await portalFor(t, world.other.id);
    expect((await other.get(`/client/files/${stored.id}`)).statusCode).toBe(404);
  });

  it('reduces the name to a base name without control characters and reads the media type as type/subtype', async () => {
    const portal = await portalFor(t, world.merchant.id);
    const path = await upload(portal, {
      name: '..\\..\\etc/../passwd.txt',
      type: 'text/plain; charset=utf-8',
      data: bytes('x'),
    });
    expect(body(path)).toMatchObject({ filename: 'passwd.txt', mime: 'text/plain' });
    const long = await upload(portal, { name: `${'a'.repeat(300)}.zip`, type: 'application/zip', data: bytes('x') });
    expect(body(long).filename).toHaveLength(200);
    const odd = await upload(portal, { name: 'dots/..', type: 'not a type', data: bytes('x') });
    expect(body(odd)).toMatchObject({ filename: 'file', mime: 'application/octet-stream' });
  });

  it('needs a session and the CSRF token, refuses a missing or empty file, and an oversized one', async () => {
    const portal = await portalFor(t, world.merchant.id);
    const { cookie } = portal.session.mutationHeaders;
    expect((await upload(portal, { name: 'a.pdf', data: bytes('x') }, {})).statusCode).toBe(401);
    // The session cookie without the CSRF header is refused before the body is used.
    const noCsrf = await upload(portal, { name: 'a.pdf', data: bytes('x') }, { cookie: cookie ?? '' });
    expect(noCsrf.statusCode).toBe(403);
    expect(body(noCsrf).code).toBe('CSRF_FAILED');
    const none = await upload(portal, undefined);
    expect(none.statusCode).toBe(422);
    expect(body(none).errors[0]).toMatchObject({ field: 'file' });
    const empty = await upload(portal, { name: 'e.pdf', data: new Uint8Array(0) });
    expect(empty.statusCode).toBe(422);
    expect(body(empty).errors[0]).toMatchObject({ field: 'file', code: 'empty' });
    const big = await upload(portal, { name: 'big.pdf', data: new Uint8Array(25 * 1024 * 1024 + 1) });
    expect(big.statusCode).toBe(413);
    expect(body(big).code).toBe('PAYLOAD_TOO_LARGE');
    expect(await world.db.select().from(s.files)).toHaveLength(0);
    const exact = await upload(portal, { name: 'max.bin', data: new Uint8Array(25 * 1024 * 1024) });
    expect(exact.statusCode).toBe(201);
    expect(await world.db.select().from(s.files)).toHaveLength(1);
  });

  it('refuses a JSON body, a text field named file and a body that is not valid multipart', async () => {
    const portal = await portalFor(t, world.merchant.id);
    const asJson = await portal.post('/client/files', { file: 'text' });
    expect(asJson.statusCode).toBe(422);
    expect(body(asJson).errors[0].field).toBe('file');
    const form = new FormData();
    form.set('file', 'just text');
    const asText = await multipartRequest(t, '/client/files', form, portal.session.mutationHeaders);
    expect(asText.statusCode).toBe(422);
    const broken = await t.app.inject({
      method: 'POST',
      url: '/client/files',
      headers: { ...portal.session.mutationHeaders, 'content-type': 'multipart/form-data; boundary=xyz' },
      payload: '--xyz\r\nContent-Disposition: form-data; name="file"; filename="a.bin"\r\n\r\nno end boundary',
    });
    expect([400, 422]).toContain(broken.statusCode);
  });

  it('counts anonymous uploads per client IP and refuses the 21st within a minute, before reading the body', async () => {
    // An address of this run only: the limiter's counters live in the cache Redis across runs.
    const ip = freshClientIp();
    const anonymous = () => {
      const form = new FormData();
      form.set('file', new Blob([bytes('x'.repeat(64))], { type: 'text/plain' }), 'probe.txt');
      return multipartRequest(t, '/client/files', form, {}, ip);
    };
    for (let attempt = 1; attempt <= 20; attempt++)
      expect((await anonymous()).statusCode, `attempt ${attempt}`).toBe(401);
    const refused = await anonymous();
    expect(refused.statusCode).toBe(429);
    expect(refused.json<{ code: string }>().code).toBe('RATE_LIMITED');
    expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
    // Another address is not affected.
    const form = new FormData();
    form.set('file', new Blob([bytes('y')], { type: 'text/plain' }), 'probe.txt');
    expect((await multipartRequest(t, '/client/files', form, {}, freshClientIp())).statusCode).toBe(401);
  });

  it('lets a merchant waiting for approval upload its documents (B153), and is not blocked by order maintenance', async () => {
    const { db } = await testDb();
    await db.update(s.clients).set({ status: 'pending' }).where(eq(s.clients.id, world.merchant.id));
    const portal = await portalFor(t, world.merchant.id);
    expect((await upload(portal, { name: 'document.pdf', data: bytes('x') })).statusCode).toBe(201);
    await db.insert(s.settings).values({
      key: 'maintenance',
      value: {
        enabled: true,
        scope: 'api_orders',
        message: 'Orders are paused.',
        expectedEndAt: null,
        startedAt: '2026-03-01T11:00:00.000Z',
        startedBy: { id: 1, name: 'Rami K.' },
      },
    });
    await t.app.get(MaintenanceService).invalidate();
    expect((await upload(portal, { name: 'receipt.pdf', data: bytes('x') })).statusCode).toBe(201);
  });
});

describe('GET /client/files/:id', () => {
  /** Stores a file row (no object) for an owner. */
  async function insertFile(ownerType: string, ownerId: number, filename: string): Promise<number> {
    const [row] = await world.db
      .insert(s.files)
      .values({
        bucket: 'gsm-files-test',
        key: `files/${crypto.randomUUID()}.bin`,
        filename,
        mime: 'application/octet-stream',
        size: 10,
        sha256: 'a'.repeat(64),
        ownerType,
        ownerId,
      })
      .returning({ id: s.files.id });
    return row!.id;
  }

  it('redirects to a short-lived link for a file the merchant uploaded, and says 404 for anyone else file or an unknown id', async () => {
    const portal = await portalFor(t, world.merchant.id);
    const form = new FormData();
    form.set('file', new File([bytes('zip')], 'result.zip', { type: 'application/zip' }));
    const stored = body(await multipartRequest(t, '/client/files', form, portal.session.mutationHeaders));
    const res = await portal.get(`/client/files/${stored.id}`);
    expect(res.statusCode).toBe(302);
    expect(res.headers['cache-control']).toBe('no-store');
    const link = new URL(String(res.headers.location));
    expect(link.searchParams.get('X-Amz-Expires')).toBe('300');
    expect(decodeURIComponent(link.searchParams.get('response-content-disposition') ?? '')).toContain('result.zip');
    const other = await portalFor(t, world.other.id);
    const foreign = await other.get(`/client/files/${stored.id}`);
    expect(foreign.statusCode).toBe(404);
    expect(body(foreign).code).toBe('NOT_FOUND');
    expect((await portal.get('/client/files/999999')).statusCode).toBe(404);
    expect((await portal.get('/client/files/abc')).statusCode).toBe(422);
  });

  it('reaches the result file of one of the merchant orders', async () => {
    const { db, merchant, auto } = world;
    const result = await insertFile('staff', 1, 'out.zip');
    await insertOrderRow(db, { clientId: merchant.id, serviceId: auto.serviceId, resultFileId: result });
    const portal = await portalFor(t, merchant.id);
    expect((await portal.get(`/client/files/${result}`)).statusCode).toBe(302);
    const other = await portalFor(t, world.other.id);
    expect((await other.get(`/client/files/${result}`)).statusCode).toBe(404);
  });

  it('opens every file the merchant owns, whatever record uses it, and the files of its orders', async () => {
    const { db, merchant, auto } = world;
    const upload = await insertFile('client', merchant.id, 'unused.bin');
    const input = await insertFile('client', merchant.id, 'input.bin');
    const result = await insertFile('staff', 1, 'result.zip');
    await insertOrderRow(db, {
      clientId: merchant.id,
      serviceId: auto.serviceId,
      inputFileId: input,
      imei: '358240051111110',
    });
    await insertOrderRow(db, {
      clientId: merchant.id,
      serviceId: auto.serviceId,
      resultFileId: result,
      imei: '358240051111111',
    });
    // A document that a verification request stored earlier, a payment, a ticket or a dispute uses.
    const identity = await insertFile('client', merchant.id, 'identity.jpg');
    await db.insert(s.kycSubmissions).values({ clientId: merchant.id, fileIds: [identity] });
    const receipt = await insertFile('client', merchant.id, 'receipt.pdf');
    const invoice = await insertInvoiceRow(db, merchant.id);
    const payment = await insertPendingPayment(db, invoice, await insertGateway(t, db), { receiptFileId: receipt });
    const attachment = await insertFile('client', merchant.id, 'screenshot.png');
    const customer = await insertCustomer(db);
    const ticket = await insertSupportTicket(db, { requesterId: customer.id });
    await insertSupportMessage(db, ticket.id, { authorType: 'customer', authorId: customer.id, fileIds: [attachment] });
    const evidence = await insertFile('client', merchant.id, 'evidence.pdf');
    await db.insert(s.disputes).values({
      paymentId: payment.id,
      customerId: customer.id,
      gatewayDisputeId: 'dp_scope',
      reasonCode: 'fraudulent',
      amount: '10.0000',
      currency: 'USD',
      evidenceDueAt: new Date('2026-12-01T00:00:00.000Z'),
      evidenceFileIds: [evidence],
    });

    const portal = await portalFor(t, merchant.id);
    for (const id of [upload, input, result, identity, receipt, attachment, evidence]) {
      expect((await portal.get(`/client/files/${id}`)).statusCode, `file ${id}`).toBe(302);
    }
  });
});

describe('a File service order with an uploaded file', () => {
  async function fileService(): Promise<number> {
    const { db } = await testDb();
    const category = await insertCategory(db, { name: 'Files', type: 'file' });
    return insertService(db, category, { type: 'file', name: 'Firmware flash', code: 'FILE-3', basePrice: '3.0000' });
  }

  it('places the order with the fileId of the upload, and refuses the file of another merchant', async () => {
    const serviceId = await fileService();
    const portal = await portalFor(t, world.merchant.id);
    const form = new FormData();
    form.set('file', new File([bytes('flash')], 'flash.bin', { type: 'application/octet-stream' }));
    const stored = body(await multipartRequest(t, '/client/files', form, portal.session.mutationHeaders));
    const placed = await portal.post('/client/orders', { serviceId, fileId: stored.id });
    expect(placed.statusCode).toBe(201);
    expect(json(placed).orders[0]).toMatchObject({
      service: { type: 'file' },
      inputFileId: stored.id,
      totalPrice: '3.0000',
    });
    const other = await portalFor(t, world.other.id);
    const theirs = await other.post('/client/orders', { serviceId, fileId: stored.id });
    expect(theirs.statusCode).toBe(422);
    expect(json(theirs).errors[0]).toMatchObject({ field: 'fileId', code: 'invalid_file' });
    const none = await portal.post('/client/orders', { serviceId });
    expect(none.statusCode).toBe(422);
    expect(json(none).errors[0]).toMatchObject({ field: 'fileId', code: 'required' });
  });
});
