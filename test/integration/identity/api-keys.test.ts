// Integration tests of the API key routes (feature 7b, stage 7; decisions 064 and 067): the merchant's read-only list under
// /client/api-keys (MISMATCHES B155), the 404 of its three retired write routes, and the staff's view, creation and revocation (GET and POST
// /admin/clients/:id/api-keys, DELETE /admin/api-keys/:id), on the real application with real Postgres and Redis. A key is used on the Dhru
// endpoint to prove that a revocation applies at once. A retail account holds no key: staff's creation refuses it from the locked account
// row, and a rank change revokes every live key.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { TokenService } from '@src/infra/crypto';
import { type Database, schema as s } from '@src/infra/db';
import { ApiKeyDirectory } from '@src/modules/identity';
import { type TestApp, createTestApp } from '../../support/app';
import { adminWith } from '../../support/admin-api';
import { makeAccount } from '../../support/accounts';
import { clearIdentityCaches, insertMerchant } from '../../support/auth';
import { DAY, TestClock } from '../../support/clock';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { insertApiKey } from '../../support/machine-auth';
import { type PortalClient, portalFor } from '../../support/portal-orders';

const clock = new TestClock('2026-11-01T10:00:00.000Z');
let t: TestApp;
let db: Database;

beforeAll(async () => {
  ({ db } = await testDb());
  t = await createTestApp({ clock });
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

/** Calls the Dhru `accountinfo` action with a key and the username of its merchant, from an address. */
async function useKey(key: string, ip = '127.0.0.1') {
  const [owner] = await db
    .select({ username: s.clients.username })
    .from(s.apiKeys)
    .innerJoin(s.clients, eq(s.clients.id, s.apiKeys.clientId))
    .where(eq(s.apiKeys.keyHash, t.app.get(TokenService).hash(key)));
  return t.app.inject({
    method: 'POST',
    url: '/api/index.php',
    remoteAddress: ip,
    payload: { action: 'accountinfo', username: owner!.username, apiaccesskey: key } as never,
  });
}

/** True when the Dhru answer is a success, false when it is the envelope of a refusal. */
const works = (res: { json: () => { SUCCESS?: unknown } }): boolean => res.json().SUCCESS !== undefined;
/** The message of a Dhru refusal. */
const refusal = (res: { json: () => { ERROR?: Array<{ MESSAGE: string }> } }): string | undefined =>
  res.json().ERROR?.[0]?.MESSAGE;

describe('GET /client/api-keys', () => {
  it('refuses a retail account with 403 RANK_NOT_ALLOWED and shows no key', async () => {
    const retail = await portalFor(t, (await makeAccount(t, { rank: 'retail' })).id);
    await insertApiKey(t, db, (await makeAccount(t, { rank: 'merchant' })).id);
    const res = await retail.call('GET', '/client/api-keys');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('RANK_NOT_ALLOWED');
  });

  it('needs a session and an active merchant', async () => {
    const anonymous = await t.app.inject({ method: 'GET', url: '/client/api-keys' });
    expect(anonymous.statusCode).toBe(401);
    for (const status of ['suspended', 'blocked'] as const) {
      const refused = await (await merchant({ status })).call('GET', '/client/api-keys');
      expect(refused.status, status).toBe(403);
      expect(refused.body.code, status).toBe('ACCOUNT_SUSPENDED');
    }
    const staff = await adminWith(t, ['*']);
    expect((await staff.get('/client/api-keys')).status).toBe(401);
  });

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
    // One creation time for all five: the order must not depend on how fast the inserts ran, the id breaks the tie.
    const createdAt = clock.now();
    for (let index = 0; index < 5; index++) await insertApiKey(t, db, m.clientId, { name: `k${index}`, createdAt });
    const page = await m.call('GET', '/client/api-keys?_start=1&_end=3');
    expect(page.body).toHaveLength(2);
    expect(page.total).toBe(5);
    const names = (query: string) =>
      m.call('GET', `/client/api-keys${query}`).then((res) => res.body.map((row: { name: string }) => row.name));
    expect(await names('?_sort=createdAt&_order=asc')).toEqual(['k0', 'k1', 'k2', 'k3', 'k4']);
    expect(await names('?_sort=createdAt&_order=desc')).toEqual(['k4', 'k3', 'k2', 'k1', 'k0']);
    // The pages of a tied sort do not repeat or skip a key.
    expect(await names('?_sort=createdAt&_order=asc&_start=1&_end=3')).toEqual(['k1', 'k2']);
  });

  it("never shows another merchant's keys", async () => {
    const mine = await merchant();
    const other = await merchant();
    await insertApiKey(t, db, other.clientId, { name: 'theirs' });
    expect((await mine.call('GET', '/client/api-keys')).body).toEqual([]);
    expect((await mine.call('GET', '/client/api-keys')).total).toBe(0);
  });
});

describe('the retired write routes of the merchant portal (decision 067)', () => {
  it('answers 404 to a merchant session on POST, PATCH and DELETE, writes no key row and changes none', async () => {
    const m = await merchant();
    const own = await insertApiKey(t, db, m.clientId, { name: 'made before' });
    const before = await db.select().from(s.apiKeys);
    for (const [method, url, payload] of [
      ['POST', '/client/api-keys', { name: 'A' }],
      ['PATCH', `/client/api-keys/${own.id}`, { name: 'renamed' }],
      ['DELETE', `/client/api-keys/${own.id}`, undefined],
    ] as const) {
      const res = await m.call(method, url, payload);
      expect(res.status, `${method} ${url}`).toBe(404);
      expect(res.body.code, `${method} ${url}`).toBe('NOT_FOUND');
    }
    // No key was written, renamed or revoked, and the key made before keeps working until staff revoke it.
    expect(await db.select().from(s.apiKeys)).toEqual(before);
    expect(works(await useKey(own.key))).toBe(true);
    expect((await m.call('GET', '/client/api-keys')).status).toBe(200);
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
    const key = await insertApiKey(t, db, id, { name: 'Production' });
    expect(works(await useKey(key.key))).toBe(true);
    const res = await staff.delete(`/admin/api-keys/${key.id}`);
    expect(res.status).toBe(204);
    expect(refusal(await useKey(key.key))).toBe('Authentication Failed');
    const [row] = await db.select().from(s.apiKeys).where(eq(s.apiKeys.id, key.id));
    expect(row?.revokedAt).not.toBeNull();

    const [audit] = await db.select().from(s.auditLogs);
    expect(audit).toMatchObject({
      actorType: 'staff',
      actorId: staff.staffId,
      actorName: 'Rami K.',
      action: 'revoked API key of',
      entityType: 'account',
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
    expect(works(await useKey(key.key))).toBe(true);
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
    const key = await insertApiKey(t, db, id);
    expect(works(await useKey(key.key))).toBe(true);
    await db.update(s.clients).set({ status: 'suspended' }).where(eq(s.clients.id, id));
    await t.app.get(ApiKeyDirectory).invalidateClient(id);
    expect(refusal(await useKey(key.key))).toBe('This merchant account is suspended.');
  });

  it('is refused the same way when blocked', async () => {
    const id = await insertMerchant(db);
    const key = await insertApiKey(t, db, id);
    expect(works(await useKey(key.key))).toBe(true);
    await db.update(s.clients).set({ status: 'blocked' }).where(eq(s.clients.id, id));
    await t.app.get(ApiKeyDirectory).invalidateClient(id);
    expect(refusal(await useKey(key.key))).toBe('This merchant account is suspended.');
  });
});

describe('POST /admin/clients/:id/api-keys, by rank and status (decision 064)', () => {
  const body = { name: 'Production server', allowedIps: ['203.0.113.55'] };

  it('creates a key for an active account of a merchant rank, audits it under the entity account and keeps the key out of the log', async () => {
    const owner = await adminWith(t, ['*'], { name: 'Rami K.' });
    const id = await insertMerchant(db, { name: 'Zain Mobile Hub' });
    const res = await owner.post(`/admin/clients/${id}/api-keys`, body);
    expect(res.status).toBe(201);
    expect(res.body.key).toMatchObject({ clientId: id, createdByStaff: true });
    // The key only works from the address it allows.
    expect(works(await useKey(res.body.secret, '203.0.113.55'))).toBe(true);
    const [audit] = await db.select().from(s.auditLogs);
    expect(audit).toMatchObject({
      actorType: 'staff',
      action: 'created API key for',
      entityType: 'account',
      entityId: id,
      entityLabel: 'Zain Mobile Hub',
    });
    expect(JSON.stringify(audit)).not.toContain(res.body.secret);
  });

  it('refuses a retail account and a guest with 409 CONFLICT, and writes no key, no audit entry and no notice', async () => {
    const owner = await adminWith(t, ['*']);
    const retail = await makeAccount(t, { rank: 'retail' });
    const guest = await makeAccount(t, { rank: 'retail', guest: true });
    for (const account of [retail, guest]) {
      const res = await owner.post(`/admin/clients/${account.id}/api-keys`, body);
      expect(res.status, String(account.id)).toBe(409);
      expect(res.body.code, String(account.id)).toBe('CONFLICT');
    }
    expect(await db.select().from(s.apiKeys)).toEqual([]);
    expect(await db.select().from(s.auditLogs)).toEqual([]);
    expect(await db.select().from(s.notifications)).toEqual([]);
  });

  it('refuses a suspended, blocked or erased merchant with 409 NOT_ACTIVE and an unknown account with 404', async () => {
    const owner = await adminWith(t, ['*']);
    for (const columns of [
      { status: 'suspended' },
      { status: 'blocked' },
      { status: 'anonymized', anonymizedAt: clock.now() },
    ] as const) {
      const id = await insertMerchant(db, columns);
      const res = await owner.post(`/admin/clients/${id}/api-keys`, body);
      expect(res.status, columns.status).toBe(409);
      expect(res.body.code, columns.status).toBe('NOT_ACTIVE');
    }
    expect((await owner.post('/admin/clients/999999/api-keys', body)).status).toBe(404);
    expect(await db.select().from(s.apiKeys)).toEqual([]);
  });

  it('still lists the keys of an account that left the merchant rank, all revoked', async () => {
    const staff = await adminWith(t, ['api_keys:read']);
    const id = await insertMerchant(db);
    const key = await insertApiKey(t, db, id, { name: 'old', revokedAt: clock.now() });
    const retail = await makeAccount(t, { rank: 'retail' });
    await db.update(s.clients).set({ groupId: retail.groupId }).where(eq(s.clients.id, id));
    const res = await staff.get(`/admin/clients/${id}/api-keys`);
    expect(res.status).toBe(200);
    expect(res.body.map((row: { id: number }) => row.id)).toEqual([key.id]);
    expect((await staff.get(`/admin/clients/${retail.id}/api-keys`)).body).toEqual([]);
  });
});

describe('ApiKeyDirectory.revokeLiveKeysOf', () => {
  it('revokes every live key of the account and no other, leaves an earlier revocation time alone, and applies at once once the views are dropped', async () => {
    const id = await insertMerchant(db);
    const other = await insertMerchant(db);
    const earlier = new Date(clock.nowMs() - DAY);
    const first = await insertApiKey(t, db, id, { name: 'first' });
    const second = await insertApiKey(t, db, id, { name: 'second', expiresAt: new Date(clock.nowMs() + DAY) });
    const done = await insertApiKey(t, db, id, { name: 'done', revokedAt: earlier });
    const theirs = await insertApiKey(t, db, other, { name: 'theirs' });
    expect(works(await useKey(first.key))).toBe(true);

    const directory = t.app.get(ApiKeyDirectory);
    const count = await db.transaction((tx) => directory.revokeLiveKeysOf(tx, id));
    expect(count).toBe(2);
    // The views are cached for a minute: the transaction drops them, as the rank change does after its commit (revoked keys included).
    await directory.invalidateClient(id);

    const rows = await db.select().from(s.apiKeys).where(eq(s.apiKeys.clientId, id));
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get(first.id)?.revokedAt?.toISOString()).toBe(clock.now().toISOString());
    expect(byId.get(second.id)?.revokedAt?.toISOString()).toBe(clock.now().toISOString());
    expect(byId.get(done.id)?.revokedAt?.toISOString()).toBe(earlier.toISOString());
    expect(refusal(await useKey(first.key))).toBe('Authentication Failed');
    expect(refusal(await useKey(second.key))).toBe('Authentication Failed');
    expect(works(await useKey(theirs.key))).toBe(true);
    // A second call finds nothing to revoke.
    expect(await db.transaction((tx) => directory.revokeLiveKeysOf(tx, id))).toBe(0);
  });

  it('never brings a revoked key back when the account returns to a merchant rank', async () => {
    const id = await insertMerchant(db);
    const [before] = await db.select({ groupId: s.clients.groupId }).from(s.clients).where(eq(s.clients.id, id));
    const merchantGroup = before!.groupId;
    const key = await insertApiKey(t, db, id);
    const directory = t.app.get(ApiKeyDirectory);
    await db.transaction((tx) => directory.revokeLiveKeysOf(tx, id));
    const retail = await makeAccount(t, { rank: 'retail' });
    await db.update(s.clients).set({ groupId: retail.groupId }).where(eq(s.clients.id, id));
    await directory.invalidateClient(id);
    expect(refusal(await useKey(key.key))).toBe('Authentication Failed');
    await db.update(s.clients).set({ groupId: merchantGroup }).where(eq(s.clients.id, id));
    await directory.invalidateClient(id);
    expect(refusal(await useKey(key.key))).toBe('Authentication Failed');
    const [row] = await db.select().from(s.apiKeys).where(eq(s.apiKeys.id, key.id));
    expect(row?.revokedAt).not.toBeNull();
  });
});
