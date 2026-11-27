// Integration tests of the API keys staff create and edit for a merchant (feature 20, slice D): POST /admin/clients/:id/api-keys and
// PATCH /admin/api-keys/:id, on the real application. A created key is used on the Dhru endpoint to prove it works and that a change
// applies on the next call.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { desc, eq } from 'drizzle-orm';
import { TokenService } from '@src/infra/crypto';
import { type Database, schema as s } from '@src/infra/db';
import { SECURITY_NOTICE_PHRASES } from '@src/modules/identity/application/mail/merchant-lifecycle-mails';
import { type TestApp, createTestApp } from '../../support/app';
import { adminWith } from '../../support/admin-api';
import { clearIdentityCaches, insertMerchant } from '../../support/auth';
import { DAY, TestClock } from '../../support/clock';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { seedIdentityTemplates } from '../../support/identity-mail';
import { insertApiKey } from '../../support/machine-auth';
import { clearApiKeyCaches } from '../../support/machine-orders';
import { mailbox, notificationRows, sendAllQueued } from '../../support/notifications';
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
  await clearApiKeyCaches(t);
  await seedIdentityTemplates(db);
  mailbox(t).reset();
});

const BODY = { name: 'Production server' };

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

// Creating a key from the console is kept for Owners (decision 046): the default member is one; pass a list for another role.
const staff = (permissions: string[] = ['*']) => adminWith(t, permissions, { name: 'Rami K.' });
const keyRows = () => db.select().from(s.apiKeys).orderBy(s.apiKeys.id);

describe('POST /admin/clients/:id/api-keys', () => {
  it('creates a key shown once with no-store, authenticates a Dhru call, and is marked as made by staff', async () => {
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
      allowedIps: ['203.0.113.55', '198.51.100.0/24'],
      rateLimitPerMin: 120,
      revokedAt: null,
      createdByStaff: true,
    });
    expect(JSON.stringify(key)).not.toContain(secret);
    expect(key).not.toHaveProperty('scopes');

    // Only the hash and the prefix are stored, and the row says which staff member made it.
    const [row] = await keyRows();
    expect(row).toMatchObject({ createdBy: api.staffId, keyHash: t.app.get(TokenService).hash(secret) });
    expect(JSON.stringify(row)).not.toContain(secret);

    expect(works(await useKey(secret, '203.0.113.55'))).toBe(true);
    expect(refusal(await useKey(secret, '192.0.2.77'))).toContain('allowed for this API key');
  });

  it('defaults the limit to 60 and honours the limit it was given on the next calls', async () => {
    const api = await staff();
    const clientId = await insertMerchant(db);
    const def = await api.post(`/admin/clients/${clientId}/api-keys`, { ...BODY, name: 'Default' });
    expect(def.body.key.rateLimitPerMin).toBe(60);
    const low = await api.post(`/admin/clients/${clientId}/api-keys`, { ...BODY, name: 'Low', rateLimitPerMin: 2 });
    expect(works(await useKey(low.body.secret))).toBe(true);
    expect(works(await useKey(low.body.secret))).toBe(true);
    expect(refusal(await useKey(low.body.secret))).toContain('Too many requests');
  });

  it('shows createdByStaff in the admin list and in the merchant portal, and false for a key the merchant made before decision 067', async () => {
    const api = await staff();
    const clientId = await insertMerchant(db);
    await api.post(`/admin/clients/${clientId}/api-keys`, BODY);
    const portal: PortalClient = await portalFor(t, clientId);
    // A key a merchant made itself, before merchants stopped making keys: `created_by` is null.
    await insertApiKey(t, db, clientId, { name: 'Mine', createdBy: null });

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

  it('audits the creation under the account without the key, and mails each merchant one security notice', async () => {
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
      entityType: 'account',
      entityId: english,
      entityLabel: 'Zain Mobile Hub',
    });
    expect(audits[0]!.after).toMatchObject({
      name: 'Production server',
      prefix: first.body.key.prefix,
      rateLimitPerMin: 60,
    });
    expect(JSON.stringify(audits)).not.toContain(first.body.secret);
    expect(JSON.stringify(audits)).not.toContain('keyHash');
    expect(audits[0]!.after).not.toHaveProperty('scopes');

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
    // The notice of a key staff made names the support team, in the one fixed sentence.
    expect(mails.find((mail) => mail.text.startsWith('Hi Zain Mobile Hub,'))!.text).toBe(
      'Hi Zain Mobile Hub,\n\nOur support team made this change to your account: a new API key was created for your account.\n\n' +
        'If you did not ask for it, reply to this email or contact our support team at once.',
    );
  });

  it('refuses a suspended or a blocked merchant with 409 NOT_ACTIVE and an unknown one with 404, writing nothing', async () => {
    const api = await staff();
    for (const status of ['suspended', 'blocked'] as const) {
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

  it('answers 422 on the field for a bad address, past expiry, limit and name, and writes nothing', async () => {
    const api = await staff();
    const clientId = await insertMerchant(db);
    const fields = async (patch: Record<string, unknown>): Promise<string[]> => {
      const res = await api.post(`/admin/clients/${clientId}/api-keys`, { ...BODY, ...patch });
      expect(res.status).toBe(422);
      return res.body.errors.map((error: { field: string }) => error.field);
    };
    expect(await fields({ allowedIps: ['203.0.113.55', 'nope', '10.0.0.1/8'] })).toEqual([
      'allowedIps.1',
      'allowedIps.2',
    ]);
    expect(await fields({ expiresAt: new Date(clock.nowMs() - 1000).toISOString() })).toEqual(['expiresAt']);
    expect(await fields({ rateLimitPerMin: 0 })).toEqual(['rateLimitPerMin']);
    expect(await fields({ rateLimitPerMin: 6001 })).toEqual(['rateLimitPerMin']);
    expect(await fields({ rateLimitPerMin: 1.5 })).toEqual(['rateLimitPerMin']);
    expect(await fields({ name: '   ' })).toEqual(['name']);
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

  it('refuses the eleventh live key with 422 on name, and two staff creations in parallel at nine keys make exactly one more', async () => {
    const api = await staff();
    const clientId = await insertMerchant(db);
    for (let index = 0; index < 9; index++) await insertApiKey(t, db, clientId, { name: `K${index}` });
    const answers = await Promise.all([
      api.post(`/admin/clients/${clientId}/api-keys`, { ...BODY, name: 'First' }),
      api.post(`/admin/clients/${clientId}/api-keys`, { ...BODY, name: 'Second' }),
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
});

describe('PATCH /admin/api-keys/:id', () => {
  it('changes the limit and the allowed addresses, applies them on the next call and audits before and after', async () => {
    const api = await staff();
    const clientId = await insertMerchant(db, { name: 'Zain Mobile Hub' });
    const key = await insertApiKey(t, db, clientId, { name: 'Production', rateLimitPerMin: 60 });
    expect(works(await useKey(key.key, '198.51.100.9'))).toBe(true);

    const res = await api.patch(`/admin/api-keys/${key.id}`, { rateLimitPerMin: 2, allowedIps: ['203.0.113.55'] });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: key.id,
      rateLimitPerMin: 2,
      allowedIps: ['203.0.113.55'],
      createdByStaff: false,
    });
    // The cached view was dropped: the new addresses and the new limit apply at once.
    expect(refusal(await useKey(key.key, '198.51.100.9'))).toContain('allowed for this API key');
    // The refused call cost nothing; the call before the change used one of the new limit of 2 in this minute, so one more fits.
    expect(works(await useKey(key.key, '203.0.113.55'))).toBe(true);
    expect(refusal(await useKey(key.key, '203.0.113.55'))).toContain('Too many requests');

    const [audit] = await db.select().from(s.auditLogs);
    expect(audit).toMatchObject({
      actorType: 'staff',
      actorId: api.staffId,
      action: 'changed limits of API key of',
      entityType: 'account',
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
    expect(works(await useKey(key.key, '192.0.2.5'))).toBe(true);
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

describe('PATCH /admin/api-keys/:id: who may widen a key, and the merchant is told', () => {
  const WIDEN_DETAIL = 'Only an owner can widen an API key: more addresses, a higher limit, or a later or no end date.';
  const SERVER = '198.51.100.7/32';
  const OTHER = '203.0.113.9';
  const NOTICE = 'merchant.security_notice';
  // A member who may change keys but is not an Owner.
  const deputy = () => staff(['api_keys:read', 'api_keys:update']);
  const keyRow = async (id: number) => (await db.select().from(s.apiKeys).where(eq(s.apiKeys.id, id)))[0]!;

  it('refuses a non-Owner every change that opens the key more, and writes, mails and audits nothing', async () => {
    const clientId = await insertMerchant(db);
    const key = await insertApiKey(t, db, clientId, { allowedIps: [SERVER], rateLimitPerMin: 60 });
    const member = await deputy();
    const widenings: Record<string, unknown>[] = [
      { allowedIps: [] },
      { allowedIps: [SERVER, OTHER] },
      { allowedIps: [OTHER] },
      { rateLimitPerMin: 61 },
      { rateLimitPerMin: 6000, allowedIps: [SERVER] },
      // A narrower value in one field does not pay for a wider one in the other.
      { rateLimitPerMin: 1, allowedIps: [] },
    ];
    for (const body of widenings) {
      const refused = await member.patch(`/admin/api-keys/${key.id}`, body);
      expect(refused.status, JSON.stringify(body)).toBe(403);
      expect(refused.body.code).toBe('FORBIDDEN');
      expect(refused.body.detail).toBe(WIDEN_DETAIL);
    }
    expect(await keyRow(key.id)).toMatchObject({ allowedIps: [SERVER], rateLimitPerMin: 60 });
    expect(refusal(await useKey(key.key, OTHER))).toContain('allowed for this API key');
    expect(await db.select().from(s.auditLogs)).toEqual([]);
    expect(await notificationRows(db)).toEqual([]);
    expect(await db.select().from(s.outboxEvents)).toEqual([]);
  });

  it('on a key without a restriction, refuses a non-Owner a higher limit but lets them keep it open or restrict it', async () => {
    const clientId = await insertMerchant(db);
    const key = await insertApiKey(t, db, clientId, { allowedIps: [], rateLimitPerMin: 60 });
    const member = await deputy();
    expect((await member.patch(`/admin/api-keys/${key.id}`, { rateLimitPerMin: 6000 })).status).toBe(403);
    // Keeping the key open is not a widening, and restricting it is a narrowing.
    expect((await member.patch(`/admin/api-keys/${key.id}`, { allowedIps: [] })).status).toBe(200);
    expect((await member.patch(`/admin/api-keys/${key.id}`, { allowedIps: [SERVER] })).status).toBe(200);
    expect(await keyRow(key.id)).toMatchObject({ allowedIps: [SERVER], rateLimitPerMin: 60 });
  });

  it('lets a non-Owner narrow a key: fewer addresses, a first restriction, a lower limit', async () => {
    const clientId = await insertMerchant(db);
    const key = await insertApiKey(t, db, clientId, { allowedIps: [SERVER, `${OTHER}/32`], rateLimitPerMin: 60 });
    const member = await deputy();
    const fewer = await member.patch(`/admin/api-keys/${key.id}`, { allowedIps: [SERVER] });
    expect(fewer.status).toBe(200);
    expect(fewer.body).toMatchObject({ allowedIps: ['198.51.100.7'], rateLimitPerMin: 60 });
    const lower = await member.patch(`/admin/api-keys/${key.id}`, { rateLimitPerMin: 10 });
    expect(lower.status).toBe(200);
    expect(lower.body).toMatchObject({ rateLimitPerMin: 10 });
    const both = await member.patch(`/admin/api-keys/${key.id}`, { rateLimitPerMin: 5, allowedIps: [SERVER] });
    expect(both.status).toBe(200);
    const open = await insertApiKey(t, db, clientId, { allowedIps: [], rateLimitPerMin: 60 });
    expect((await member.patch(`/admin/api-keys/${open.id}`, { allowedIps: [SERVER] })).status).toBe(200);
    expect(refusal(await useKey(open.key, OTHER))).toContain('allowed for this API key');
  });

  it('lets an Owner widen a key', async () => {
    const clientId = await insertMerchant(db);
    const key = await insertApiKey(t, db, clientId, { allowedIps: [SERVER], rateLimitPerMin: 60 });
    expect(refusal(await useKey(key.key, OTHER))).toContain('allowed for this API key');
    const owner = await staff();
    const res = await owner.patch(`/admin/api-keys/${key.id}`, { allowedIps: [], rateLimitPerMin: 6000 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ allowedIps: [], rateLimitPerMin: 6000 });
    expect(works(await useKey(key.key, OTHER))).toBe(true);
  });

  it('mails the merchant one security notice for each change, whoever made it, and only that merchant', async () => {
    const clientId = await insertMerchant(db, { name: 'Zain Mobile Hub' });
    await insertMerchant(db, { name: 'Cedar Phones' });
    const key = await insertApiKey(t, db, clientId, { allowedIps: [SERVER, `${OTHER}/32`], rateLimitPerMin: 60 });
    const [merchant] = await db.select().from(s.clients).where(eq(s.clients.id, clientId));
    const member = await deputy();
    const owner = await staff();
    expect((await member.patch(`/admin/api-keys/${key.id}`, { rateLimitPerMin: 30 })).status).toBe(200);
    expect((await owner.patch(`/admin/api-keys/${key.id}`, { allowedIps: [] })).status).toBe(200);
    // A refused change sends nothing.
    expect((await member.patch(`/admin/api-keys/${key.id}`, { rateLimitPerMin: 6000 })).status).toBe(403);

    expect((await notificationRows(db)).map((row) => [row.event, row.recipientId])).toEqual([
      [NOTICE, clientId],
      [NOTICE, clientId],
    ]);
    await sendAllQueued(t);
    const mails = mailbox(t).sent;
    expect(mails).toHaveLength(2);
    for (const mail of mails) {
      expect(mail.subject).toBe('A security change on your merchant account');
      expect(mail.text).toContain(SECURITY_NOTICE_PHRASES.api_key_changed);
      expect(mail.text.startsWith('Hi Zain Mobile Hub,')).toBe(true);
      expect(mail.text).not.toContain(key.key);
    }
    expect(mails.map((mail) => mail.to)).toEqual([merchant!.email, merchant!.email]);
    expect(await db.select().from(s.auditLogs)).toHaveLength(2);
  });

  it('mails nothing when the sent values are the stored ones', async () => {
    const clientId = await insertMerchant(db);
    const key = await insertApiKey(t, db, clientId, { allowedIps: [SERVER, `${OTHER}/32`], rateLimitPerMin: 60 });
    const member = await deputy();
    expect((await member.patch(`/admin/api-keys/${key.id}`, { rateLimitPerMin: 60 })).status).toBe(200);
    expect((await member.patch(`/admin/api-keys/${key.id}`, { allowedIps: [OTHER, '198.51.100.7'] })).status).toBe(200);
    expect(await notificationRows(db)).toEqual([]);
  });
});

describe('expiry and the clock', () => {
  it('a staff-made key with an expiry stops working at it', async () => {
    const api = await staff();
    const clientId = await insertMerchant(db);
    const expiresAt = new Date(clock.nowMs() + DAY).toISOString();
    const { body } = await api.post(`/admin/clients/${clientId}/api-keys`, { ...BODY, expiresAt });
    expect(body.key.expiresAt).toBe(expiresAt);
    expect(works(await useKey(body.secret))).toBe(true);
    clock.advance(2 * DAY);
    expect(refusal(await useKey(body.secret))).toBe('Authentication Failed');
    expect((await db.select().from(s.apiKeys).orderBy(desc(s.apiKeys.id)))[0]!.expiresAt?.toISOString()).toBe(
      expiresAt,
    );
  });
});

describe('POST /admin/clients/:id/api-keys: a key without a name (decision 078)', () => {
  const create = (api: Awaited<ReturnType<typeof staff>>, clientId: number, body: Record<string, unknown> = {}) =>
    api.post(`/admin/clients/${clientId}/api-keys`, body);

  it('names the key API key 1, then API key 2, and the answer, the list and the audit row carry the made name', async () => {
    const api = await staff();
    const clientId = await insertMerchant(db, { name: 'Zain Mobile Hub' });
    const first = await create(api, clientId);
    const second = await create(api, clientId, {});
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(first.body.key.name).toBe('API key 1');
    expect(second.body.key.name).toBe('API key 2');
    expect(first.body.secret).not.toBe(second.body.secret);
    const listed = (await api.get(`/admin/clients/${clientId}/api-keys`)).body as { name: string }[];
    expect(listed.map((row) => row.name)).toEqual(['API key 2', 'API key 1']);
    const audits = await db.select().from(s.auditLogs).orderBy(s.auditLogs.id);
    expect(audits.map((audit) => (audit.after as { name: string }).name)).toEqual(['API key 1', 'API key 2']);
  });

  it('takes the smallest number nobody holds: revoked and expired keys keep theirs, and only the exact form counts', async () => {
    const api = await staff();
    const clientId = await insertMerchant(db);
    await insertApiKey(t, db, clientId, { name: 'API key 1', revokedAt: clock.now() });
    await insertApiKey(t, db, clientId, { name: 'API key 2', expiresAt: new Date(clock.nowMs() - DAY) });
    await insertApiKey(t, db, clientId, { name: 'API key 4' });
    // Names that only look alike hold no number.
    for (const name of ['API key 01', 'api key 3', 'API key 3 ', 'API key 3b', 'API key', 'API key -3', 'Production']) {
      await insertApiKey(t, db, clientId, { name });
    }
    expect((await create(api, clientId)).body.key.name).toBe('API key 3');
    expect((await create(api, clientId)).body.key.name).toBe('API key 5');
  });

  it('counts a name that was typed in that exact form, and numbers every account on its own', async () => {
    const api = await staff();
    const one = await insertMerchant(db, { name: 'Zain Mobile Hub' });
    const other = await insertMerchant(db, { name: 'Cedar Phones' });
    expect((await create(api, one, { name: 'API key 2' })).body.key.name).toBe('API key 2');
    expect((await create(api, one)).body.key.name).toBe('API key 1');
    expect((await create(api, one)).body.key.name).toBe('API key 3');
    // The other account holds none of them.
    expect((await create(api, other)).body.key.name).toBe('API key 1');
  });

  it('gives two creations at the same moment two different numbers', async () => {
    const api = await staff();
    const clientId = await insertMerchant(db);
    const answers = await Promise.all([create(api, clientId), create(api, clientId), create(api, clientId)]);
    expect(answers.map((answer) => answer.status)).toEqual([201, 201, 201]);
    expect(answers.map((answer) => answer.body.key.name).sort()).toEqual(['API key 1', 'API key 2', 'API key 3']);
    expect((await keyRows()).map((row) => row.name).sort()).toEqual(['API key 1', 'API key 2', 'API key 3']);
  });

  it('uses a name that is sent as typed (trimmed) and still refuses a blank one, a null one and one of 61 characters', async () => {
    const api = await staff();
    const clientId = await insertMerchant(db);
    expect((await create(api, clientId, { name: '  Production  ' })).body.key.name).toBe('Production');
    for (const name of ['   ', '', null, 'x'.repeat(61), 7]) {
      const res = await create(api, clientId, { name });
      expect(res.status, JSON.stringify(name)).toBe(422);
      expect(res.body.errors.map((error: { field: string }) => error.field)).toEqual(['name']);
    }
    expect(await keyRows()).toHaveLength(1);
    expect((await create(api, clientId, { name: 'x'.repeat(60) })).status).toBe(201);
  });

  it('keeps the rules of the creation: the eleventh live key is refused and nothing is stored, with or without a name', async () => {
    const api = await staff();
    const clientId = await insertMerchant(db);
    for (let index = 0; index < 10; index++) await insertApiKey(t, db, clientId, { name: `K${index}` });
    const refused = await create(api, clientId);
    expect(refused.status).toBe(422);
    expect(refused.body.errors).toEqual([
      { field: 'name', code: 'invalid', message: 'This merchant already has 10 active keys; revoke one first.' },
    ]);
    expect(await keyRows()).toHaveLength(10);
    const deputy = await staff(['api_keys:create', 'api_keys:read']);
    expect((await create(deputy, clientId)).status).toBe(403);
  });
});

describe('PATCH /admin/api-keys/:id: the name and the expiry (decision 078)', () => {
  const MINUTE = 60_000;
  const WIDEN_DETAIL = 'Only an owner can widen an API key: more addresses, a higher limit, or a later or no end date.';
  const NOTICE = 'merchant.security_notice';
  // A member who may change keys but is not an Owner.
  const deputy = () => staff(['api_keys:read', 'api_keys:update']);
  const keyRow = async (id: number) => (await db.select().from(s.apiKeys).where(eq(s.apiKeys.id, id)))[0]!;
  const at = (offsetMs: number) => new Date(clock.nowMs() + offsetMs).toISOString();

  it('renames a key for any staff member who may update, applies it at once, audits before and after, and mails nothing', async () => {
    const clientId = await insertMerchant(db, { name: 'Zain Mobile Hub' });
    const key = await insertApiKey(t, db, clientId, { name: 'API key 1' });
    const member = await deputy();
    expect(works(await useKey(key.key))).toBe(true);
    const res = await member.patch(`/admin/api-keys/${key.id}`, { name: '  Production server  ' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: key.id, name: 'Production server', rateLimitPerMin: 60, allowedIps: [] });
    expect(await keyRow(key.id)).toMatchObject({ name: 'Production server' });
    expect(works(await useKey(key.key))).toBe(true);

    const [audit] = await db.select().from(s.auditLogs);
    expect(audit).toMatchObject({
      actorId: member.staffId,
      action: 'changed limits of API key of',
      entityType: 'account',
      entityId: clientId,
      entityLabel: 'Zain Mobile Hub',
    });
    expect(audit!.before).toMatchObject({ keyId: key.id, name: 'API key 1', expiresAt: null });
    expect(audit!.after).toMatchObject({ keyId: key.id, name: 'Production server', expiresAt: null });
    expect(JSON.stringify(audit)).not.toContain(key.key);
    expect(JSON.stringify(audit)).not.toContain(key.keyHash);
    // A name is no change of reach: no security notice.
    expect(await notificationRows(db)).toEqual([]);
  });

  it('refuses a blank, a null and an over-long name on the field and writes nothing', async () => {
    const clientId = await insertMerchant(db);
    const key = await insertApiKey(t, db, clientId, { name: 'Keep me' });
    const member = await deputy();
    for (const name of ['   ', '', null, 'x'.repeat(61), 5]) {
      const res = await member.patch(`/admin/api-keys/${key.id}`, { name });
      expect(res.status, JSON.stringify(name)).toBe(422);
      expect(res.body.errors.map((error: { field: string }) => error.field)).toEqual(['name']);
    }
    expect((await member.patch(`/admin/api-keys/${key.id}`, { name: 'x'.repeat(60) })).status).toBe(200);
    expect(await db.select().from(s.auditLogs)).toHaveLength(1);
  });

  it('lets an Owner set, move and remove an expiry, which the key obeys on its next call, and audits it', async () => {
    const owner = await staff();
    const clientId = await insertMerchant(db);
    const key = await insertApiKey(t, db, clientId, {});
    const first = at(5 * MINUTE);
    const set = await owner.patch(`/admin/api-keys/${key.id}`, { expiresAt: first });
    expect(set.status).toBe(200);
    expect(set.body.expiresAt).toBe(first);
    expect(works(await useKey(key.key))).toBe(true);
    // Ten minutes later the expiry has passed (the staff session is still open).
    clock.advance(10 * MINUTE);
    expect(refusal(await useKey(key.key))).toBe('Authentication Failed');

    // Later again (an expired key may be given a later expiry, see below) and then none at all.
    const later = at(20 * MINUTE);
    const moved = await owner.patch(`/admin/api-keys/${key.id}`, { expiresAt: later });
    expect(moved.body, JSON.stringify(moved.body)).toMatchObject({ expiresAt: later });
    expect(works(await useKey(key.key))).toBe(true);
    const none = await owner.patch(`/admin/api-keys/${key.id}`, { expiresAt: null });
    expect(none.status).toBe(200);
    expect(none.body.expiresAt).toBeNull();
    expect((await keyRow(key.id)).expiresAt).toBeNull();
    clock.advance(60 * DAY);
    expect(works(await useKey(key.key))).toBe(true);

    const audits = await db.select().from(s.auditLogs).orderBy(s.auditLogs.id);
    expect(
      audits.map((audit) => [
        (audit.before as { expiresAt: string | null }).expiresAt,
        (audit.after as { expiresAt: string | null }).expiresAt,
      ]),
    ).toEqual([
      [null, first],
      [first, later],
      [later, null],
    ]);
  });

  it('lets a non-Owner set a first expiry and move it earlier, mailing the merchant each time', async () => {
    const clientId = await insertMerchant(db);
    const key = await insertApiKey(t, db, clientId, {});
    const member = await deputy();
    expect((await member.patch(`/admin/api-keys/${key.id}`, { expiresAt: at(10 * DAY) })).status).toBe(200);
    const earlier = at(2 * DAY);
    const res = await member.patch(`/admin/api-keys/${key.id}`, { expiresAt: earlier });
    expect(res.status).toBe(200);
    expect(res.body.expiresAt).toBe(earlier);
    expect((await notificationRows(db)).map((row) => [row.event, row.recipientId])).toEqual([
      [NOTICE, clientId],
      [NOTICE, clientId],
    ]);
    // The same expiry again changes nothing: no mail.
    expect((await member.patch(`/admin/api-keys/${key.id}`, { expiresAt: earlier })).status).toBe(200);
    expect(await notificationRows(db)).toHaveLength(2);
  });

  it('refuses a non-Owner a later expiry and the removal of an expiry, and writes, mails and audits nothing', async () => {
    const clientId = await insertMerchant(db);
    const stored = new Date(clock.nowMs() + 3 * DAY);
    const key = await insertApiKey(t, db, clientId, { expiresAt: stored });
    const member = await deputy();
    for (const body of [{ expiresAt: at(4 * DAY) }, { expiresAt: null }, { expiresAt: at(4 * DAY), name: 'Renamed' }]) {
      const refused = await member.patch(`/admin/api-keys/${key.id}`, body);
      expect(refused.status, JSON.stringify(body)).toBe(403);
      expect(refused.body.code).toBe('FORBIDDEN');
      expect(refused.body.detail).toBe(WIDEN_DETAIL);
    }
    expect(await keyRow(key.id)).toMatchObject({ expiresAt: stored, name: 'Test key' });
    expect(await db.select().from(s.auditLogs)).toEqual([]);
    expect(await notificationRows(db)).toEqual([]);
    expect(await db.select().from(s.outboxEvents)).toEqual([]);
  });

  it('judges the whole change: a narrower expiry does not pay for a wider list', async () => {
    const clientId = await insertMerchant(db);
    const key = await insertApiKey(t, db, clientId, {
      allowedIps: ['198.51.100.7/32'],
      expiresAt: new Date(clock.nowMs() + 3 * DAY),
    });
    const member = await deputy();
    const refused = await member.patch(`/admin/api-keys/${key.id}`, { expiresAt: at(DAY), allowedIps: [] });
    expect(refused.status).toBe(403);
    const fine = await member.patch(`/admin/api-keys/${key.id}`, { expiresAt: at(DAY), rateLimitPerMin: 30 });
    expect(fine.status).toBe(200);
    expect(fine.body).toMatchObject({ rateLimitPerMin: 30, allowedIps: ['198.51.100.7'] });
  });

  it('refuses an expiry that is not in the future or not a time, on the field, and saves nothing', async () => {
    const owner = await staff();
    const clientId = await insertMerchant(db);
    const key = await insertApiKey(t, db, clientId, {});
    const fieldsOf = async (body: Record<string, unknown>) => {
      const res = await owner.patch(`/admin/api-keys/${key.id}`, body);
      expect(res.status, JSON.stringify(body)).toBe(422);
      return res.body.errors.map((error: { field: string; code: string }) => `${error.field}:${error.code}`);
    };
    expect(await fieldsOf({ expiresAt: at(-1000) })).toEqual(['expiresAt:in_the_past']);
    expect(await fieldsOf({ expiresAt: at(0) })).toEqual(['expiresAt:in_the_past']);
    // Both problems come back together.
    expect(await fieldsOf({ expiresAt: at(-1000), allowedIps: ['nope'] })).toEqual([
      'allowedIps.0:invalid_ip',
      'expiresAt:in_the_past',
    ]);
    expect((await fieldsOf({ expiresAt: 'tomorrow' })).join()).toContain('expiresAt');
    expect((await fieldsOf({ expiresAt: 12345 })).join()).toContain('expiresAt');
    expect((await fieldsOf({ expiresAt: '2030-01-01' })).join()).toContain('expiresAt');
    expect((await keyRow(key.id)).expiresAt).toBeNull();
    expect(await db.select().from(s.auditLogs)).toEqual([]);
    // An empty body is still refused, and a body of only null is a body.
    expect((await owner.patch(`/admin/api-keys/${key.id}`, {})).status).toBe(422);
    expect((await owner.patch(`/admin/api-keys/${key.id}`, { expiresAt: null })).status).toBe(200);
  });

  it('lets an expired key be renamed by any staff member, and an Owner give it a later expiry: it works again', async () => {
    const clientId = await insertMerchant(db);
    const expired = new Date(clock.nowMs() - DAY);
    const key = await insertApiKey(t, db, clientId, { expiresAt: expired });
    expect(refusal(await useKey(key.key))).toBe('Authentication Failed');
    const member = await deputy();
    const renamed = await member.patch(`/admin/api-keys/${key.id}`, { name: 'Old server' });
    expect(renamed.status).toBe(200);
    expect(renamed.body).toMatchObject({ name: 'Old server', expiresAt: expired.toISOString() });
    expect(refusal(await useKey(key.key))).toBe('Authentication Failed');
    // Bringing it back is a widening: only an Owner.
    const refused = await member.patch(`/admin/api-keys/${key.id}`, { expiresAt: at(DAY) });
    expect(refused.status).toBe(403);
    expect(refusal(await useKey(key.key))).toBe('Authentication Failed');

    const owner = await staff();
    const revived = at(7 * DAY);
    expect((await owner.patch(`/admin/api-keys/${key.id}`, { expiresAt: revived })).body.expiresAt).toBe(revived);
    expect(works(await useKey(key.key))).toBe(true);
    clock.advance(8 * DAY);
    expect(refusal(await useKey(key.key))).toBe('Authentication Failed');
  });

  it('refuses to bring an expired key back while the account already holds 10 live keys', async () => {
    const owner = await staff();
    const clientId = await insertMerchant(db);
    const expired = await insertApiKey(t, db, clientId, { name: 'Expired', expiresAt: new Date(clock.nowMs() - DAY) });
    for (let index = 0; index < 10; index++) await insertApiKey(t, db, clientId, { name: `K${index}` });
    const refused = await owner.patch(`/admin/api-keys/${expired.id}`, { expiresAt: at(DAY) });
    expect(refused.status).toBe(422);
    expect(refused.body.errors).toEqual([
      { field: 'expiresAt', code: 'invalid', message: 'This merchant already has 10 active keys; revoke one first.' },
    ]);
    expect(refusal(await useKey(expired.key))).toBe('Authentication Failed');
    // A rename, or a change that leaves it expired, is not a revival.
    expect((await owner.patch(`/admin/api-keys/${expired.id}`, { name: 'Still expired' })).status).toBe(200);
    // With a slot free again it comes back.
    const [live] = await db.select().from(s.apiKeys).where(eq(s.apiKeys.name, 'K0'));
    expect((await owner.delete(`/admin/api-keys/${live!.id}`)).status).toBe(204);
    expect((await owner.patch(`/admin/api-keys/${expired.id}`, { expiresAt: at(DAY) })).status).toBe(200);
    expect(works(await useKey(expired.key))).toBe(true);
  });

  it('keeps a revoked key revoked: every new field answers 409 ALREADY_REVOKED and nothing changes', async () => {
    const owner = await staff();
    const clientId = await insertMerchant(db);
    const key = await insertApiKey(t, db, clientId, { name: 'Revoked one', revokedAt: clock.now() });
    for (const body of [{ name: 'Back' }, { expiresAt: at(DAY) }, { expiresAt: null }]) {
      const res = await owner.patch(`/admin/api-keys/${key.id}`, body);
      expect(res.status, JSON.stringify(body)).toBe(409);
      expect(res.body.code).toBe('ALREADY_REVOKED');
    }
    expect(await keyRow(key.id)).toMatchObject({ name: 'Revoked one', expiresAt: null });
    expect(await db.select().from(s.auditLogs)).toEqual([]);
    expect(refusal(await useKey(key.key))).toBe('Authentication Failed');
  });

  it('keeps the permission and the session rules: api_keys:update is needed, a signed-out call is 401, an unknown key is 404', async () => {
    const clientId = await insertMerchant(db);
    const key = await insertApiKey(t, db, clientId, {});
    const creator = await adminWith(t, ['api_keys:create', 'api_keys:read']);
    const denied = await creator.patch(`/admin/api-keys/${key.id}`, { name: 'No' });
    expect(denied.status).toBe(403);
    expect(denied.body.detail).toContain('api_keys:update');
    expect((await creator.anonymous('PATCH', `/admin/api-keys/${key.id}`, { name: 'No' })).status).toBe(401);
    const owner = await staff();
    expect((await owner.patch('/admin/api-keys/999999', { name: 'Nobody' })).status).toBe(404);
    expect((await owner.patch('/admin/api-keys/999999', { expiresAt: null })).status).toBe(404);
    expect(await keyRow(key.id)).toMatchObject({ name: 'Test key' });
  });
});
