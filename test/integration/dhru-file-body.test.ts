// Integration tests of the Dhru form body limit (P4a, MISMATCHES B166): a `placefileorder` whose FILEDATA takes the form over 1 MiB is placed;
// a form over the upload size is refused in the Dhru envelope; every other route and the JSON body of the Dhru route keep 1 MiB; a large form
// body is counted by the per-IP `upload` limiter before its credentials are read.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { MULTIPART_MAX_BYTES } from '../../src/common/multipart';
import { schema as s } from '../../src/infra/db';
import { MaintenanceService } from '../../src/modules/platform';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches } from '../support/auth';
import { insertCategory, insertService } from '../support/catalog';
import { TestClock } from '../support/clock';
import { closeTestDb, resetDb, testDb } from '../support/db';
import {
  type MachineCredentials,
  body,
  clearApiKeyCaches,
  credentialsFor,
  dhruClient,
  dhruParameters,
  v1Client,
} from '../support/machine-orders';
import { type OrdersWorld, orderRow, ordersWorld } from '../support/orders';
import { freshClientIp } from '../support/pipeline-routes';

const MIB = 1024 * 1024;
const clock = new TestClock();
let t: TestApp;
let world: OrdersWorld;
let creds: MachineCredentials;
let dhru: ReturnType<typeof dhruClient>;
let fileServiceId: number;

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
  creds = await credentialsFor(t, db, world.merchant.id);
  dhru = dhruClient(t, creds);
  const category = await insertCategory(db, { name: 'Files', type: 'file' });
  fileServiceId = await insertService(db, category, {
    type: 'file',
    name: 'Firmware flash',
    code: 'FILE-3',
    basePrice: '3.0000',
  });
});

/** The message of an ERROR answer. */
const messageOf = (answer: { ERROR?: Array<{ MESSAGE: string }> }) => answer.ERROR?.[0]?.MESSAGE;

/** Bytes that do not compress to nothing and are not all alike. */
const bytesOf = (size: number): Buffer =>
  Buffer.from(Array.from({ length: size }, (_, index) => (index * 31 + 7) & 0xff));

describe('placefileorder with FILEDATA over 1 MiB', () => {
  it('places a file just over 1 MiB: the form body is about 1.8 times the file, and the action runs', async () => {
    const { db } = await testDb();
    const data = bytesOf(MIB + 1024);
    const answer = await dhru.call('placefileorder', {
      ID: fileServiceId,
      FILENAME: 'big.bin',
      FILEDATA: data.toString('base64'),
    });
    expect(answer.SUCCESS[0].MESSAGE).toBe('Order received');
    const order = await orderRow(db, Number(answer.SUCCESS[0].REFERENCEID));
    const [file] = await db.select().from(s.files).where(eq(s.files.id, order.inputFileId!));
    expect(file).toMatchObject({ filename: 'big.bin', size: data.length, ownerType: 'client' });
    expect(file!.sha256).toBe(createHash('sha256').update(data).digest('hex'));
  });

  it('refuses a form over the upload size in the Dhru envelope, with no order and no file', async () => {
    const { db } = await testDb();
    // 15 MiB of file is about 28 MB of form (base64 inside base64): over the 25.25 MiB limit.
    const data = bytesOf(15 * MIB);
    const form = new URLSearchParams({
      username: creds.username,
      apiaccesskey: creds.key,
      action: 'placefileorder',
      parameters: dhruParameters({ ID: fileServiceId, FILENAME: 'huge.bin', FILEDATA: data.toString('base64') }),
    }).toString();
    expect(form.length).toBeGreaterThan(MULTIPART_MAX_BYTES);
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/index.php',
      remoteAddress: freshClientIp(),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: form,
    });
    expect(res.statusCode).toBe(200);
    expect(messageOf(body(res))).toBe('The request is too large. Send a file as a multipart file part, up to 25 MiB.');
    expect(await db.select().from(s.orders)).toHaveLength(0);
    expect(await db.select().from(s.files)).toHaveLength(0);
  });

  it("still takes a file over 1 MiB as a multipart part, and refuses one over 25 MiB with the action's own message", async () => {
    const small = await dhru.multipart(
      'placefileorder',
      { ID: fileServiceId },
      { name: 'flash.bin', type: 'application/octet-stream', data: new Uint8Array(2 * MIB) },
    );
    expect(body(small).SUCCESS[0].MESSAGE).toBe('Order received');
    const big = await dhru.multipart(
      'placefileorder',
      { ID: fileServiceId, FILENAME: 'other.bin' },
      { name: 'big.bin', type: 'application/octet-stream', data: new Uint8Array(25 * MIB + 1) },
    );
    expect(messageOf(body(big))).toBe('The file is larger than 25 MiB.');
  });
});

describe('a multipart body over the upload size', () => {
  it('says only that a file can be up to 25 MiB (it already is multipart), in the Dhru envelope, with no order and no file', async () => {
    const { db } = await testDb();
    // The whole body (file plus fields) is over the 25.25 MiB limit, so it is refused before the action reads the file part.
    const big = await dhru.multipart(
      'placefileorder',
      { ID: fileServiceId, FILENAME: 'huge.bin' },
      { name: 'huge.bin', type: 'application/octet-stream', data: new Uint8Array(26 * MIB) },
    );
    expect(big.statusCode).toBe(200);
    expect(messageOf(body(big))).toBe('The request is too large. A file can be up to 25 MiB.');
    expect(await db.select().from(s.orders)).toHaveLength(0);
    expect(await db.select().from(s.files)).toHaveLength(0);
  });
});

describe('every other body keeps the general 1 MiB limit', () => {
  it('refuses a JSON body over 1 MiB on a REST v1 route, and a form body over 1 MiB on a route that takes none', async () => {
    const v1 = v1Client(t, creds.key);
    const json = await v1.post('/v1/orders', { serviceId: world.auto.serviceId, imei: 'x'.repeat(MIB + 1) });
    expect(json.statusCode).toBe(413);
    expect(body(json).code).toBe('PAYLOAD_TOO_LARGE');
    const form = await t.app.inject({
      method: 'POST',
      url: '/v1/orders',
      remoteAddress: freshClientIp(),
      headers: { authorization: `Bearer ${creds.key}`, 'content-type': 'application/x-www-form-urlencoded' },
      payload: `imei=${'x'.repeat(MIB + 1)}`,
    });
    expect(form.statusCode).toBe(413);
  });

  it('holds a JSON body of the Dhru endpoint itself to 1 MiB', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/index.php',
      remoteAddress: freshClientIp(),
      payload: { username: creds.username, apiaccesskey: creds.key, action: 'accountinfo', pad: 'x'.repeat(MIB + 1) },
    });
    expect(res.statusCode).toBe(200);
    expect(messageOf(body(res))).toBe('The request body is larger than this endpoint accepts.');
  });
});

describe('a large form body before the credentials are known', () => {
  it('is counted per client IP: the 21st within a minute is refused, before the key is read', async () => {
    const ip = freshClientIp();
    const attempt = () =>
      t.app.inject({
        method: 'POST',
        url: '/api/index.php',
        remoteAddress: ip,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: new URLSearchParams({
          username: 'nobody',
          apiaccesskey: 'gsm_wrongwrongwrongwrongwrong',
          action: 'accountinfo',
          pad: 'x'.repeat(MIB + 1),
        }).toString(),
      });
    for (let count = 1; count <= 20; count++) {
      expect(messageOf(body(await attempt())), `attempt ${count}`).toBe('Authentication Failed');
    }
    const refused = await attempt();
    expect(messageOf(body(refused))).not.toBe('Authentication Failed');
    expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
  });
});
