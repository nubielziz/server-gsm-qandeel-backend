// Integration tests of the API key routes (feature 7b, stage 7): the merchant's own keys under /client/api-keys (MISMATCHES B155) and
// the staff's view and revocation (GET /admin/clients/:id/api-keys, DELETE /admin/api-keys/:id), on the real application with real
// Postgres and Redis. A created key is used on a REST v1 sample route to prove that a change or a revocation applies at once.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { desc, eq } from 'drizzle-orm';
import { TokenService } from '../../src/infra/crypto';
import { type Database, schema as s } from '../../src/infra/db';
import { ApiKeyDirectory } from '../../src/modules/identity';
import { type TestApp, createTestApp } from '../support/app';
import { adminWith } from '../support/admin-api';
import { clearIdentityCaches, insertMerchant } from '../support/auth';
import { DAY, TestClock } from '../support/clock';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { MachineTestController, insertApiKey } from '../support/machine-auth';
import { type PortalClient, portalFor } from '../support/webhooks';

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
});

/** A merchant with a signed-in portal client. */
async function merchant(overrides: Partial<typeof s.clients.$inferInsert> = {}): Promise<PortalClient> {
  return portalFor(t, await insertMerchant(db, overrides));
}

/** Calls the REST v1 sample route that needs `orders:read` with a key, from an address. */
function useKey(key: string, ip = '127.0.0.1') {
  return t.app.inject({
    method: 'GET',
    url: '/v1/t/mach/read',
    headers: { authorization: `Bearer ${key}` },
    remoteAddress: ip,
  });
}

describe('POST /client/api-keys', () => {
  it('creates a key, shows the full key once and stores only its hash and prefix', async () => {
    const m = await merchant();
    const res = await m.call('POST', '/client/api-keys', {
      name: '  Production server ',
      scopes: ['orders:read', 'orders:write'],
      allowedIps: ['203.0.113.55', '198.51.100.0/24'],
    });
    expect(res.status).toBe(201);
    expect(res.res.headers['cache-control']).toBe('no-store');
    const { key, secret } = res.body;
    expect(secret).toMatch(/^gsm_[A-Za-z0-9_-]{43}$/);
    expect(key).toMatchObject({
      clientId: m.clientId,
      name: 'Production server',
      prefix: secret.slice(0, 8),
      scopes: ['orders:read', 'orders:write'],
      allowedIps: ['203.0.113.55', '198.51.100.0/24'],
      rateLimitPerMin: 60,
      lastUsedAt: null,
      lastUsedIp: '',
      expiresAt: null,
      revokedAt: null,
    });
    expect(JSON.stringify(key)).not.toContain(secret);

    const [row] = await db.select().from(s.apiKeys).where(eq(s.apiKeys.id, key.id));
    expect(row?.keyHash).toBe(t.app.get(TokenService).hash(secret));
    expect(row?.keyHash).not.toBe(secret);
    expect(row?.allowedIps).toEqual(['203.0.113.55/32', '198.51.100.0/24']);
    expect(row?.prefix).toBe(secret.slice(0, 8));
  });

  it('writes no audit row (merchant routes are not audited, B121)', async () => {
    const m = await merchant();
    await m.call('POST', '/client/api-keys', { name: 'A', scopes: ['dhru'] });
    expect(await db.select().from(s.auditLogs)).toEqual([]);
  });

  it('gives a key that works at once on the REST v1 routes, within its scopes', async () => {
    const m = await merchant();
    const { secret } = (await m.call('POST', '/client/api-keys', { name: 'A', scopes: ['orders:*'] })).body;
    expect((await useKey(secret)).statusCode).toBe(200);
    const narrow = (await m.call('POST', '/client/api-keys', { name: 'B', scopes: ['account:read'] })).body.secret;
    expect((await useKey(narrow)).statusCode).toBe(403);
  });

  it('stores an expiry that the guard honours', async () => {
    const m = await merchant();
    const expiresAt = new Date(clock.nowMs() + DAY).toISOString();
    const { secret, key } = (
      await m.call('POST', '/client/api-keys', { name: 'A', scopes: ['orders:read'], expiresAt })
    ).body;
    expect(key.expiresAt).toBe(expiresAt);
    expect((await useKey(secret)).statusCode).toBe(200);
    clock.advance(2 * DAY);
    expect((await useKey(secret)).statusCode).toBe(401);
  });

  it('refuses invalid input with 422 on the field', async () => {
    const m = await merchant();
    const fields = async (payload: unknown) => {
      const res = await m.call('POST', '/client/api-keys', payload);
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('VALIDATION_FAILED');
      return res.body.errors.map((error: { field: string }) => error.field);
    };
    expect(await fields({ name: '   ', scopes: ['dhru'] })).toContain('name');
    expect(await fields({ name: 'x'.repeat(61), scopes: ['dhru'] })).toContain('name');
    expect(await fields({ name: 'A', scopes: [] })).toContain('scopes');
    expect(await fields({ name: 'A', scopes: ['dhru', 'staff:read', '*'] })).toEqual(['scopes.1', 'scopes.2']);
    expect(
      await fields({ name: 'A', scopes: ['dhru'], allowedIps: ['203.0.113.5', 'nope', '203.0.113.5/24'] }),
    ).toEqual(['allowedIps.1', 'allowedIps.2']);
    expect(
      await fields({ name: 'A', scopes: ['dhru'], allowedIps: Array.from({ length: 21 }, (_, i) => `203.0.113.${i}`) }),
    ).toContain('allowedIps');
    expect(
      await fields({ name: 'A', scopes: ['dhru'], expiresAt: new Date(clock.nowMs() - 1000).toISOString() }),
    ).toEqual(['expiresAt']);
    expect(await fields({ name: 'A', scopes: ['dhru'], expiresAt: 'tomorrow' })).toContain('expiresAt');
    expect(await db.select().from(s.apiKeys)).toEqual([]);
  });

  it('refuses the 11th live key with 422 on name, but a revoked or expired key does not count', async () => {
    const m = await merchant();
    for (let index = 0; index < 8; index++) {
      expect((await m.call('POST', '/client/api-keys', { name: `K${index}`, scopes: ['dhru'] })).status).toBe(201);
    }
    await insertApiKey(t, db, m.clientId, { revokedAt: clock.now() });
    await insertApiKey(t, db, m.clientId, { expiresAt: new Date(clock.nowMs() - 1000) });
    expect((await m.call('POST', '/client/api-keys', { name: 'K8', scopes: ['dhru'] })).status).toBe(201);
    expect((await m.call('POST', '/client/api-keys', { name: 'K9', scopes: ['dhru'] })).status).toBe(201);
    const eleventh = await m.call('POST', '/client/api-keys', { name: 'K10', scopes: ['dhru'] });
    expect(eleventh.status).toBe(422);
    expect(eleventh.body.errors).toEqual([
      { field: 'name', code: 'invalid', message: 'You already have 10 active keys; revoke one first.' },
    ]);
  });

  it('never holds more than 10 live keys when requests arrive together', async () => {
    const m = await merchant();
    const answers = await Promise.all(
      Array.from({ length: 14 }, (_, index) =>
        m.call('POST', '/client/api-keys', { name: `K${index}`, scopes: ['dhru'] }),
      ),
    );
    expect(answers.filter((answer) => answer.status === 201)).toHaveLength(10);
    expect(answers.filter((answer) => answer.status === 422)).toHaveLength(4);
    expect(await db.select().from(s.apiKeys)).toHaveLength(10);
  });

  it('needs a session, a CSRF token and an approved merchant', async () => {
    const m = await merchant();
    const payload = { name: 'A', scopes: ['dhru'] };
    expect((await m.withoutCsrf('POST', '/client/api-keys', payload)).status).toBe(403);
    expect((await m.withoutCsrf('POST', '/client/api-keys', payload)).body.code).toBe('CSRF_FAILED');
    const anonymous = await t.app.inject({ method: 'POST', url: '/client/api-keys', payload });
    expect(anonymous.statusCode).toBe(401);
    const pending = await merchant({ status: 'pending' });
    const refused = await pending.call('POST', '/client/api-keys', payload);
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe('ACCOUNT_PENDING_APPROVAL');
    const staff = await adminWith(t, ['*']);
    expect((await staff.post('/client/api-keys', payload)).status).toBe(401);
  });
});

describe('GET /client/api-keys', () => {
  it('lists live keys first, then revoked ones, newest first, with the exact total', async () => {
    const m = await merchant();
    const first = await insertApiKey(t, db, m.clientId, { name: 'first' });
    const revoked = await insertApiKey(t, db, m.clientId, { name: 'revoked', revokedAt: clock.now() });
    const second = await insertApiKey(t, db, m.clientId, {
      name: 'second',
      allowedIps: ['203.0.113.55/32'],
      lastUsedIp: '203.0.113.55',
    });
    const res = await m.call('GET', '/client/api-keys');
    expect(res.status).toBe(200);
    expect(res.total).toBe(3);
    expect(res.body.map((row: { id: number }) => row.id)).toEqual([second.id, first.id, revoked.id]);
    expect(res.body[0]).toMatchObject({ allowedIps: ['203.0.113.55'], lastUsedIp: '203.0.113.55' });
    expect(res.body[1].lastUsedIp).toBe('');
    expect(JSON.stringify(res.body)).not.toContain('keyHash');
    expect(JSON.stringify(res.body)).not.toContain(first.key);
  });

  it('pages with _start and _end and keeps the total', async () => {
    const m = await merchant();
    for (let index = 0; index < 5; index++) await insertApiKey(t, db, m.clientId, { name: `k${index}` });
    const page = await m.call('GET', '/client/api-keys?_start=1&_end=3');
    expect(page.body).toHaveLength(2);
    expect(page.total).toBe(5);
    expect((await m.call('GET', '/client/api-keys?_sort=createdAt&_order=asc')).body[0].name).toBe('k0');
  });

  it("never shows another merchant's keys", async () => {
    const mine = await merchant();
    const other = await merchant();
    await insertApiKey(t, db, other.clientId, { name: 'theirs' });
    expect((await mine.call('GET', '/client/api-keys')).body).toEqual([]);
    expect((await mine.call('GET', '/client/api-keys')).total).toBe(0);
  });
});

describe('PATCH /client/api-keys/:id', () => {
  it('renames a key and keeps the rest', async () => {
    const m = await merchant();
    const { id } = await insertApiKey(t, db, m.clientId, { name: 'old', scopes: ['dhru'] });
    const res = await m.call('PATCH', `/client/api-keys/${id}`, { name: ' new name ' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id, name: 'new name', scopes: ['dhru'] });
    expect(await m.call('PATCH', `/client/api-keys/${id}`, {})).toMatchObject({ status: 200 });
  });

  it('changes the allowed addresses and applies them on the next call, not after the cache minute', async () => {
    const m = await merchant();
    const { secret } = (await m.call('POST', '/client/api-keys', { name: 'A', scopes: ['orders:read'] })).body;
    const id = (await db.select().from(s.apiKeys).orderBy(desc(s.apiKeys.id)))[0]!.id;
    expect((await useKey(secret, '198.51.100.9')).statusCode).toBe(200);
    const res = await m.call('PATCH', `/client/api-keys/${id}`, { allowedIps: ['203.0.113.55'] });
    expect(res.body.allowedIps).toEqual(['203.0.113.55']);
    expect((await useKey(secret, '198.51.100.9')).statusCode).toBe(403);
    expect((await useKey(secret, '203.0.113.55')).statusCode).toBe(200);
    expect((await m.call('PATCH', `/client/api-keys/${id}`, { allowedIps: [] })).body.allowedIps).toEqual([]);
    expect((await useKey(secret, '198.51.100.9')).statusCode).toBe(200);
  });

  it('refuses bad addresses and names on their field, and a revoked key with 409', async () => {
    const m = await merchant();
    const { id } = await insertApiKey(t, db, m.clientId);
    const badIp = await m.call('PATCH', `/client/api-keys/${id}`, { allowedIps: ['203.0.113.55', 'nope'] });
    expect(badIp.status).toBe(422);
    expect(badIp.body.errors.map((error: { field: string }) => error.field)).toEqual(['allowedIps.1']);
    const badName = await m.call('PATCH', `/client/api-keys/${id}`, { name: '' });
    expect(badName.body.errors.map((error: { field: string }) => error.field)).toEqual(['name']);
    const gone = await insertApiKey(t, db, m.clientId, { revokedAt: clock.now() });
    const refused = await m.call('PATCH', `/client/api-keys/${gone.id}`, { name: 'x' });
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: 'INVALID_TRANSITION', detail: 'This key is revoked.' });
  });

  it("answers 404 for another merchant's key and an unknown one", async () => {
    const mine = await merchant();
    const other = await merchant();
    const theirs = await insertApiKey(t, db, other.clientId, { name: 'theirs' });
    expect((await mine.call('PATCH', `/client/api-keys/${theirs.id}`, { name: 'mine now' })).status).toBe(404);
    expect((await mine.call('PATCH', '/client/api-keys/999999', { name: 'x' })).status).toBe(404);
    const [row] = await db.select().from(s.apiKeys).where(eq(s.apiKeys.id, theirs.id));
    expect(row?.name).toBe('theirs');
  });
});

describe('DELETE /client/api-keys/:id', () => {
  it('revokes the key: it stops working on the next call, and a second delete is 204 too', async () => {
    const m = await merchant();
    const { secret } = (await m.call('POST', '/client/api-keys', { name: 'A', scopes: ['orders:read'] })).body;
    const id = (await db.select().from(s.apiKeys))[0]!.id;
    expect((await useKey(secret)).statusCode).toBe(200);
    const res = await m.call('DELETE', `/client/api-keys/${id}`);
    expect(res.status).toBe(204);
    expect(res.body).toBeUndefined();
    expect((await useKey(secret)).statusCode).toBe(401);
    const [row] = await db.select().from(s.apiKeys).where(eq(s.apiKeys.id, id));
    expect(row?.revokedAt?.toISOString()).toBe(clock.now().toISOString());
    clock.advance(DAY);
    expect((await m.call('DELETE', `/client/api-keys/${id}`)).status).toBe(204);
    const [again] = await db.select().from(s.apiKeys).where(eq(s.apiKeys.id, id));
    expect(again?.revokedAt?.toISOString()).toBe(row?.revokedAt?.toISOString());
  });

  it("answers 404 for another merchant's key and an unknown one, and leaves the key alone", async () => {
    const mine = await merchant();
    const other = await merchant();
    const theirs = await insertApiKey(t, db, other.clientId);
    expect((await mine.call('DELETE', `/client/api-keys/${theirs.id}`)).status).toBe(404);
    expect((await mine.call('DELETE', '/client/api-keys/999999')).status).toBe(404);
    expect((await useKey(theirs.key)).statusCode).toBe(200);
  });

  it('lets a merchant keep using the portal after revoking, and shows the revoked key last in the list', async () => {
    const m = await merchant();
    const a = await insertApiKey(t, db, m.clientId, { name: 'a' });
    await insertApiKey(t, db, m.clientId, { name: 'b' });
    await m.call('DELETE', `/client/api-keys/${a.id}`);
    const list = await m.call('GET', '/client/api-keys');
    expect(list.body.map((row: { name: string }) => row.name)).toEqual(['b', 'a']);
  });
});

describe('GET /admin/clients/:id/api-keys', () => {
  it('lists every key of a merchant as a plain array, newest first, revoked and expired included', async () => {
    const staff = await adminWith(t, ['api_keys:read']);
    const id = await insertMerchant(db);
    const live = await insertApiKey(t, db, id, { name: 'live' });
    const revoked = await insertApiKey(t, db, id, { name: 'revoked', revokedAt: clock.now() });
    const expired = await insertApiKey(t, db, id, { name: 'expired', expiresAt: new Date(clock.nowMs() - 1000) });
    await insertApiKey(t, db, await insertMerchant(db), { name: 'someone else' });
    const res = await staff.get(`/admin/clients/${id}/api-keys`);
    expect(res.status).toBe(200);
    expect(Number.isNaN(res.total)).toBe(true);
    expect(res.body.map((row: { id: number }) => row.id)).toEqual([expired.id, revoked.id, live.id]);
    expect(res.body[1].revokedAt).toBe(clock.now().toISOString());
    expect(res.body[0].expiresAt).toBe(new Date(clock.nowMs() - 1000).toISOString());
    expect(JSON.stringify(res.body)).not.toContain('keyHash');
  });

  it('answers 404 for an unknown merchant, 403 without api_keys:read and 401 without a session', async () => {
    const staff = await adminWith(t, ['api_keys:read']);
    expect((await staff.get('/admin/clients/999999/api-keys')).status).toBe(404);
    const other = await adminWith(t, ['clients:read']);
    const id = await insertMerchant(db);
    expect((await other.get(`/admin/clients/${id}/api-keys`)).status).toBe(403);
    expect((await staff.anonymous('GET', `/admin/clients/${id}/api-keys`)).status).toBe(401);
  });
});

describe('DELETE /admin/api-keys/:id', () => {
  it('revokes the key at once, audits it with the demo phrase and keeps the secret out of the log', async () => {
    const staff = await adminWith(t, ['api_keys:revoke'], { name: 'Rami K.' });
    const id = await insertMerchant(db, { name: 'Zain Mobile Hub' });
    const key = await insertApiKey(t, db, id, { name: 'Production', scopes: ['orders:read'] });
    expect((await useKey(key.key)).statusCode).toBe(200);
    const res = await staff.delete(`/admin/api-keys/${key.id}`);
    expect(res.status).toBe(204);
    expect((await useKey(key.key)).statusCode).toBe(401);
    const [row] = await db.select().from(s.apiKeys).where(eq(s.apiKeys.id, key.id));
    expect(row?.revokedAt).not.toBeNull();

    const [audit] = await db.select().from(s.auditLogs);
    expect(audit).toMatchObject({
      actorType: 'staff',
      actorId: staff.staffId,
      actorName: 'Rami K.',
      action: 'revoked API key of',
      entityType: 'merchant',
      entityId: id,
      entityLabel: 'Zain Mobile Hub',
    });
    expect(audit?.after).toMatchObject({ keyId: key.id, name: 'Production', revoked: true });
    expect(JSON.stringify(audit)).not.toContain(key.key);
    expect(JSON.stringify(audit)).not.toContain(key.keyHash);
  });

  it('answers 409 ALREADY_REVOKED for a key revoked before, and writes no second audit row', async () => {
    const staff = await adminWith(t, ['api_keys:revoke']);
    const id = await insertMerchant(db);
    const key = await insertApiKey(t, db, id);
    expect((await staff.delete(`/admin/api-keys/${key.id}`)).status).toBe(204);
    const again = await staff.delete(`/admin/api-keys/${key.id}`);
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('ALREADY_REVOKED');
    expect(await db.select().from(s.auditLogs)).toHaveLength(1);
  });

  it('answers 404 for an unknown key and 403 without api_keys:revoke', async () => {
    const staff = await adminWith(t, ['api_keys:revoke']);
    expect((await staff.delete('/admin/api-keys/999999')).status).toBe(404);
    const reader = await adminWith(t, ['api_keys:read']);
    const key = await insertApiKey(t, db, await insertMerchant(db));
    expect((await reader.delete(`/admin/api-keys/${key.id}`)).status).toBe(403);
    expect((await useKey(key.key)).statusCode).toBe(200);
  });

  it('is the same row the merchant sees as revoked', async () => {
    const staff = await adminWith(t, ['api_keys:revoke']);
    const m = await merchant();
    const key = await insertApiKey(t, db, m.clientId);
    await staff.delete(`/admin/api-keys/${key.id}`);
    const list = await m.call('GET', '/client/api-keys');
    expect(list.body[0].revokedAt).toBe(clock.now().toISOString());
  });
});

describe('a suspended merchant', () => {
  it('cannot use its keys once the cached view of them is dropped (the clients route does that after the commit)', async () => {
    const id = await insertMerchant(db);
    const key = await insertApiKey(t, db, id, { scopes: ['orders:read'] });
    expect((await useKey(key.key)).statusCode).toBe(200);
    await db.update(s.clients).set({ status: 'suspended' }).where(eq(s.clients.id, id));
    await t.app.get(ApiKeyDirectory).invalidateClient(id);
    expect((await useKey(key.key)).statusCode).toBe(403);
  });
});
