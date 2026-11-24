// Integration tests of the ready-made payment methods (feature 32, spec B232): the catalog route and its permission, a method made from each
// available preset, the four 422 refusals, two methods from one preset, a preset that PATCH never changes, the logo upload, replacement and
// removal with their audit rows and refusals, the two new keys on every list of methods, and the proof that the money rules are untouched (a
// merchant's top-up through a Vodafone Cash or Binance Pay method is reviewed and credited as any manual method).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { LightMyRequestResponse } from 'fastify';
import { schema as s } from '@src/infra/db';
import { GATEWAY_PRESETS } from '@src/modules/money/domain/gateway-presets';
import { type AdminApi, adminWith } from '../../support/admin-api';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches } from '../../support/auth';
import { insertGateway, insertProofFile } from '../../support/billing';
import { MINUTE, TestClock } from '../../support/clock';
import { walletSettings } from '../../support/customer-wallet';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { insertUsd } from '../../support/fixtures';
import { jpegImage, pngImage, webpImage } from '../../support/images';
import { multipartRequest } from '../../support/machine-orders';
import { insertWalletMerchant } from '../../support/money';
import { freshClientIp } from '../../support/pipeline-routes';
import { CONSOLE_ORIGIN } from '../../support/staff-console';
import { STORE_ORIGIN, StoreClient, clearStoreRateLimits, makeCustomer } from '../../support/store';
import { portalFor } from '../../support/portal-orders';

const clock = new TestClock('2026-11-17T10:00:00.000Z');
let t: TestApp;
let admin: AdminApi;

beforeAll(async () => {
  t = await createTestApp({ clock, env: { SHOP_ORIGINS: STORE_ORIGIN } });
});
beforeEach(async () => {
  clock.set('2026-11-17T10:00:00.000Z');
  await resetDb();
  await clearIdentityCaches(t);
  await clearStoreRateLimits(t);
  admin = await adminWith(t, ['payments:gateways', 'payments:read', 'payments:approve'], { name: 'Rami K.' });
});
afterAll(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await t.close();
  await closeTestDb();
});

/** An Owner: only an Owner adds an automatic method, sends a secret or changes the driver of an automatic method (decision 046). */
const owner = () => adminWith(t, ['*'], { name: 'Owner' });

const sha256 = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test bodies are untyped JSON
const json = (res: LightMyRequestResponse): any => JSON.parse(res.body);
const MEDIA = '/store/v1/media/';

const preset = (key: string) => GATEWAY_PRESETS.find((entry) => entry.key === key)!;

/** The create body staff send after the console fills the form from a catalog entry (the account details written into the template). */
const fromPreset = (key: string, overrides: Record<string, unknown> = {}) => {
  const entry = preset(key);
  return {
    code: key.replace(/_/g, '-'),
    driver: entry.driver,
    name: entry.name,
    audience: 'both',
    feePercent: '0',
    feeFixed: '0',
    minAmount: '10',
    maxAmount: '5000',
    allowedGroupIds: [] as number[],
    supportsRefunds: false,
    supports3ds: false,
    isManual: entry.kind === 'manual',
    instructions: entry.instructions.replace(/________/g, '01000000000'),
    holdHours: 24,
    isActive: true,
    preset: key,
    ...overrides,
  };
};

/** A custom method (no preset), as staff add one from nothing. */
const custom = (overrides: Record<string, unknown> = {}) => ({
  ...fromPreset('bank_transfer'),
  code: 'cliq',
  driver: 'cliq',
  name: 'CliQ transfer',
  instructions: 'Send it by CliQ to GSMSHOP.',
  preset: undefined,
  ...overrides,
});

const gatewayRows = async () => (await testDb()).db.select().from(s.paymentGateways).orderBy(s.paymentGateways.id);
const fileRows = async () => (await testDb()).db.select().from(s.files).orderBy(s.files.id);
const audits = async () => (await testDb()).db.select().from(s.auditLogs).orderBy(s.auditLogs.id);

/** Uploads a logo as the console does (session cookie, CSRF token, console origin), from a fresh address. */
function uploadLogo(
  gatewayId: number,
  data: Uint8Array,
  options: { name?: string; type?: string; as?: AdminApi; csrf?: boolean } = {},
) {
  const form = new FormData();
  form.set('file', new File([data], options.name ?? 'logo.png', { type: options.type ?? 'image/png' }));
  const session = (options.as ?? admin).session;
  const headers = options.csrf === false ? { ...session.headers } : { ...session.mutationHeaders };
  return multipartRequest(t, `/admin/payment-gateways/${gatewayId}/logo`, form, { ...headers, origin: CONSOLE_ORIGIN });
}

describe('GET /admin/payment-gateway-presets', () => {
  it('answers the eight ready-made methods in order as a plain array, with the shape of the plan', async () => {
    const res = await admin.get('/admin/payment-gateway-presets');
    expect(res.status).toBe(200);
    expect(Number.isNaN(res.total)).toBe(true);
    expect(res.body.map((row: { key: string }) => row.key)).toEqual([
      'bank_transfer',
      'crypto_transfer',
      'vodafone_cash',
      'fawry_transfer',
      'instapay',
      'binance_pay',
      'nowpayments',
      'binance_pay_auto',
    ]);
    expect(Object.keys(res.body[0]).sort()).toEqual(
      ['available', 'driver', 'instructions', 'key', 'kind', 'methodType', 'name'].sort(),
    );
    expect(res.body[2]).toEqual({
      key: 'vodafone_cash',
      name: 'Vodafone Cash',
      kind: 'manual',
      available: true,
      driver: 'vodafone_cash',
      methodType: 'bank',
      instructions:
        'Send the amount to the Vodafone Cash number ________ and upload a screenshot of the transfer. Write your top-up number in the note.',
    });
    expect(
      res.body.map((row: { key: string; available: boolean; kind: string }) => [row.key, row.kind, row.available]),
    ).toEqual([
      ['bank_transfer', 'manual', true],
      ['crypto_transfer', 'manual', true],
      ['vodafone_cash', 'manual', true],
      ['fawry_transfer', 'manual', true],
      ['instapay', 'manual', true],
      ['binance_pay', 'manual', true],
      ['nowpayments', 'automatic', false],
      ['binance_pay_auto', 'automatic', false],
    ]);
    expect(res.body[6]).toMatchObject({ methodType: 'usdt', instructions: '' });
    // Reading the catalog stores nothing.
    expect(await gatewayRows()).toEqual([]);
  });

  it('needs payments:gateways: 403 without it, 401 signed out', async () => {
    const reader = await adminWith(t, ['payments:read']);
    const forbidden = await reader.get('/admin/payment-gateway-presets');
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.code).toBe('FORBIDDEN');
    expect((await admin.anonymous('GET', '/admin/payment-gateway-presets')).status).toBe(401);
  });
});

describe('POST /admin/payment-gateways with a preset', () => {
  it('makes a method from each available entry: its key, no logo, the preset driver, manual, one audit row', async () => {
    const available = GATEWAY_PRESETS.filter((entry) => entry.available);
    expect(available).toHaveLength(6);
    for (const entry of available) {
      const res = await admin.post('/admin/payment-gateways', fromPreset(entry.key));
      expect(res.status, entry.key).toBe(201);
      expect(res.body, entry.key).toMatchObject({
        code: entry.key.replace(/_/g, '-'),
        driver: entry.driver,
        name: entry.name,
        isManual: true,
        preset: entry.key,
        logoUrl: null,
        secretHint: null,
        volume30d: '0.0000',
      });
    }
    const rows = await gatewayRows();
    expect(rows.map((row) => row.preset)).toEqual(available.map((entry) => entry.key));
    expect(rows.every((row) => row.logoFileId === null && row.isManual)).toBe(true);
    const log = await audits();
    expect(log.map((row) => row.action)).toEqual(available.map(() => 'added payment method'));
    expect(log[2]).toMatchObject({
      entityType: 'payment_gateway',
      entityLabel: 'Vodafone Cash',
      after: { preset: 'vodafone_cash', driver: 'vodafone_cash', isManual: true },
    });
  });

  it('keeps a custom method at preset null, also when the body says null', async () => {
    const plain = await admin.post('/admin/payment-gateways', custom());
    expect(plain.status).toBe(201);
    expect(plain.body).toMatchObject({ preset: null, logoUrl: null });
    const explicit = await admin.post('/admin/payment-gateways', custom({ code: 'cliq-2', preset: null }));
    expect(explicit.status).toBe(201);
    expect(explicit.body.preset).toBeNull();
    const rows = await gatewayRows();
    expect(rows.map((row) => row.preset)).toEqual([null, null]);
  });

  it('refuses an unknown key with 422 on preset (unknown), storing nothing', async () => {
    for (const key of ['paypal', 'Vodafone_Cash', '']) {
      const res = await admin.post('/admin/payment-gateways', fromPreset('vodafone_cash', { preset: key }));
      expect(res.status, key).toBe(422);
      expect(res.body.code).toBe('VALIDATION_FAILED');
      expect(res.body.errors, key).toEqual([{ field: 'preset', code: 'unknown', message: expect.any(String) }]);
    }
    expect(await gatewayRows()).toEqual([]);
  });

  it('refuses the two automatic entries with 422 on preset (unavailable), storing nothing', async () => {
    for (const key of ['nowpayments', 'binance_pay_auto']) {
      const res = await admin.post('/admin/payment-gateways', fromPreset(key, { secret: 'sk_live_0000' }));
      expect(res.status, key).toBe(422);
      expect(res.body.errors, key).toEqual([{ field: 'preset', code: 'unavailable', message: expect.any(String) }]);
    }
    expect(await gatewayRows()).toEqual([]);
  });

  it('refuses a kind that is not the preset kind with 422 on isManual (preset_kind)', async () => {
    const res = await admin.post('/admin/payment-gateways', fromPreset('vodafone_cash', { isManual: false }));
    expect(res.status).toBe(422);
    expect(res.body.errors).toEqual([{ field: 'isManual', code: 'preset_kind', message: expect.any(String) }]);
    expect(await gatewayRows()).toEqual([]);
  });

  it('refuses another driver name with 422 on driver (preset_driver)', async () => {
    const res = await admin.post('/admin/payment-gateways', fromPreset('instapay', { driver: 'bank' }));
    expect(res.status).toBe(422);
    expect(res.body.errors).toEqual([{ field: 'driver', code: 'preset_driver', message: expect.any(String) }]);
    expect(await gatewayRows()).toEqual([]);
  });

  it('still applies every gateway field check next to the preset checks', async () => {
    const res = await admin.post('/admin/payment-gateways', fromPreset('instapay', { driver: 'bank', name: ' ' }));
    expect(res.status).toBe(422);
    expect(
      res.body.errors.map((error: { field: string; code: string }) => `${error.field}:${error.code}`).sort(),
    ).toEqual(['driver:preset_driver', 'name:required']);
  });

  it('lets two methods come from one preset (two bank accounts), each with its own code', async () => {
    const first = await admin.post('/admin/payment-gateways', fromPreset('bank_transfer'));
    const second = await admin.post(
      '/admin/payment-gateways',
      fromPreset('bank_transfer', { code: 'bank-transfer-eur', name: 'Bank transfer (EUR)' }),
    );
    expect([first.status, second.status]).toEqual([201, 201]);
    expect([first.body.preset, second.body.preset]).toEqual(['bank_transfer', 'bank_transfer']);
    const taken = await admin.post('/admin/payment-gateways', fromPreset('bank_transfer'));
    expect(taken.status).toBe(422);
    expect(taken.body.errors[0]).toMatchObject({ field: 'code', code: 'taken' });
    expect(await gatewayRows()).toHaveLength(2);
  });
});

describe('PATCH /admin/payment-gateways/:id and the preset', () => {
  it('never changes the preset: the key in the body is stripped, the rest of the change is applied', async () => {
    const made = await admin.post('/admin/payment-gateways', fromPreset('vodafone_cash'));
    const changed = await admin.patch(`/admin/payment-gateways/${made.body.id}`, {
      preset: 'instapay',
      name: 'Vodafone Cash (main line)',
    });
    expect(changed.status).toBe(200);
    expect(changed.body).toMatchObject({ preset: 'vodafone_cash', name: 'Vodafone Cash (main line)' });
    const unknown = await admin.patch(`/admin/payment-gateways/${made.body.id}`, { preset: 'paypal', isActive: false });
    expect(unknown.status).toBe(200);
    expect(unknown.body).toMatchObject({ preset: 'vodafone_cash', isActive: false });
    const nothing = await admin.patch(`/admin/payment-gateways/${made.body.id}`, { preset: null });
    expect(nothing.body.preset).toBe('vodafone_cash');
    expect((await gatewayRows())[0]!.preset).toBe('vodafone_cash');

    const plain = await admin.post('/admin/payment-gateways', custom());
    const stillPlain = await admin.patch(`/admin/payment-gateways/${plain.body.id}`, { preset: 'instapay' });
    expect(stillPlain.status).toBe(200);
    expect(stillPlain.body.preset).toBeNull();
  });

  it('keeps the kind and the driver of the preset: 422 on isManual (preset_kind) and on driver (preset_driver), writing nothing', async () => {
    const made = await admin.post('/admin/payment-gateways', fromPreset('vodafone_cash'));
    const url = `/admin/payment-gateways/${made.body.id}`;
    const before = (await gatewayRows())[0]!;

    const kind = await admin.patch(url, { isManual: false });
    expect(kind.status).toBe(422);
    expect(kind.body.code).toBe('VALIDATION_FAILED');
    expect(kind.body.errors).toEqual([{ field: 'isManual', code: 'preset_kind', message: expect.any(String) }]);

    const driver = await admin.patch(url, { driver: 'card' });
    expect(driver.status).toBe(422);
    expect(driver.body.errors).toEqual([{ field: 'driver', code: 'preset_driver', message: expect.any(String) }]);

    // The card gateway a Vodafone Cash row could have become, with a secret: refused as a whole, the secret never stored.
    const card = await admin.patch(url, { isManual: false, driver: 'card', secret: 'sk_live_abcdef4f2a' });
    expect(card.status).toBe(422);
    expect(card.body.errors.map((error: { field: string; code: string }) => `${error.field}:${error.code}`)).toEqual([
      'isManual:preset_kind',
      'driver:preset_driver',
    ]);

    expect((await gatewayRows())[0]).toEqual(before);
    expect((await audits()).map((row) => row.action)).toEqual(['added payment method']);
    expect((await admin.get(url)).body).toMatchObject({
      preset: 'vodafone_cash',
      isManual: true,
      driver: 'vodafone_cash',
    });
  });

  it('measures the kind and the driver on the merged row: a patch that repeats them or sends other fields passes and keeps the preset', async () => {
    const made = await admin.post('/admin/payment-gateways', fromPreset('vodafone_cash'));
    const url = `/admin/payment-gateways/${made.body.id}`;
    const repeated = await admin.patch(url, {
      isManual: true,
      driver: 'vodafone_cash',
      name: 'Vodafone Cash (main line)',
    });
    expect(repeated.status).toBe(200);

    const changed = await admin.patch(url, {
      feePercent: '1.5',
      feeFixed: '0.25',
      minAmount: '20',
      maxAmount: '4000',
      holdHours: 12,
      audience: 'b2b',
      instructions: 'Send it to 01099999999 and upload the screenshot.',
      supportsRefunds: false,
      isActive: false,
    });
    expect(changed.status).toBe(200);
    expect(changed.body).toMatchObject({
      preset: 'vodafone_cash',
      driver: 'vodafone_cash',
      isManual: true,
      name: 'Vodafone Cash (main line)',
      feePercent: '1.5000',
      feeFixed: '0.2500',
      minAmount: '20.0000',
      maxAmount: '4000.0000',
      holdHours: 12,
      audience: 'b2b',
      instructions: 'Send it to 01099999999 and upload the screenshot.',
      isActive: false,
    });
    expect((await gatewayRows())[0]).toMatchObject({
      preset: 'vodafone_cash',
      isManual: true,
      driver: 'vodafone_cash',
    });
  });

  it('leaves a custom method free to change its driver and kind as before', async () => {
    const plain = await admin.post('/admin/payment-gateways', custom());
    const url = `/admin/payment-gateways/${plain.body.id}`;
    const boss = await owner();
    const changed = await boss.patch(url, {
      isManual: false,
      driver: 'card',
      secret: 'sk_live_abcdef4f2a',
      instructions: '',
    });
    expect(changed.status).toBe(200);
    expect(changed.body).toMatchObject({ preset: null, isManual: false, driver: 'card', secretHint: '••••4f2a' });
    expect((await boss.patch(url, { isManual: true, driver: 'cliq' })).status).toBe(200);
  });

  it('keeps a row of an entry that is not available editable (no unavailable check), with its kind and driver pinned', async () => {
    const { db } = await testDb();
    const id = await insertGateway(t, db, {
      code: 'nowpayments',
      driver: 'nowpayments',
      preset: 'nowpayments',
      name: 'NOWPayments',
      isManual: false,
      secret: null,
      webhookSecret: null,
    });
    const url = `/admin/payment-gateways/${id}`;
    const renamed = await admin.patch(url, { name: 'NOWPayments (renamed)', isActive: false });
    expect(renamed.status).toBe(200);
    expect(renamed.body).toMatchObject({ preset: 'nowpayments', name: 'NOWPayments (renamed)', isActive: false });
    const manual = await admin.patch(url, { isManual: true });
    expect(manual.status).toBe(422);
    expect(manual.body.errors).toEqual([{ field: 'isManual', code: 'preset_kind', message: expect.any(String) }]);
  });
});

describe('the logo of a method: POST and DELETE /admin/payment-gateways/:id/logo', () => {
  it("cleans and stores the picture once, sets the method's logoUrl, and audits it with the staff member", async () => {
    const made = await admin.post('/admin/payment-gateways', custom());
    clock.advance(5 * MINUTE);
    const input = pngImage(300, 300, { text: 'made by Rami' });
    const res = await uploadLogo(made.body.id, input, { name: '../../logo‮gnp.png' });
    expect(res.statusCode).toBe(200);
    const stored = (await fileRows())[0]!;
    const name = stored.key.slice('media/'.length);
    expect(name).toMatch(/^[0-9a-f]{64}\.png$/);
    expect(stored).toMatchObject({
      key: `media/${name}`,
      mime: 'image/png',
      ownerType: 'staff',
      ownerId: admin.staffId,
    });
    expect(json(res)).toMatchObject({
      id: made.body.id,
      preset: null,
      logoUrl: `${MEDIA}${name}`,
      updatedAt: '2026-11-17T10:05:00.000Z',
    });
    expect(name.slice(0, 64)).toBe(stored.sha256);
    expect((await gatewayRows())[0]!.logoFileId).toBe(stored.id);

    const log = await audits();
    expect(log.map((row) => row.action)).toEqual(['added payment method', 'uploaded logo for']);
    expect(log[1]).toMatchObject({
      entityType: 'payment_gateway',
      entityId: made.body.id,
      entityLabel: 'CliQ transfer',
      before: { logo: null },
      after: { logo: name, width: 300, height: 300, size: stored.size },
    });
    expect(log[1]!.actorName).toBe('Rami K.');
  });

  it('shows the logo on the show and list routes, and the public media route serves it', async () => {
    const made = await admin.post('/admin/payment-gateways', fromPreset('vodafone_cash'));
    const other = await admin.post('/admin/payment-gateways', fromPreset('instapay'));
    const url = json(await uploadLogo(made.body.id, pngImage(300, 300))).logoUrl as string;
    expect(url).toMatch(/^\/store\/v1\/media\/[0-9a-f]{64}\.png$/);

    expect((await admin.get(`/admin/payment-gateways/${made.body.id}`)).body).toMatchObject({
      preset: 'vodafone_cash',
      logoUrl: url,
    });
    const list = (await admin.get('/admin/payment-gateways')).body as Array<{ id: number; logoUrl: string | null }>;
    // The list is by name: InstaPay before Vodafone Cash.
    expect(list.map((row) => [row.id, row.logoUrl])).toEqual([
      [other.body.id, null],
      [made.body.id, url],
    ]);
    const served = await t.app.inject({ method: 'GET', url, remoteAddress: freshClientIp() });
    expect(served.statusCode).toBe(200);
    expect(served.headers['content-type']).toBe('image/png');
    expect(sha256(new Uint8Array(served.rawPayload))).toBe(url.slice(MEDIA.length, -'.png'.length));
  });

  it('keeps one file row for the same picture on two methods, replaces a logo, and audits the replaced name', async () => {
    const one = await admin.post('/admin/payment-gateways', fromPreset('vodafone_cash'));
    const two = await admin.post('/admin/payment-gateways', fromPreset('instapay'));
    const first = json(await uploadLogo(one.body.id, pngImage(300, 300)));
    const again = json(await uploadLogo(two.body.id, pngImage(300, 300), { name: 'x.png' }));
    expect(again.logoUrl).toBe(first.logoUrl);
    expect(await fileRows()).toHaveLength(1);

    const replaced = await uploadLogo(one.body.id, webpImage(300, 300), { type: 'image/webp' });
    expect(json(replaced).logoUrl).toMatch(/^\/store\/v1\/media\/[0-9a-f]{64}\.webp$/);
    // The old file stays: the other method still shows it.
    expect(await fileRows()).toHaveLength(2);
    expect((await admin.get(`/admin/payment-gateways/${two.body.id}`)).body.logoUrl).toBe(first.logoUrl);
    const log = await audits();
    expect(log[4]).toMatchObject({
      action: 'uploaded logo for',
      before: { logo: (first.logoUrl as string).slice(MEDIA.length) },
    });
  });

  it('removes the logo, keeps the file, audits it, and answers 204 again (and audits) when there is none', async () => {
    const made = await admin.post('/admin/payment-gateways', fromPreset('fawry_transfer'));
    const url = json(await uploadLogo(made.body.id, jpegImage(400, 300), { type: 'image/jpeg' })).logoUrl as string;
    clock.advance(MINUTE);

    const removed = await admin.delete(`/admin/payment-gateways/${made.body.id}/logo`);
    expect(removed.status).toBe(204);
    expect((await gatewayRows())[0]!.logoFileId).toBeNull();
    expect((await gatewayRows())[0]!.updatedAt.toISOString()).toBe('2026-11-17T10:01:00.000Z');
    expect(await fileRows()).toHaveLength(1);
    expect((await admin.get(`/admin/payment-gateways/${made.body.id}`)).body).toMatchObject({
      preset: 'fawry_transfer',
      logoUrl: null,
    });

    clock.advance(MINUTE);
    expect((await admin.delete(`/admin/payment-gateways/${made.body.id}/logo`)).status).toBe(204);
    // Nothing changed the second time, so the row keeps its time.
    expect((await gatewayRows())[0]!.updatedAt.toISOString()).toBe('2026-11-17T10:01:00.000Z');
    const log = await audits();
    expect(log.map((row) => row.action)).toEqual([
      'added payment method',
      'uploaded logo for',
      'removed logo of',
      'removed logo of',
    ]);
    expect(log[2]).toMatchObject({
      entityType: 'payment_gateway',
      entityLabel: 'Fawry',
      before: { logo: url.slice(MEDIA.length) },
      after: { logo: null },
    });
    expect(log[3]).toMatchObject({ before: { logo: null }, after: { logo: null } });
  });

  it('sets the logo to null when its file row is deleted (ON DELETE SET NULL), and a method with a logo can still be deleted', async () => {
    const made = await admin.post('/admin/payment-gateways', custom());
    await uploadLogo(made.body.id, pngImage(300, 300));
    const { db } = await testDb();
    await db.delete(s.files);
    expect((await gatewayRows())[0]!.logoFileId).toBeNull();
    expect((await admin.get(`/admin/payment-gateways/${made.body.id}`)).body.logoUrl).toBeNull();

    await uploadLogo(made.body.id, pngImage(300, 300));
    expect((await admin.delete(`/admin/payment-gateways/${made.body.id}`)).status).toBe(204);
    expect(await gatewayRows()).toEqual([]);
  });

  it('refuses each picture that is not a clean still JPEG, PNG or WebP with 422 on file and its code, storing nothing', async () => {
    const made = await admin.post('/admin/payment-gateways', custom());
    const cases: Array<[string, Uint8Array, string]> = [
      [
        'an SVG declared as PNG',
        new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'),
        'unsupported_type',
      ],
      ['an empty file', new Uint8Array(), 'empty'],
      ['a truncated JPEG', jpegImage(400, 300).subarray(0, 60), 'corrupt'],
      ['an animated PNG', pngImage(300, 300, { animated: true }), 'animated'],
      ['a small picture', pngImage(63, 300), 'too_small'],
      ['a huge picture', webpImage(4097, 300), 'too_large_dimensions'],
      ['a rotated JPEG', jpegImage(400, 300, { exifOrientation: 6 }), 'rotated'],
    ];
    for (const [label, data, code] of cases) {
      const res = await uploadLogo(made.body.id, data, { type: 'image/png' });
      expect(res.statusCode, label).toBe(422);
      expect(json(res).code, label).toBe('VALIDATION_FAILED');
      expect(json(res).errors, label).toEqual([{ field: 'file', code, message: expect.any(String) }]);
    }
    expect(await fileRows()).toEqual([]);
    expect((await gatewayRows())[0]!.logoFileId).toBeNull();
  });

  it('takes a logo from 64 pixels on each side (a service picture needs 200) and names that size when it refuses a smaller one', async () => {
    const made = await admin.post('/admin/payment-gateways', custom());
    // A square mark, then a wide and short wordmark: each becomes the logo.
    for (const picture of [pngImage(128, 128), pngImage(300, 64)]) {
      const res = await uploadLogo(made.body.id, picture);
      expect(res.statusCode).toBe(200);
      expect(json(res).logoUrl).toMatch(/^\/store\/v1\/media\/[0-9a-f]{64}\.png$/);
    }
    const small = await uploadLogo(made.body.id, pngImage(63, 300));
    expect(small.statusCode).toBe(422);
    expect(json(small).errors).toEqual([
      { field: 'file', code: 'too_small', message: 'The picture must be at least 64 x 64 pixels.' },
    ]);
  });

  it('answers 413 over 2 MiB, 422 on file for a JSON body and 415 for a body type it does not read', async () => {
    const made = await admin.post('/admin/payment-gateways', custom());
    const big = new Uint8Array(2 * 1024 * 1024 + 1);
    big.set(jpegImage(400, 300));
    const tooLarge = await uploadLogo(made.body.id, big);
    expect(tooLarge.statusCode).toBe(413);
    expect(json(tooLarge).code).toBe('PAYLOAD_TOO_LARGE');

    const jsonBody = await admin.post(`/admin/payment-gateways/${made.body.id}/logo`, { file: 'x' });
    expect(jsonBody.status).toBe(422);
    expect(jsonBody.body.errors[0].field).toBe('file');

    const text = await t.app.inject({
      method: 'POST',
      url: `/admin/payment-gateways/${made.body.id}/logo`,
      headers: { ...admin.session.mutationHeaders, origin: CONSOLE_ORIGIN, 'content-type': 'application/xml' },
      payload: '<file/>',
      remoteAddress: freshClientIp(),
    });
    expect(text.statusCode).toBe(415);
    expect(await fileRows()).toEqual([]);
  });

  it('answers 404 for an unknown method (storing nothing), 403 without payments:gateways, 403 without the CSRF token', async () => {
    const made = await admin.post('/admin/payment-gateways', custom());
    const missing = await uploadLogo(999_999, pngImage(300, 300));
    expect(missing.statusCode).toBe(404);
    expect(json(missing).code).toBe('NOT_FOUND');
    expect(await fileRows()).toEqual([]);
    expect((await admin.delete('/admin/payment-gateways/999999/logo')).status).toBe(404);

    const reader = await adminWith(t, ['payments:read']);
    const forbidden = await uploadLogo(made.body.id, pngImage(300, 300), { as: reader });
    expect(forbidden.statusCode).toBe(403);
    expect(json(forbidden).code).toBe('FORBIDDEN');
    expect((await reader.delete(`/admin/payment-gateways/${made.body.id}/logo`)).status).toBe(403);
    const noCsrf = await uploadLogo(made.body.id, pngImage(300, 300), { csrf: false });
    expect(noCsrf.statusCode).toBe(403);
    expect(json(noCsrf).code).toBe('CSRF_FAILED');
    expect(await fileRows()).toEqual([]);
    expect((await audits()).map((row) => row.action)).toEqual(['added payment method']);
  });
});

describe('preset and logoUrl on every list of methods', () => {
  it('shows them on the admin routes (create, show, list, change)', async () => {
    const made = await admin.post('/admin/payment-gateways', fromPreset('binance_pay'));
    expect(made.body).toMatchObject({ preset: 'binance_pay', logoUrl: null });
    const url = json(await uploadLogo(made.body.id, pngImage(300, 300))).logoUrl as string;
    const patched = await admin.patch(`/admin/payment-gateways/${made.body.id}`, { name: 'Binance Pay (Pay ID)' });
    expect(patched.body).toMatchObject({ preset: 'binance_pay', logoUrl: url });
    expect((await admin.get('/admin/payment-gateways')).body[0]).toMatchObject({ preset: 'binance_pay', logoUrl: url });
  });

  it("shows them on a merchant's GET /client/payment-methods, with the top-up method of each ready-made driver", async () => {
    const { db } = await testDb();
    const merchant = await insertWalletMerchant(db, { name: 'Zain Mobile Hub' });
    const portal = await portalFor(t, merchant.id);
    for (const entry of GATEWAY_PRESETS.filter((candidate) => candidate.available)) {
      await admin.post('/admin/payment-gateways', fromPreset(entry.key));
    }
    const mine = await admin.post('/admin/payment-gateways', custom());
    const url = json(await uploadLogo(mine.body.id, pngImage(300, 300))).logoUrl as string;
    const vodafone = (await gatewayRows()).find((row) => row.preset === 'vodafone_cash')!;
    const vodafoneLogo = json(await uploadLogo(vodafone.id, webpImage(300, 300), { type: 'image/webp' }))
      .logoUrl as string;

    const res = await portal.call('GET', '/client/payment-methods');
    expect(res.status).toBe(200);
    const rows = res.body as Array<{
      name: string;
      preset: string | null;
      logoUrl: string | null;
      methodType: string;
      kind: string;
    }>;
    expect(rows.map((row) => [row.name, row.preset, row.methodType, row.kind])).toEqual([
      ['Bank transfer', 'bank_transfer', 'bank', 'manual'],
      ['Binance Pay', 'binance_pay', 'usdt', 'manual'],
      ['CliQ transfer', null, 'bank', 'manual'],
      ['Crypto transfer', 'crypto_transfer', 'usdt', 'manual'],
      ['Fawry', 'fawry_transfer', 'bank', 'manual'],
      ['InstaPay', 'instapay', 'bank', 'manual'],
      ['Vodafone Cash', 'vodafone_cash', 'bank', 'manual'],
    ]);
    expect(Object.fromEntries(rows.map((row) => [row.name, row.logoUrl]))).toEqual({
      'Bank transfer': null,
      'Binance Pay': null,
      'CliQ transfer': url,
      'Crypto transfer': null,
      Fawry: null,
      InstaPay: null,
      'Vodafone Cash': vodafoneLogo,
    });
  });

  it("shows them on a customer's GET /store/v1/me/wallet/top-up-methods", async () => {
    const { db } = await testDb();
    await insertUsd(db);
    await walletSettings(t, db);
    const made = await admin.post('/admin/payment-gateways', fromPreset('instapay', { audience: 'b2c' }));
    const b2b = await admin.post('/admin/payment-gateways', fromPreset('fawry_transfer', { audience: 'b2b' }));
    expect(b2b.status).toBe(201);
    const url = json(await uploadLogo(made.body.id, jpegImage(400, 300), { type: 'image/jpeg' })).logoUrl as string;
    const customer = await makeCustomer(t, { name: 'Daniel Rivera' });
    const store = new StoreClient(t);
    expect((await store.login(customer.email)).statusCode).toBe(200);

    const res = await store.call('GET', '/store/v1/me/wallet/top-up-methods');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([
      expect.objectContaining({
        id: made.body.id,
        code: 'instapay',
        kind: 'manual',
        methodType: 'bank',
        preset: 'instapay',
        logoUrl: url,
      }),
    ]);
  });

  it('offers a custom automatic method whose driver has no code (nowpayments, no preset) to no customer and not on the shop, and refuses a top-up through it', async () => {
    const { db } = await testDb();
    await insertUsd(db);
    await walletSettings(t, db, { 'wallet.customer.card_topups': true });
    const made = await (
      await owner()
    ).post(
      '/admin/payment-gateways',
      custom({
        code: 'nowpayments-custom',
        driver: 'nowpayments',
        name: 'NOWPayments (custom)',
        isManual: false,
        instructions: '',
      }),
    );
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({ preset: null, driver: 'nowpayments', isManual: false, logoUrl: null });

    const customer = await makeCustomer(t, { name: 'Daniel Rivera' });
    const store = new StoreClient(t);
    expect((await store.login(customer.email)).statusCode).toBe(200);
    expect((await store.call('GET', '/store/v1/me/wallet/top-up-methods')).json()).toEqual([]);
    const config = await t.app.inject({ method: 'GET', url: '/store/v1/config', remoteAddress: freshClientIp() });
    expect(json(config).paymentMethods).toEqual([]);

    // The merchant list does not look at the driver (as before this feature): the row is listed, and a top-up through it is refused.
    const merchant = await insertWalletMerchant(db, { name: 'Zain Mobile Hub' });
    const portal = await portalFor(t, merchant.id);
    const listed = await portal.call('GET', '/client/payment-methods');
    expect(
      listed.body.map((row: { code: string; kind: string; methodType: string }) => [
        row.code,
        row.kind,
        row.methodType,
      ]),
    ).toEqual([['nowpayments-custom', 'automatic', 'usdt']]);
    const refused = await portal.call('POST', '/client/invoices', { amount: '100', gatewayId: made.body.id });
    expect(refused.body.code).toBe('GATEWAY_ERROR');
  });

  it("shows them on the shop config's paymentMethods (an automatic method with a driver), and lists no manual preset there", async () => {
    await admin.post('/admin/payment-gateways', fromPreset('vodafone_cash', { audience: 'b2c' }));
    const card = await (
      await owner()
    ).post('/admin/payment-gateways', {
      ...custom(),
      code: 'card-shop',
      driver: 'card',
      name: 'Card gateway',
      audience: 'b2c',
      supports3ds: true,
      isManual: false,
      instructions: '',
      secret: 'sk_live_abcdef4f2a',
    });
    expect(card.status).toBe(201);
    const bare = await t.app.inject({ method: 'GET', url: '/store/v1/config', remoteAddress: freshClientIp() });
    expect(json(bare).paymentMethods).toEqual([
      { code: 'card-shop', name: 'Card gateway', supports3ds: true, preset: null, logoUrl: null },
    ]);
    const url = json(await uploadLogo(card.body.id, pngImage(300, 300))).logoUrl as string;
    const config = await t.app.inject({ method: 'GET', url: '/store/v1/config', remoteAddress: freshClientIp() });
    expect(config.statusCode).toBe(200);
    expect(json(config).paymentMethods).toEqual([
      { code: 'card-shop', name: 'Card gateway', supports3ds: true, preset: null, logoUrl: url },
    ]);
  });
});

describe('money rules do not change', () => {
  /** Opens a top-up invoice through the method as the merchant, sends a receipt, and answers the pending payment. */
  async function topUp(
    portal: Awaited<ReturnType<typeof portalFor>>,
    merchantId: number,
    gatewayId: number,
    amount: string,
  ) {
    const { db } = await testDb();
    const invoice = await portal.call('POST', '/client/invoices', { amount, gatewayId });
    expect(invoice.status).toBe(201);
    const fileId = await insertProofFile(db, merchantId);
    const receipt = await portal.call('POST', `/client/invoices/${invoice.body.invoice.id}/receipt`, {
      fileId,
      reference: 'TRX-5521',
    });
    expect(receipt.status).toBe(201);
    return { invoice: invoice.body, payment: receipt.body };
  }

  it('credits a merchant top-up through a Vodafone Cash method by the existing review, as method bank', async () => {
    const { db } = await testDb();
    const merchant = await insertWalletMerchant(db, { name: 'Zain Mobile Hub' });
    const portal = await portalFor(t, merchant.id);
    const made = await admin.post('/admin/payment-gateways', fromPreset('vodafone_cash'));

    const { invoice, payment } = await topUp(portal, merchant.id, made.body.id, '100');
    // The payer sees the transfer details staff wrote into the template, not a payment page.
    expect(invoice.instructions).toBe(
      'Send the amount to the Vodafone Cash number 01000000000 and upload a screenshot of the transfer. Write your top-up number in the note.',
    );
    expect(invoice.paymentUrl).toBeUndefined();
    expect(payment).toMatchObject({ status: 'pending', methodType: 'bank', amount: '100.0000', feeAmount: '0.0000' });
    // Nothing is credited before a person looks at the receipt.
    const pending = await admin.get('/admin/payments?status=pending');
    expect(pending.body).toHaveLength(1);
    expect(pending.body[0]).toMatchObject({
      id: payment.id,
      methodType: 'bank',
      gateway: { name: 'Vodafone Cash' },
      client: { walletBalance: '0.0000' },
    });

    const approved = await admin.post(`/admin/payments/${payment.id}/approve`);
    expect(approved.status).toBe(200);
    expect(approved.body).toMatchObject({
      status: 'approved',
      methodType: 'bank',
      client: { walletBalance: '100.0000' },
    });
    expect((await db.select().from(s.payments).where(eq(s.payments.id, payment.id)))[0]).toMatchObject({
      methodType: 'bank',
      status: 'approved',
      gatewayId: made.body.id,
    });
    const paid = await portal.call('GET', `/client/invoices/${invoice.invoice.id}`);
    expect(paid.body.invoice.status).toBe('paid');
  });

  it('reads usdt for a Binance Pay method, takes the fee of the method, and credits the net by the same review', async () => {
    const { db } = await testDb();
    const merchant = await insertWalletMerchant(db, { name: 'Zain Mobile Hub' });
    const portal = await portalFor(t, merchant.id);
    const made = await admin.post(
      '/admin/payment-gateways',
      fromPreset('binance_pay', { feePercent: '2', feeFixed: '1' }),
    );

    const { payment } = await topUp(portal, merchant.id, made.body.id, '100');
    expect(payment).toMatchObject({ status: 'pending', methodType: 'usdt', amount: '100.0000', feeAmount: '3.0000' });
    const approved = await admin.post(`/admin/payments/${payment.id}/approve`);
    expect(approved.status).toBe(200);
    expect(approved.body).toMatchObject({
      methodType: 'usdt',
      netAmount: '97.0000',
      client: { walletBalance: '97.0000' },
    });
  });

  it("tops up a customer's store balance through a ready-made method by the same review", async () => {
    const { db } = await testDb();
    await insertUsd(db);
    await walletSettings(t, db);
    const made = await admin.post(
      '/admin/payment-gateways',
      fromPreset('instapay', { audience: 'b2c', minAmount: '5' }),
    );
    const customer = await makeCustomer(t, { name: 'Daniel Rivera' });
    const store = new StoreClient(t);
    expect((await store.login(customer.email)).statusCode).toBe(200);
    const created = await store.call(
      'POST',
      '/store/v1/me/wallet/top-ups',
      { amount: '50', gatewayId: made.body.id },
      { headers: { 'idempotency-key': crypto.randomUUID() } },
    );
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      status: 'awaiting_payment',
      method: { code: 'instapay', methodType: 'bank' },
    });
    const fileId = await insertProofFile(db, customer.id, { ownerType: 'customer' });
    const receipt = await store.call(
      'POST',
      `/store/v1/me/wallet/top-ups/${created.json().id}/receipt`,
      { fileId },
      { headers: { 'idempotency-key': crypto.randomUUID() } },
    );
    expect(receipt.statusCode).toBe(201);
    const pending = await admin.get('/admin/payments?status=pending');
    expect(pending.body).toHaveLength(1);
    const approved = await admin.post(`/admin/payments/${pending.body[0].id}/approve`);
    expect(approved.status).toBe(200);
    expect(approved.body).toMatchObject({ status: 'approved', methodType: 'bank', amount: '50.0000' });
    expect((await store.call('GET', '/store/v1/me/wallet')).json()).toMatchObject({ balance: '50.0000' });
  });
});
