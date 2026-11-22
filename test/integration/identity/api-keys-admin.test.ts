// Integration tests of the API keys staff create and edit for a merchant (feature 20, slice D): POST /admin/clients/:id/api-keys and
// PATCH /admin/api-keys/:id, on the real application. A created key is used on a REST v1 sample route to prove it works and that a change
// applies on the next call.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { desc, eq } from 'drizzle-orm';
import { TokenService } from '@src/infra/crypto';
import { type Database, schema as s } from '@src/infra/db';
import { type TestApp, createTestApp } from '../../support/app';
import { adminWith } from '../../support/admin-api';
import { clearIdentityCaches, insertMerchant } from '../../support/auth';
import { DAY, TestClock } from '../../support/clock';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { seedIdentityTemplates } from '../../support/identity-mail';
import { MachineTestController, insertApiKey } from '../../support/machine-auth';
import { clearApiKeyCaches } from '../../support/machine-orders';
import { mailbox, notificationRows, sendAllQueued } from '../../support/notifications';
import { type PortalClient, portalFor } from '../../support/webhooks';

const clock = new TestClock('2026-11-01T10:00:00.000Z');
let t: TestApp;
let db: Database;

beforeAll(async () => {
  ({ db } = await testDb());
  t = await createTestApp({ clock, controllers: [MachineTestController] });
});
afterAll(async () => {
  await resetDb();
  await t.close();
  await closeTestDb();
});
beforeEach(async () => {
  clock.set('2026-11-01T10:00:00.000Z');
  await resetDb();
  await clearIdentityCaches(t);
  await clearApiKeyCaches(t);
  await seedIdentityTemplates(db);
  mailbox(t).reset();
});

const BODY = { name: 'Production server', scopes: ['orders:read', 'orders:write'] };

/** Calls the REST v1 sample route that needs `orders:read` with a key, from an address. */
function useKey(key: string, ip = '127.0.0.1') {
  return t.app.inject({
    method: 'GET',
    url: '/v1/t/mach/read',
    headers: { authorization: `Bearer ${key}` },
    remoteAddress: ip,
  });
}

// Creating a key from the console is kept for Owners (decision 046): the default member is one; pass a list for another role.
const staff = (permissions: string[] = ['*']) => adminWith(t, permissions, { name: 'Rami K.' });
const keyRows = () => db.select().from(s.apiKeys).orderBy(s.apiKeys.id);

describe('POST /admin/clients/:id/api-keys', () => {
  it('creates a key shown once with no-store, authenticates a REST v1 call, and is marked as made by staff', async () => {
    const api = await staff();
    const clientId = await insertMerchant(db, { name: 'Zain Mobile Hub' });
    const res = await api.post(`/admin/clients/${clientId}/api-keys`, {
      ...BODY,
      allowedIps: ['203.0.113.55', '198.51.100.0/24'],
      rateLimitPerMin: 120,
    });
    expect(res.status).toBe(201);
    expect(res.res.headers['cache-control']).toBe('no-store');
    const { key, secret } = res.body;
    expect(secret).toMatch(/^gsm_[A-Za-z0-9_-]{43}$/);
    expect(key).toMatchObject({
      clientId,
      name: 'Production server',
      prefix: secret.slice(0, 8),
      scopes: ['orders:read', 'orders:write'],
      allowedIps: ['203.0.113.55', '198.51.100.0/24'],
      rateLimitPerMin: 120,
      revokedAt: null,
      createdByStaff: true,
    });
    expect(JSON.stringify(key)).not.toContain(secret);

    // Only the hash and the prefix are stored, and the row says which staff member made it.
    const [row] = await keyRows();
    expect(row).toMatchObject({ createdBy: api.staffId, keyHash: t.app.get(TokenService).hash(secret) });
    expect(JSON.stringify(row)).not.toContain(secret);

    expect((await useKey(secret, '203.0.113.55')).statusCode).toBe(200);
    expect((await useKey(secret, '192.0.2.77')).statusCode).toBe(403);
  });

  it('defaults the limit to 60 and honours the limit it was given on the next calls', async () => {
    const api = await staff();
    const clientId = await insertMerchant(db);
    const def = await api.post(`/admin/clients/${clientId}/api-keys`, { ...BODY, name: 'Default' });
    expect(def.body.key.rateLimitPerMin).toBe(60);
    const low = await api.post(`/admin/clients/${clientId}/api-keys`, { ...BODY, name: 'Low', rateLimitPerMin: 2 });
    expect((await useKey(low.body.secret)).statusCode).toBe(200);
    expect((await useKey(low.body.secret)).statusCode).toBe(200);
    expect((await useKey(low.body.secret)).statusCode).toBe(429);
  });

  it('shows createdByStaff in the admin list and in the merchant portal, and false for a key the merchant made', async () => {
    const api = await staff();
    const clientId = await insertMerchant(db);
    await api.post(`/admin/clients/${clientId}/api-keys`, BODY);
    const portal: PortalClient = await portalFor(t, clientId);
    const own = await portal.call('POST', '/client/api-keys', { name: 'Mine', scopes: ['dhru'] });
    expect(own.body.key.createdByStaff).toBe(false);

    const admin = (await api.get(`/admin/clients/${clientId}/api-keys`)).body as {
      name: string;
      createdByStaff: boolean;
    }[];
    expect(admin.map((row) => [row.name, row.createdByStaff])).toEqual([
      ['Mine', false],
      ['Production server', true],
    ]);
    const mine = (await portal.call('GET', '/client/api-keys')).body as { name: string; createdByStaff: boolean }[];
    expect(mine.map((row) => [row.name, row.createdByStaff]).sort()).toEqual([
      ['Mine', false],
      ['Production server', true],
    ]);
  });

  it('audits the creation under the merchant without the key, and mails each merchant one security notice', async () => {
    const api = await staff();
    const english = await insertMerchant(db, { name: 'Zain Mobile Hub' });
    const other = await insertMerchant(db, { name: 'Cedar Phones' });
    const first = await api.post(`/admin/clients/${english}/api-keys`, BODY);
    await api.post(`/admin/clients/${other}/api-keys`, BODY);

    const audits = await db.select().from(s.auditLogs).orderBy(s.auditLogs.id);
    expect(audits[0]).toMatchObject({
      actorType: 'staff',
      actorId: api.staffId,
      action: 'created API key for',
      entityType: 'merchant',
      entityId: english,
      entityLabel: 'Zain Mobile Hub',
    });
    expect(audits[0]!.after).toMatchObject({
      name: 'Production server',
      prefix: first.body.key.prefix,
      scopes: ['orders:read', 'orders:write'],
      rateLimitPerMin: 60,
    });
    expect(JSON.stringify(audits)).not.toContain(first.body.secret);
    expect(JSON.stringify(audits)).not.toContain('keyHash');

    const sent = await notificationRows(db);
    expect(sent.map((row) => [row.event, row.recipientId])).toEqual([
      ['merchant.security_notice', english],
      ['merchant.security_notice', other],
    ]);
    expect(JSON.stringify(sent)).not.toContain(first.body.secret);
    await sendAllQueued(t);
    // Every merchant gets the one English template with the same fixed sentence (decision 039).
    const mails = mailbox(t).sent;
    expect(mails).toHaveLength(2);
    for (const mail of mails) {
      expect(mail.subject).toBe('A security change on your merchant account');
      expect(mail.text).toContain('a new API key was created for your account');
      expect(mail.text).not.toContain(first.body.secret);
    }
    expect(mails.find((mail) => mail.text.startsWith('Hi Cedar Phones,'))).toBeDefined();
  });

  it('refuses a pending or a suspended merchant with 409 NOT_ACTIVE and an unknown one with 404, writing nothing', async () => {
    const api = await staff();
    for (const status of ['pending', 'suspended'] as const) {
      const clientId = await insertMerchant(db, { status });
      const res = await api.post(`/admin/clients/${clientId}/api-keys`, BODY);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('NOT_ACTIVE');
    }
    expect((await api.post('/admin/clients/999999/api-keys', BODY)).status).toBe(404);
    expect(await keyRows()).toEqual([]);
    expect(await db.select().from(s.auditLogs)).toEqual([]);
    expect(await notificationRows(db)).toEqual([]);
  });

  it('answers 422 on the field for a bad scope, address, past expiry, limit and name, and writes nothing', async () => {
    const api = await staff();
    const clientId = await insertMerchant(db);
    const fields = async (patch: Record<string, unknown>): Promise<string[]> => {
      const res = await api.post(`/admin/clients/${clientId}/api-keys`, { ...BODY, ...patch });
      expect(res.status).toBe(422);
      return res.body.errors.map((error: { field: string }) => error.field);
    };
    expect(await fields({ scopes: ['orders:read', 'staff:read', '*'] })).toEqual(['scopes.1', 'scopes.2']);
    expect(await fields({ allowedIps: ['203.0.113.55', 'nope', '10.0.0.1/8'] })).toEqual([
      'allowedIps.1',
      'allowedIps.2',
    ]);
    expect(await fields({ expiresAt: new Date(clock.nowMs() - 1000).toISOString() })).toEqual(['expiresAt']);
    expect(await fields({ rateLimitPerMin: 0 })).toEqual(['rateLimitPerMin']);
    expect(await fields({ rateLimitPerMin: 6001 })).toEqual(['rateLimitPerMin']);
    expect(await fields({ rateLimitPerMin: 1.5 })).toEqual(['rateLimitPerMin']);
    expect(await fields({ name: '   ' })).toEqual(['name']);
    expect(await fields({ scopes: [] })).toEqual(['scopes']);
    expect(await keyRows()).toEqual([]);
    expect(await db.select().from(s.auditLogs)).toEqual([]);
    // The boundaries are accepted.
    for (const rateLimitPerMin of [1, 6000]) {
      expect(
        (
          await api.post(`/admin/clients/${clientId}/api-keys`, {
            ...BODY,
            name: `L${rateLimitPerMin}`,
            rateLimitPerMin,
          })
        ).status,
      ).toBe(201);
    }
  });

  it('refuses the eleventh live key with 422 on name, and a staff and a merchant creation in parallel at nine keys make exactly one more', async () => {
    const api = await staff();
    const clientId = await insertMerchant(db);
    for (let index = 0; index < 9; index++) await insertApiKey(t, db, clientId, { name: `K${index}` });
    const portal = await portalFor(t, clientId);
    const answers = await Promise.all([
      api.post(`/admin/clients/${clientId}/api-keys`, { ...BODY, name: 'Staff' }),
      portal.call('POST', '/client/api-keys', { name: 'Merchant', scopes: ['dhru'] }),
    ]);
    expect(answers.map((answer) => answer.status).sort()).toEqual([201, 422]);
    expect(await keyRows()).toHaveLength(10);

    const eleventh = await api.post(`/admin/clients/${clientId}/api-keys`, BODY);
    expect(eleventh.status).toBe(422);
    expect(eleventh.body.errors).toEqual([
      { field: 'name', code: 'invalid', message: 'This merchant already has 10 active keys; revoke one first.' },
    ]);
  });

  it('answers 403 without api_keys:create (api_keys:read only), 401 without a session and 403 CSRF_FAILED without a token', async () => {
    const clientId = await insertMerchant(db);
    const reader = await adminWith(t, ['api_keys:read']);
    const denied = await reader.post(`/admin/clients/${clientId}/api-keys`, BODY);
    expect(denied.status).toBe(403);
    expect(denied.body.detail).toContain('api_keys:create');
    const api = await staff();
    expect((await api.anonymous('POST', `/admin/clients/${clientId}/api-keys`, BODY)).status).toBe(401);
    const noCsrf = await api.withoutCsrf('POST', `/admin/clients/${clientId}/api-keys`, BODY);
    expect(noCsrf.status).toBe(403);
    expect(noCsrf.body.code).toBe('CSRF_FAILED');
    expect(await keyRows()).toEqual([]);
  });

  it('refuses a staff member who is not an Owner, even with api_keys:create, and stores no key and mails no notice (decision 046)', async () => {
    const clientId = await insertMerchant(db);
    const deputy = await staff(['api_keys:create', 'api_keys:read']);
    const refused = await deputy.post(`/admin/clients/${clientId}/api-keys`, BODY);
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe('FORBIDDEN');
    expect(refused.body.detail).toBe('Only an owner can create an API key for a merchant.');
    expect(await keyRows()).toEqual([]);
    expect(await notificationRows(db)).toEqual([]);
    expect(await db.select().from(s.outboxEvents)).toEqual([]);
    expect(await db.select().from(s.auditLogs)).toEqual([]);

    const owner = await staff();
    expect((await owner.post(`/admin/clients/${clientId}/api-keys`, BODY)).status).toBe(201);
  });

  it("the merchant's own POST /client/api-keys is unchanged: created_by is null and no notice is mailed", async () => {
    const clientId = await insertMerchant(db);
    const portal = await portalFor(t, clientId);
    const res = await portal.call('POST', '/client/api-keys', { name: 'Mine', scopes: ['dhru'] });
    expect(res.status).toBe(201);
    expect((await keyRows())[0]).toMatchObject({ createdBy: null, rateLimitPerMin: 60 });
    expect(await notificationRows(db)).toEqual([]);
  });
});

describe('PATCH /admin/api-keys/:id', () => {
  it('changes the limit and the allowed addresses, applies them on the next call and audits before and after', async () => {
    const api = await staff();
    const clientId = await insertMerchant(db, { name: 'Zain Mobile Hub' });
    const key = await insertApiKey(t, db, clientId, {
      name: 'Production',
      scopes: ['orders:read'],
      rateLimitPerMin: 60,
    });
    expect((await useKey(key.key, '198.51.100.9')).statusCode).toBe(200);

    const res = await api.patch(`/admin/api-keys/${key.id}`, { rateLimitPerMin: 2, allowedIps: ['203.0.113.55'] });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: key.id,
      rateLimitPerMin: 2,
      allowedIps: ['203.0.113.55'],
      createdByStaff: false,
    });
    // The cached view was dropped: the new addresses and the new limit apply at once.
    expect((await useKey(key.key, '198.51.100.9')).statusCode).toBe(403);
    // The refused call cost nothing; the call before the change used one of the new limit of 2 in this minute, so one more fits.
    expect((await useKey(key.key, '203.0.113.55')).statusCode).toBe(200);
    expect((await useKey(key.key, '203.0.113.55')).statusCode).toBe(429);

    const [audit] = await db.select().from(s.auditLogs);
    expect(audit).toMatchObject({
      actorType: 'staff',
      actorId: api.staffId,
      action: 'changed limits of API key of',
      entityType: 'merchant',
      entityId: clientId,
      entityLabel: 'Zain Mobile Hub',
    });
    expect(audit!.before).toMatchObject({ keyId: key.id, name: 'Production', rateLimitPerMin: 60, allowedIps: [] });
    expect(audit!.after).toMatchObject({ keyId: key.id, rateLimitPerMin: 2, allowedIps: ['203.0.113.55/32'] });
    expect(JSON.stringify(audit)).not.toContain(key.key);
    expect(JSON.stringify(audit)).not.toContain(key.keyHash);
  });

  it('accepts one field alone, lets an empty list remove the restriction, and keeps the other value', async () => {
    const api = await staff();
    const clientId = await insertMerchant(db);
    const key = await insertApiKey(t, db, clientId, { allowedIps: ['203.0.113.55/32'], rateLimitPerMin: 90 });
    const limit = await api.patch(`/admin/api-keys/${key.id}`, { rateLimitPerMin: 300 });
    expect(limit.body).toMatchObject({ rateLimitPerMin: 300, allowedIps: ['203.0.113.55'] });
    const open = await api.patch(`/admin/api-keys/${key.id}`, { allowedIps: [] });
    expect(open.body).toMatchObject({ rateLimitPerMin: 300, allowedIps: [] });
    expect((await useKey(key.key, '192.0.2.5')).statusCode).toBe(200);
  });

  it('answers 422 for an empty body, a bad limit and a bad address; 404 for an unknown key; 409 ALREADY_REVOKED for a revoked key', async () => {
    const api = await staff();
    const clientId = await insertMerchant(db);
    const key = await insertApiKey(t, db, clientId, {});
    const empty = await api.patch(`/admin/api-keys/${key.id}`, {});
    expect(empty.status).toBe(422);
    const bad = await api.patch(`/admin/api-keys/${key.id}`, { rateLimitPerMin: 6001 });
    expect(bad.body.errors.map((error: { field: string }) => error.field)).toEqual(['rateLimitPerMin']);
    const badIp = await api.patch(`/admin/api-keys/${key.id}`, { allowedIps: ['203.0.113.55', 'nope'] });
    expect(badIp.body.errors.map((error: { field: string }) => error.field)).toEqual(['allowedIps.1']);
    expect((await api.patch('/admin/api-keys/999999', { rateLimitPerMin: 5 })).status).toBe(404);

    const revoked = await insertApiKey(t, db, clientId, { revokedAt: clock.now() });
    const refused = await api.patch(`/admin/api-keys/${revoked.id}`, { rateLimitPerMin: 5 });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('ALREADY_REVOKED');
    expect(await db.select().from(s.auditLogs)).toEqual([]);
    const [row] = await db.select().from(s.apiKeys).where(eq(s.apiKeys.id, key.id));
    expect(row!.rateLimitPerMin).toBe(60);
  });

  it('answers 403 without api_keys:update and 401 without a session', async () => {
    const clientId = await insertMerchant(db);
    const key = await insertApiKey(t, db, clientId, {});
    const creator = await adminWith(t, ['api_keys:create', 'api_keys:read', 'api_keys:revoke']);
    const denied = await creator.patch(`/admin/api-keys/${key.id}`, { rateLimitPerMin: 5 });
    expect(denied.status).toBe(403);
    expect(denied.body.detail).toContain('api_keys:update');
    expect((await creator.anonymous('PATCH', `/admin/api-keys/${key.id}`, { rateLimitPerMin: 5 })).status).toBe(401);
  });

  it('works for a suspended merchant (a limit can be lowered while the account is suspended)', async () => {
    const api = await staff();
    const clientId = await insertMerchant(db, { status: 'suspended' });
    const key = await insertApiKey(t, db, clientId, {});
    expect((await api.patch(`/admin/api-keys/${key.id}`, { rateLimitPerMin: 5 })).status).toBe(200);
  });
});

describe('expiry and the clock', () => {
  it('a staff-made key with an expiry stops working at it', async () => {
    const api = await staff();
    const clientId = await insertMerchant(db);
    const expiresAt = new Date(clock.nowMs() + DAY).toISOString();
    const { body } = await api.post(`/admin/clients/${clientId}/api-keys`, { ...BODY, expiresAt });
    expect(body.key.expiresAt).toBe(expiresAt);
    expect((await useKey(body.secret)).statusCode).toBe(200);
    clock.advance(2 * DAY);
    expect((await useKey(body.secret)).statusCode).toBe(401);
    expect((await db.select().from(s.apiKeys).orderBy(desc(s.apiKeys.id)))[0]!.expiresAt?.toISOString()).toBe(
      expiresAt,
    );
  });
});
