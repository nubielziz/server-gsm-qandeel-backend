// Integration tests of the public service pictures (feature 22): the console upload and removal (POST and DELETE
// /admin/service-listings/:id/image) with every refusal, the stored object and file row, the language rows, the audit, and the public
// media route (GET /store/v1/media/:name) with its headers, its limiter and the names it refuses.
import { afterAll, beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { LightMyRequestResponse } from 'fastify';
import { schema as s } from '@src/infra/db';
import { RateLimitService } from '@src/infra/rate-limit';
import { StorageService } from '@src/infra/storage';
import { type AdminApi, adminWith } from '../../support/admin-api';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches } from '../../support/auth';
import { TestClock } from '../../support/clock';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { containsText, jpegImage, pngImage, webpImage } from '../../support/images';
import { multipartRequest } from '../../support/machine-orders';
import { freshClientIp } from '../../support/pipeline-routes';
import { CONSOLE_ORIGIN } from '../../support/staff-console';
import { type StorefrontWorld, storefrontWorld } from '../../support/storefront';

const clock = new TestClock('2026-11-07T12:00:00.000Z');
let t: TestApp;
let admin: AdminApi;
let world: StorefrontWorld;

beforeAll(async () => {
  t = await createTestApp({ clock });
});
beforeEach(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  admin = await adminWith(t, ['storefront:*'], { name: 'Rami K.' });
  world = await storefrontWorld((await testDb()).db);
});
afterAll(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await t.close();
  await closeTestDb();
});

const sha256 = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test bodies are untyped JSON
const json = (res: LightMyRequestResponse): any => JSON.parse(res.body);

/** Uploads a picture as the console does (session cookie, CSRF token, console origin), from a fresh address. */
function upload(
  listingId: number,
  data: Uint8Array,
  options: { name?: string; type?: string; as?: AdminApi; csrf?: boolean } = {},
) {
  const form = new FormData();
  form.set('file', new File([data], options.name ?? 'photo.jpg', { type: options.type ?? 'image/jpeg' }));
  const session = (options.as ?? admin).session;
  const headers = options.csrf === false ? { ...session.headers } : { ...session.mutationHeaders };
  return multipartRequest(t, `/admin/service-listings/${listingId}/image`, form, {
    ...headers,
    origin: CONSOLE_ORIGIN,
  });
}

const media = (path: string, method: 'GET' | 'HEAD' = 'GET') =>
  t.app.inject({ method, url: path, remoteAddress: freshClientIp() });

const listingRows = async (serviceId: number) =>
  (await testDb()).db
    .select()
    .from(s.serviceListings)
    .where(eq(s.serviceListings.serviceId, serviceId))
    .orderBy(s.serviceListings.id);

const fileRows = async () => (await testDb()).db.select().from(s.files).orderBy(s.files.id);
const auditActions = async () =>
  (await (await testDb()).db.select().from(s.auditLogs).orderBy(s.auditLogs.id)).map((row) => row.action);

describe('POST /admin/service-listings/:id/image', () => {
  it("cleans and stores the picture once under its SHA-256, links it to the service's one listing and audits it", async () => {
    const input = jpegImage(640, 480, { exifOrientation: 1, comment: 'shot by Rami', tail: new Uint8Array([1, 2, 3]) });
    const clean = jpegImage(640, 480);
    const name = `${sha256(clean)}.jpg`;

    const res = await upload(world.att.listingId, input, { name: '../../evil‮gpj.jpg' });
    expect(res.statusCode).toBe(200);
    const listing = json(res);
    expect(listing.imageUrl).toBe(`/store/v1/media/${name}`);
    expect(listing.descriptionMd).toBeDefined();

    const [file] = await fileRows();
    expect(file).toMatchObject({
      key: `media/${name}`,
      mime: 'image/jpeg',
      size: clean.length,
      sha256: sha256(clean),
      ownerType: 'staff',
      ownerId: admin.staffId,
      filename: 'evilgpj.jpg',
    });
    const rows = await listingRows(world.att.serviceId);
    expect(rows.map((row) => [row.id, row.imageFileId])).toEqual([[world.att.listingId, file!.id]]);
    // Another service's listing keeps its own (no) picture.
    expect((await listingRows(world.icloud.serviceId)).map((row) => row.imageFileId)).toEqual([null]);
    // The stored object is the cleaned picture: no EXIF, no comment, no tail.
    const object = await t.app.get(StorageService).get(`media/${name}`);
    const chunks: Buffer[] = [];
    for await (const chunk of object!.body) chunks.push(chunk as Buffer);
    const stored = Buffer.concat(chunks);
    expect(stored.equals(Buffer.from(clean))).toBe(true);
    expect(containsText(stored, 'shot by Rami')).toBe(false);

    const [audit] = await (await testDb()).db.select().from(s.auditLogs);
    expect(audit).toMatchObject({
      action: 'uploaded image for',
      entityType: 'listing',
      entityId: world.att.listingId,
      entityLabel: 'AT&T USA Premier Unlock',
      before: { image: null },
      after: { image: name, width: 640, height: 480, size: clean.length },
    });
  });

  it('keeps one object and one file row for the same picture, also for another service, and audits the replaced name', async () => {
    const first = await upload(world.att.listingId, pngImage(300, 300, { text: 'a' }), { type: 'image/png' });
    const again = await upload(world.icloud.listingId, pngImage(300, 300), { name: 'x.png', type: 'image/png' });
    expect(first.statusCode).toBe(200);
    expect(again.statusCode).toBe(200);
    expect(json(again).imageUrl).toBe(json(first).imageUrl);
    expect(await fileRows()).toHaveLength(1);

    const replaced = await upload(world.att.listingId, webpImage(300, 300), { type: 'image/webp' });
    expect(json(replaced).imageUrl).toMatch(/^\/store\/v1\/media\/[0-9a-f]{64}\.webp$/);
    // The old file stays (the other service still shows it).
    expect(await fileRows()).toHaveLength(2);
    const audits = await (await testDb()).db.select().from(s.auditLogs).orderBy(s.auditLogs.id);
    expect(audits[2]!.before).toEqual({ image: (json(first).imageUrl as string).slice('/store/v1/media/'.length) });
  });

  it('refuses each picture that is not a clean still JPEG, PNG or WebP with 422 on file and its code, storing nothing', async () => {
    const cases: Array<[string, Uint8Array, string]> = [
      [
        'an SVG declared as PNG',
        new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'),
        'unsupported_type',
      ],
      ['an empty file', new Uint8Array(), 'empty'],
      ['a truncated JPEG', jpegImage(400, 300).subarray(0, 60), 'corrupt'],
      ['an animated PNG', pngImage(300, 300, { animated: true }), 'animated'],
      ['a small picture', pngImage(199, 300), 'too_small'],
      ['a huge picture', webpImage(4097, 300), 'too_large_dimensions'],
      ['a rotated JPEG', jpegImage(400, 300, { exifOrientation: 6 }), 'rotated'],
    ];
    for (const [label, data, code] of cases) {
      const res = await upload(world.att.listingId, data, { type: 'image/png' });
      expect(res.statusCode, label).toBe(422);
      expect(json(res).code, label).toBe('VALIDATION_FAILED');
      expect(json(res).errors, label).toEqual([{ field: 'file', code, message: expect.any(String) }]);
    }
    expect(json(await upload(world.att.listingId, jpegImage(400, 300, { exifOrientation: 6 }))).errors[0].message).toBe(
      'Save the picture upright and upload it again.',
    );
    expect(await fileRows()).toEqual([]);
    expect((await listingRows(world.att.serviceId))[0]!.imageFileId).toBeNull();
  });

  it('answers 413 over 2 MiB, 422 on file for a JSON body and 415 for a body type it does not read', async () => {
    const big = new Uint8Array(2 * 1024 * 1024 + 1);
    big.set(jpegImage(400, 300));
    const tooLarge = await upload(world.att.listingId, big);
    expect(tooLarge.statusCode).toBe(413);
    expect(json(tooLarge).code).toBe('PAYLOAD_TOO_LARGE');

    const jsonBody = await admin.post(`/admin/service-listings/${world.att.listingId}/image`, { file: 'x' });
    expect(jsonBody.status).toBe(422);
    expect(jsonBody.body.errors[0].field).toBe('file');

    const text = await t.app.inject({
      method: 'POST',
      url: `/admin/service-listings/${world.att.listingId}/image`,
      headers: { ...admin.session.mutationHeaders, origin: CONSOLE_ORIGIN, 'content-type': 'application/xml' },
      payload: '<file/>',
      remoteAddress: freshClientIp(),
    });
    expect(text.statusCode).toBe(415);
    expect(await fileRows()).toEqual([]);
  });

  it('refuses a staff member without storefront:update (403), a request without the CSRF token and an unknown listing (404)', async () => {
    const reader = await adminWith(t, ['storefront:read']);
    const forbidden = await upload(world.att.listingId, jpegImage(400, 300), { as: reader });
    expect(forbidden.statusCode).toBe(403);
    expect(json(forbidden).code).toBe('FORBIDDEN');

    const noCsrf = await upload(world.att.listingId, jpegImage(400, 300), { csrf: false });
    expect(noCsrf.statusCode).toBe(403);
    expect(json(noCsrf).code).toBe('CSRF_FAILED');

    const missing = await upload(999_999, jpegImage(400, 300));
    expect(missing.statusCode).toBe(404);
    expect(await fileRows()).toEqual([]);
  });

  it('counts the upload against the upload limiter of the address', async () => {
    const enforce = spyOn(t.app.get(RateLimitService), 'enforce');
    try {
      await upload(world.att.listingId, jpegImage(400, 300));
      expect(enforce.mock.calls.map((call) => call[0])).toContain('upload');
    } finally {
      enforce.mockRestore();
    }
  });
});

describe('DELETE /admin/service-listings/:id/image', () => {
  it('removes the picture of the listing, keeps the file, audits it, and answers 204 again when there is none', async () => {
    const name = (json(await upload(world.att.listingId, jpegImage(400, 300))).imageUrl as string).slice(
      '/store/v1/media/'.length,
    );

    const removed = await admin.delete(`/admin/service-listings/${world.att.listingId}/image`);
    expect(removed.status).toBe(204);
    expect((await listingRows(world.att.serviceId)).map((row) => row.imageFileId)).toEqual([null]);
    expect(await fileRows()).toHaveLength(1);
    expect((await admin.get(`/admin/service-listings/${world.att.listingId}`)).body.imageUrl).toBeNull();

    expect((await admin.delete(`/admin/service-listings/${world.att.listingId}/image`)).status).toBe(204);
    expect(await auditActions()).toEqual(['uploaded image for', 'removed image of', 'removed image of']);
    const audits = await (await testDb()).db.select().from(s.auditLogs).orderBy(s.auditLogs.id);
    expect(audits[1]).toMatchObject({ before: { image: name }, after: { image: null } });
  });

  it('answers 404 for an unknown listing and 403 without storefront:update', async () => {
    expect((await admin.delete('/admin/service-listings/999999/image')).status).toBe(404);
    const reader = await adminWith(t, ['storefront:read']);
    expect((await reader.delete(`/admin/service-listings/${world.att.listingId}/image`)).status).toBe(403);
  });
});

describe('the picture on the listings and the cards', () => {
  it('shows imageUrl on the admin rows, the public cards and the page', async () => {
    const url = json(await upload(world.icloud.listingId, jpegImage(400, 300))).imageUrl as string;

    const rows = (await admin.get('/admin/service-listings')).body as Array<{ id: number; imageUrl: string | null }>;
    expect(rows.find((row) => row.id === world.icloud.listingId)?.imageUrl).toBe(url);
    expect(rows.find((row) => row.id === world.att.listingId)?.imageUrl).toBeNull();

    const cards = json(await t.app.inject({ method: 'GET', url: '/store/v1/services' })) as Array<{
      slug: string;
      imageUrl: string | null;
    }>;
    expect(cards.map((card) => [card.slug, card.imageUrl])).toEqual([
      [world.icloud.slug, url],
      [world.att.slug, null],
    ]);
    expect(json(await t.app.inject({ method: 'GET', url: `/store/v1/services/${world.icloud.slug}` })).imageUrl).toBe(
      url,
    );
  });
});

describe('GET /store/v1/media/:name', () => {
  it('serves the stored bytes with the immutable cache, the real type, the ETag and the cross-origin headers', async () => {
    const url = json(await upload(world.att.listingId, webpImage(300, 300, { metadata: true }), { type: 'image/webp' }))
      .imageUrl as string;
    const clean = webpImage(300, 300, { metadata: true });
    const res = await media(url);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/webp');
    expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(res.headers.etag).toBe(`"${url.slice('/store/v1/media/'.length, -'.webp'.length)}"`);
    expect(res.headers['content-disposition']).toBe('inline');
    expect(res.headers['cross-origin-resource-policy']).toBe('cross-origin');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    const served = new Uint8Array(res.rawPayload);
    expect(sha256(served)).toBe(url.slice('/store/v1/media/'.length, -'.webp'.length));
    expect(containsText(served, 'xmpmeta')).toBe(false);
    expect(served.length).toBeLessThan(clean.length);
  });

  it('answers 404 for names of another form, a private object and a picture that does not exist, without leaking it', async () => {
    const storage = t.app.get(StorageService);
    await storage.put('kyc/client-1/secret', 'passport scan', { contentType: 'image/jpeg' });
    const name = (json(await upload(world.att.listingId, jpegImage(400, 300))).imageUrl as string).slice(
      '/store/v1/media/'.length,
    );
    const hash = name.slice(0, 64);
    for (const path of [
      `/store/v1/media/${hash.toUpperCase()}.jpg`,
      `/store/v1/media/${hash}.gif`,
      `/store/v1/media/${hash}.jpg.png`,
      `/store/v1/media/${'0'.repeat(64)}.jpg`,
      '/store/v1/media/..%2fkyc%2fclient-1%2fsecret',
      '/store/v1/media/..%2F..%2Fkyc%2Fclient-1%2Fsecret',
      '/store/v1/media/kyc%2Fclient-1%2Fsecret',
      '/store/v1/media/secret',
    ]) {
      const res = await media(path);
      expect(res.statusCode, path).toBe(404);
      expect(res.body, path).not.toContain('passport');
    }
    expect((await media(`/store/v1/media/${name}`)).statusCode).toBe(200);
  });

  it('charges the media limiter, not the ip limiter of the API', async () => {
    const enforce = spyOn(t.app.get(RateLimitService), 'enforce');
    try {
      await media(`/store/v1/media/${'0'.repeat(64)}.png`);
      expect(enforce.mock.calls.map((call) => call[0])).toEqual(['media']);
    } finally {
      enforce.mockRestore();
    }
  });
});
