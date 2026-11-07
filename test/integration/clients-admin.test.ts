// Integration tests of the merchant management routes (feature 2a): list, show, invite a merchant (ledger accounts, invite token,
// outbox event, credit rule), approve, suspend, reactivate and move to another group, through HTTP on the real application.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import { schema as s } from '../../src/infra/db';
import { ApiKeyDirectory, MERCHANT_INVITED_EVENT } from '../../src/modules/identity';
import { MERCHANT_INVITE_TTL_MS } from '../../src/modules/identity/application/merchant-invites';
import { MerchantAccounts } from '../../src/modules/money';
import { type AdminApi, adminWith } from '../support/admin-api';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches, insertMerchant, openSession } from '../support/auth';
import { HOUR, MINUTE, TestClock } from '../support/clock';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { insertUsd } from '../support/fixtures';
import { insertApiKey } from '../support/machine-auth';

const clock = new TestClock();
let t: TestApp;
const CALLER_IP = '203.0.113.50';

beforeAll(async () => {
  t = await createTestApp({ clock });
});
beforeEach(async () => {
  clock.reset();
  await resetDb();
  await clearIdentityCaches(t);
});
afterAll(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await t.close();
  await closeTestDb();
});

const ids = (body: Array<{ id: number }>) => body.map((row) => row.id);
const auditRows = async () => (await testDb()).db.select().from(s.auditLogs).orderBy(s.auditLogs.id);
const clientRows = async () => (await testDb()).db.select().from(s.clients).orderBy(s.clients.id);
const clientRow = async (id: number) => (await clientRows()).find((row) => row.id === id)!;
const ledgerRowsOf = async (clientId: number) => {
  const { db } = await testDb();
  return db
    .select()
    .from(s.ledgerAccounts)
    .where(and(eq(s.ledgerAccounts.ownerType, 'client'), eq(s.ledgerAccounts.ownerId, clientId)))
    .orderBy(s.ledgerAccounts.kind);
};
const tokensOf = async (clientId: number) => {
  const { db } = await testDb();
  return db
    .select()
    .from(s.authTokens)
    .where(and(eq(s.authTokens.subjectType, 'client'), eq(s.authTokens.subjectId, clientId)));
};
const outboxRows = async () => (await testDb()).db.select().from(s.outboxEvents).orderBy(s.outboxEvents.id);

/** The demo's three kinds of group: a default one without credit, one with credit, and the storefront's retail group. */
async function groups() {
  const { db } = await testDb();
  await insertUsd(db);
  const [standard, vip, retail] = await db
    .insert(s.clientGroups)
    .values([
      { name: 'Standard', isDefault: true, discountPercent: '0' },
      { name: 'VIP', discountPercent: '8', overdraftAllowed: true },
      { name: 'Retail', kind: 'b2c_retail' },
    ])
    .returning({ id: s.clientGroups.id });
  return { standard: standard!.id, vip: vip!.id, retail: retail!.id };
}

/** An Owner (holds `*`, so `wallet:read` too) who calls from {@link CALLER_IP}. */
const owner = () => adminWith(t, ['*'], { name: 'Rami K.', ip: CALLER_IP });

const invite = (api: AdminApi, body: Record<string, unknown> = {}) =>
  api.post('/admin/clients', {
    name: 'Zain Mobile Hub',
    email: 'ops@zainmobilehub.example',
    country: 'JO',
    invite: true,
    ...body,
  });

describe('POST /admin/clients', () => {
  it('invites a merchant: pending, a generated username and referral code, the group, and the wallet the ledger opened', async () => {
    const { vip } = await groups();
    const rami = await owner();
    const res = await invite(rami, {
      name: '  Zain   Mobile Hub ',
      email: ' Ops@ZainMobileHub.example ',
      country: 'jo',
      groupId: vip,
      creditLimit: '2000.0000',
    });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      id: expect.any(Number),
      createdAt: clock.now().toISOString(),
      name: 'Zain Mobile Hub',
      email: 'ops@zainmobilehub.example',
      country: 'JO',
      username: 'zain-mobile-hub',
      company: '',
      phone: '',
      groupId: vip,
      referralCode: expect.stringMatching(/^GSM[A-HJ-NP-Z2-9]{6}$/),
      emailVerifiedAt: null,
      status: 'pending',
      kycStatus: 'none',
      group: { id: vip, name: 'VIP', discountPercent: '8.0000' },
      referredBy: null,
      wallet: { balance: '0.0000', reserved: '0.0000', creditLimit: '2000.0000', available: '2000.0000' },
      stats: { orders: 0, spend: '0.0000', profit: '0.0000', margin: null, successRate: null, lastOrderAt: null },
    });
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|totp|telegram|notificationPrefs/i);
    expect(await clientRows()).toHaveLength(1);
  });

  it('opens both ledger accounts in the same transaction, with overdraft_limit = creditLimit on the wallet and none on the hold', async () => {
    const { vip } = await groups();
    const rami = await owner();
    const res = await invite(rami, { groupId: vip, creditLimit: '2000.0000' });
    const [hold, wallet] = await ledgerRowsOf(res.body.id);
    expect(hold).toMatchObject({ kind: 'client_hold', currency: 'USD', balance: '0.0000', overdraftLimit: '0.0000' });
    expect(wallet).toMatchObject({
      kind: 'client_wallet',
      currency: 'USD',
      balance: '0.0000',
      overdraftLimit: '2000.0000',
    });
    // No credit asked: the limit is zero, and the accounts are still there.
    const plain = await invite(rami, { name: 'Plain Shop', email: 'plain@example.com' });
    const rows = await ledgerRowsOf(plain.body.id);
    expect(rows.map((row) => [row.kind, row.overdraftLimit])).toEqual([
      ['client_hold', '0.0000'],
      ['client_wallet', '0.0000'],
    ]);
    expect(plain.body.wallet).toEqual({
      balance: '0.0000',
      reserved: '0.0000',
      creditLimit: '0.0000',
      available: '0.0000',
    });
    expect(plain.body.groupId).not.toBe(vip);
  });

  it('uses the default group when none is given', async () => {
    const { standard } = await groups();
    const res = await invite(await owner());
    expect(res.status).toBe(201);
    expect(res.body.groupId).toBe(standard);
    expect(res.body.group).toEqual({ id: standard, name: 'Standard', discountPercent: '0.0000' });
  });

  it('issues a one-hour invite token (purpose invite, hash only) and writes the outbox event merchant.invited with ids only', async () => {
    await groups();
    const rami = await owner();
    const res = await invite(rami);
    const [token, ...others] = await tokensOf(res.body.id);
    expect(others).toHaveLength(0);
    expect(token).toMatchObject({
      purpose: 'invite',
      subjectType: 'client',
      subjectId: res.body.id,
      usedAt: null,
      createdBy: rami.staffId,
      ip: CALLER_IP,
      createdAt: clock.now(),
    });
    expect(token!.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(token!.expiresAt.getTime() - token!.createdAt.getTime()).toBe(MERCHANT_INVITE_TTL_MS);
    expect(token!.expiresAt).toEqual(new Date(clock.nowMs() + HOUR));

    const [event, ...more] = await outboxRows();
    expect(more).toHaveLength(0);
    expect(event).toMatchObject({ type: MERCHANT_INVITED_EVENT, aggregateType: 'clients', aggregateId: res.body.id });
    expect(event!.type).toBe('merchant.invited');
    // The merchant is the event's aggregate; the payload names only the link (MerchantMailOutbox, shared with 2b's mails).
    expect(event!.payload).toMatchObject({ tokenId: token!.id });
    // Ids only: the token and its hash never reach the queue, and nothing else about the merchant does either.
    const payload = JSON.stringify(event!.payload);
    expect(payload).not.toContain(token!.tokenHash);
    expect(payload).not.toContain('ops@zainmobilehub.example');
    expect(
      Object.keys(event!.payload as object)
        .filter((key) => key !== 'meta')
        .sort(),
    ).toEqual(['tokenId']);
  });

  it('audits the invitation without any secret', async () => {
    const { vip } = await groups();
    const rami = await owner();
    const res = await invite(rami, { groupId: vip, creditLimit: '500.0000' });
    const [audit] = await auditRows();
    expect(audit).toMatchObject({
      action: 'invited merchant',
      entityType: 'merchant',
      entityId: res.body.id,
      entityLabel: 'Zain Mobile Hub',
      actorId: rami.staffId,
      actorName: 'Rami K.',
      ip: CALLER_IP,
    });
    expect(audit!.after).toEqual({
      name: 'Zain Mobile Hub',
      email: 'ops@zainmobilehub.example',
      country: 'JO',
      groupId: vip,
      status: 'pending',
      creditLimit: '500.0000',
    });
    const [token] = await tokensOf(res.body.id);
    expect(JSON.stringify(audit)).not.toContain(token!.tokenHash);
  });

  it('gives merchants with the same name distinct Dhru usernames, also when they are invited at the same moment', async () => {
    await groups();
    const rami = await owner();
    const first = await invite(rami, { email: 'a@example.com' });
    const second = await invite(rami, { email: 'b@example.com' });
    expect([first.body.username, second.body.username]).toEqual(['zain-mobile-hub', 'zain-mobile-hub-2']);

    const answers = await Promise.all(
      ['c', 'd', 'e'].map((letter) => invite(rami, { email: `${letter}@example.com` })),
    );
    expect(answers.map((answer) => answer.status)).toEqual([201, 201, 201]);
    const usernames = (await clientRows()).map((row) => row.username);
    expect(new Set(usernames).size).toBe(5);
    expect(new Set((await clientRows()).map((row) => row.referralCode)).size).toBe(5);
  });

  it('refuses an email that a merchant already uses, in any case (409 EMAIL_TAKEN), and writes nothing', async () => {
    await groups();
    const rami = await owner();
    const { db } = await testDb();
    await insertMerchant(db, { email: 'taken@example.com' });
    const res = await invite(rami, { email: 'TAKEN@example.com' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('EMAIL_TAKEN');
    expect(await clientRows()).toHaveLength(1);
    expect(await auditRows()).toHaveLength(0);
    expect(await outboxRows()).toHaveLength(0);
    expect(await db.select().from(s.authTokens)).toHaveLength(0);
    expect(await db.select().from(s.ledgerAccounts)).toHaveLength(0);
  });

  it('refuses credit on a group that does not allow it (422 on creditLimit, rule 2), for the chosen and for the default group', async () => {
    const { standard } = await groups();
    const rami = await owner();
    for (const body of [{ creditLimit: '100.0000' }, { groupId: standard, creditLimit: '0.0001' }]) {
      const res = await invite(rami, body);
      expect(res.status).toBe(422);
      expect(res.body.errors).toEqual([
        expect.objectContaining({ field: 'creditLimit', message: 'This group does not allow credit.' }),
      ]);
    }
    // The whole invitation is rolled back: no merchant, no wallet, no token, no event, no audit row.
    const { db } = await testDb();
    expect(await clientRows()).toHaveLength(0);
    expect(await db.select().from(s.ledgerAccounts)).toHaveLength(0);
    expect(await db.select().from(s.authTokens)).toHaveLength(0);
    expect(await outboxRows()).toHaveLength(0);
    expect(await auditRows()).toHaveLength(0);
    // A zero limit is fine on any group.
    expect((await invite(rami, { creditLimit: '0.0000' })).status).toBe(201);
  });

  it('refuses a negative credit limit, an unknown or storefront group, and a missing default group (422 on creditLimit / groupId)', async () => {
    const { vip, retail } = await groups();
    const rami = await owner();
    const negative = await invite(rami, { groupId: vip, creditLimit: '-1.0000' });
    expect(negative.status).toBe(422);
    expect(negative.body.errors[0].field).toBe('creditLimit');
    expect((await invite(rami, { groupId: 999_999 })).body.errors[0].field).toBe('groupId');
    const storefront = await invite(rami, { groupId: retail });
    expect(storefront.status).toBe(422);
    expect(storefront.body.errors[0].field).toBe('groupId');
    expect(await clientRows()).toHaveLength(0);

    const { db } = await testDb();
    await db.update(s.clientGroups).set({ isDefault: false });
    const noDefault = await invite(rami);
    expect(noDefault.status).toBe(422);
    expect(noDefault.body.errors[0].field).toBe('groupId');
  });

  it('refuses bad input with the field names the console maps (name, email, country, creditLimit, invite)', async () => {
    await groups();
    const rami = await owner();
    const fields = async (body: Record<string, unknown>) => {
      const res = await invite(rami, body);
      expect(res.status).toBe(422);
      return res.body.errors.map((error: { field: string }) => error.field);
    };
    expect(await fields({ name: ' a ' })).toEqual(['name']);
    expect(await fields({ email: 'not-an-email' })).toEqual(['email']);
    expect(await fields({ country: 'JOR' })).toEqual(['country']);
    expect(await fields({ country: '1A' })).toEqual(['country']);
    expect(await fields({ creditLimit: '10' })).toEqual(['creditLimit']);
    expect(await fields({ invite: false })).toEqual(['invite']);
    expect((await rami.post('/admin/clients', {})).status).toBe(422);
    expect(await clientRows()).toHaveLength(0);
  });

  it('needs clients:create and a CSRF token, and sends the wallet and stats only to staff who hold wallet:read', async () => {
    await groups();
    const reader = await adminWith(t, ['clients:read'], { ip: CALLER_IP });
    const refused = await invite(reader);
    expect(refused.status).toBe(403);
    expect(refused.body.detail).toContain('clients:create');
    const rami = await owner();
    const noCsrf = await rami.withoutCsrf('POST', '/admin/clients', {
      name: 'No Csrf',
      email: 'x@example.com',
      country: 'JO',
      invite: true,
    });
    expect(noCsrf.body.code).toBe('CSRF_FAILED');

    const creator = await adminWith(t, ['clients:create'], { ip: CALLER_IP });
    const res = await invite(creator);
    expect(res.status).toBe(201);
    expect(res.body.wallet).toBeUndefined();
    expect(res.body.stats).toBeUndefined();
    expect(await clientRows()).toHaveLength(1);
  });
});

describe('GET /admin/clients and /admin/clients/:id', () => {
  /** Four merchants like the demo's: names, statuses, groups, a referrer and a credit limit. */
  async function seedMerchants() {
    const g = await groups();
    const { db } = await testDb();
    const zain = await insertMerchant(db, {
      name: 'Zain Mobile Hub',
      email: 'ops@zain.example',
      username: 'zain-mobile-hub',
      company: 'Zain Trading',
      country: 'JO',
      groupId: g.vip,
      status: 'active',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    const alpha = await insertMerchant(db, {
      name: 'Alpha Unlock',
      email: 'alpha@example.com',
      username: 'alpha-unlock',
      country: 'AE',
      groupId: g.standard,
      status: 'pending',
      referredById: zain,
      createdAt: new Date('2026-02-01T00:00:00.000Z'),
    });
    const beta = await insertMerchant(db, {
      name: 'Beta Phones',
      email: 'beta@example.com',
      username: 'beta-phones',
      country: 'JO',
      groupId: g.standard,
      status: 'suspended',
      createdAt: new Date('2026-03-01T00:00:00.000Z'),
    });
    const gamma = await insertMerchant(db, {
      name: 'gamma repairs',
      email: 'gamma@example.com',
      username: 'gamma-repairs',
      country: 'EG',
      groupId: g.standard,
      status: 'active',
      createdAt: new Date('2026-04-01T00:00:00.000Z'),
    });
    // Zain has a wallet with credit; the others have none (they read as zeros).
    await t.app
      .get(MerchantAccounts)
      .open(db, { clientId: zain, currency: 'USD', creditLimit: '2000.0000', overdraftAllowed: true });
    await db
      .update(s.ledgerAccounts)
      .set({ balance: '1480.0000' })
      .where(and(eq(s.ledgerAccounts.ownerId, zain), eq(s.ledgerAccounts.kind, 'client_wallet')));
    await db
      .update(s.ledgerAccounts)
      .set({ balance: '20.0000' })
      .where(and(eq(s.ledgerAccounts.ownerId, zain), eq(s.ledgerAccounts.kind, 'client_hold')));
    return { ...g, zain, alpha, beta, gamma };
  }

  it('lists merchants by name (case-insensitive) with group, referrer, wallet and stats, and the exact total', async () => {
    const m = await seedMerchants();
    const rami = await owner();
    const res = await rami.get('/admin/clients');
    expect(res.status).toBe(200);
    expect(res.total).toBe(4);
    expect(ids(res.body)).toEqual([m.alpha, m.beta, m.gamma, m.zain]);
    const zain = res.body.find((row: { id: number }) => row.id === m.zain);
    expect(zain).toMatchObject({
      name: 'Zain Mobile Hub',
      email: 'ops@zain.example',
      username: 'zain-mobile-hub',
      company: 'Zain Trading',
      country: 'JO',
      status: 'active',
      kycStatus: 'none',
      createdAt: '2026-01-01T00:00:00.000Z',
      group: { id: m.vip, name: 'VIP', discountPercent: '8.0000' },
      referredBy: null,
      wallet: { balance: '1480.0000', reserved: '20.0000', creditLimit: '2000.0000', available: '3480.0000' },
      stats: { orders: 0, spend: '0.0000', profit: '0.0000', margin: null, successRate: null, lastOrderAt: null },
    });
    const alpha = res.body.find((row: { id: number }) => row.id === m.alpha);
    expect(alpha.referredBy).toEqual({ id: m.zain, name: 'Zain Mobile Hub' });
    expect(alpha.wallet).toEqual({ balance: '0.0000', reserved: '0.0000', creditLimit: '0.0000', available: '0.0000' });
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|totp|telegram|notificationPrefs/i);
  });

  it('filters by status (equal and not equal), group and id, searches name, email, company, username and country, sorts and pages', async () => {
    const m = await seedMerchants();
    const rami = await owner();
    expect(ids((await rami.get('/admin/clients?status=active&_sort=id&_order=asc')).body)).toEqual([m.zain, m.gamma]);
    expect(ids((await rami.get('/admin/clients?status_ne=active&_sort=id&_order=asc')).body)).toEqual([
      m.alpha,
      m.beta,
    ]);
    expect(ids((await rami.get(`/admin/clients?groupId=${m.vip}`)).body)).toEqual([m.zain]);
    expect(ids((await rami.get(`/admin/clients?id=${m.beta}&id=${m.gamma}&_sort=id&_order=asc`)).body)).toEqual([
      m.beta,
      m.gamma,
    ]);
    expect(ids((await rami.get('/admin/clients?q=ZAIN')).body)).toEqual([m.zain]);
    expect(ids((await rami.get('/admin/clients?q=trading')).body)).toEqual([m.zain]);
    expect(ids((await rami.get('/admin/clients?q=beta@')).body)).toEqual([m.beta]);
    expect(ids((await rami.get('/admin/clients?q=gamma-repairs')).body)).toEqual([m.gamma]);
    expect(ids((await rami.get('/admin/clients?q=eg')).body)).toContain(m.gamma);
    expect((await rami.get('/admin/clients?q=nobody')).total).toBe(0);
    expect(ids((await rami.get('/admin/clients?q=example.com&status=active')).body)).toEqual([m.gamma]);

    expect(ids((await rami.get('/admin/clients?_sort=createdAt&_order=desc')).body)).toEqual([
      m.gamma,
      m.beta,
      m.alpha,
      m.zain,
    ]);
    expect(ids((await rami.get('/admin/clients?_sort=status&_order=asc')).body)).toEqual([
      m.zain,
      m.gamma,
      m.alpha,
      m.beta,
    ]);
    const page = await rami.get('/admin/clients?_sort=name&_order=asc&_start=1&_end=3');
    expect(ids(page.body)).toEqual([m.beta, m.gamma]);
    expect(page.total).toBe(4);
    expect((await rami.get('/admin/clients?status=gone')).status).toBe(422);
    expect((await rami.get('/admin/clients?_sort=email')).status).toBe(422);
  });

  it('leaves out the wallet and the stats for staff without wallet:read', async () => {
    const m = await seedMerchants();
    const reader = await adminWith(t, ['clients:read'], { ip: CALLER_IP });
    const list = await reader.get('/admin/clients');
    expect(list.status).toBe(200);
    for (const row of list.body) {
      expect(row.wallet).toBeUndefined();
      expect(row.stats).toBeUndefined();
    }
    const one = await reader.get(`/admin/clients/${m.zain}`);
    expect(one.body.wallet).toBeUndefined();
    expect(one.body.group.name).toBe('VIP');
    const finance = await adminWith(t, ['clients:read', 'wallet:read'], { ip: CALLER_IP });
    expect((await finance.get(`/admin/clients/${m.zain}`)).body.wallet.creditLimit).toBe('2000.0000');
  });

  it('shows one merchant, answers 404 for an unknown id, and needs clients:read', async () => {
    const m = await seedMerchants();
    const rami = await owner();
    const shown = await rami.get(`/admin/clients/${m.alpha}`);
    expect(shown.status).toBe(200);
    expect(shown.body).toMatchObject({ id: m.alpha, name: 'Alpha Unlock', status: 'pending' });
    const missing = await rami.get('/admin/clients/999999');
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('NOT_FOUND');
    const nobody = await adminWith(t, ['staff:read'], { ip: CALLER_IP });
    expect((await nobody.get('/admin/clients')).body.detail).toContain('clients:read');
    expect((await nobody.get(`/admin/clients/${m.alpha}`)).status).toBe(403);
  });
});

describe('PATCH /admin/clients/:id', () => {
  async function pending() {
    const g = await groups();
    const rami = await owner();
    const created = await invite(rami, { groupId: g.vip, creditLimit: '300.0000' });
    return { ...g, rami, id: created.body.id as number };
  }

  it('approves a pending merchant (pending to active), audits it and clears the cached API key view', async () => {
    const { rami, id } = await pending();
    const { db } = await testDb();
    const key = await insertApiKey(t, db, id);
    const directory = t.app.get(ApiKeyDirectory);
    expect((await directory.findByKey(key.key))!.client.status).toBe('pending');

    const res = await rami.patch(`/admin/clients/${id}`, { status: 'active' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id, status: 'active' });
    expect((await clientRow(id)).status).toBe('active');
    expect((await directory.findByKey(key.key))!.client.status).toBe('active');
    const audit = (await auditRows()).at(-1)!;
    expect(audit).toMatchObject({
      action: 'approved merchant',
      entityType: 'merchant',
      entityId: id,
      entityLabel: 'Zain Mobile Hub',
    });
    expect(audit.before).toEqual({ status: 'pending' });
    expect(audit.after).toEqual({ status: 'active' });
  });

  it('suspends an active merchant: the reason, who and when are stored, its sessions end, its API keys read as suspended, the wallet is untouched', async () => {
    const { rami, id } = await pending();
    await rami.patch(`/admin/clients/${id}`, { status: 'active' });
    const { db } = await testDb();
    const key = await insertApiKey(t, db, id);
    const directory = t.app.get(ApiKeyDirectory);
    expect((await directory.findByKey(key.key))!.client.status).toBe('active');
    const session = await openSession(t, { type: 'client', id });
    const other = await insertMerchant(db);
    const otherSession = await openSession(t, { type: 'client', id: other });
    const walletBefore = await ledgerRowsOf(id);
    clock.advance(5 * MINUTE);

    const res = await rami.patch(`/admin/clients/${id}`, {
      status: 'suspended',
      reason: '  Chargeback abuse: three in a week ',
    });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('suspended');
    expect(await clientRow(id)).toMatchObject({
      status: 'suspended',
      suspendedReason: 'Chargeback abuse: three in a week',
      suspendedBy: rami.staffId,
      suspendedAt: clock.now(),
    });
    const sessions = await db.select().from(s.sessions);
    expect(sessions.find((row) => row.id === session.sessionId)!.revokedAt).toEqual(clock.now());
    expect(sessions.find((row) => row.id === otherSession.sessionId)!.revokedAt).toBeNull();
    expect((await directory.findByKey(key.key))!.client.status).toBe('suspended');
    expect(await ledgerRowsOf(id)).toEqual(walletBefore);
    const audit = (await auditRows()).at(-1)!;
    expect(audit).toMatchObject({ action: 'suspended merchant', entityId: id });
    expect(audit.before).toEqual({ status: 'active' });
    expect(audit.after).toEqual({ status: 'suspended', reason: 'Chargeback abuse: three in a week' });
  });

  it('reactivates a suspended merchant: the suspension is cleared, no session comes back, the cached views are dropped', async () => {
    const { rami, id } = await pending();
    await rami.patch(`/admin/clients/${id}`, { status: 'active' });
    const session = await openSession(t, { type: 'client', id });
    await rami.patch(`/admin/clients/${id}`, { status: 'suspended', reason: 'Under review' });
    const { db } = await testDb();
    const key = await insertApiKey(t, db, id);
    const directory = t.app.get(ApiKeyDirectory);
    expect((await directory.findByKey(key.key))!.client.status).toBe('suspended');

    const res = await rami.patch(`/admin/clients/${id}`, { status: 'active' });
    expect(res.status).toBe(200);
    expect(await clientRow(id)).toMatchObject({
      status: 'active',
      suspendedReason: null,
      suspendedBy: null,
      suspendedAt: null,
    });
    expect((await directory.findByKey(key.key))!.client.status).toBe('active');
    const stored = (await db.select().from(s.sessions)).find((row) => row.id === session.sessionId)!;
    expect(stored.revokedAt).not.toBeNull();
    const audit = (await auditRows()).at(-1)!;
    expect(audit).toMatchObject({ action: 'reactivated merchant' });
    expect(audit.before).toEqual({ status: 'suspended' });
  });

  it('refuses every other status change (409 INVALID_TRANSITION on status) and writes nothing', async () => {
    const { rami, id } = await pending();
    const refused = async (body: Record<string, unknown>) => {
      const res = await rami.patch(`/admin/clients/${id}`, body);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('INVALID_TRANSITION');
      expect(res.body.errors[0].field).toBe('status');
    };
    // Pending can only be approved.
    await refused({ status: 'suspended', reason: 'Not allowed yet' });
    await refused({ status: 'pending' });
    await rami.patch(`/admin/clients/${id}`, { status: 'active' });
    // Active can only be suspended.
    await refused({ status: 'active' });
    await refused({ status: 'pending' });
    await rami.patch(`/admin/clients/${id}`, { status: 'suspended', reason: 'Under review' });
    // Suspended can only be reactivated.
    await refused({ status: 'suspended', reason: 'Again please' });
    await refused({ status: 'pending' });
    expect((await clientRow(id)).status).toBe('suspended');
    // The invitation, the approval and the suspension: the refusals wrote no audit row.
    expect(await auditRows()).toHaveLength(3);
  });

  it('needs a reason of 3 to 140 characters to suspend (422 on reason), and ignores a reason when approving', async () => {
    const { rami, id } = await pending();
    const approved = await rami.patch(`/admin/clients/${id}`, { status: 'active', reason: 'unused' });
    expect(approved.status).toBe(200);
    expect(await clientRow(id)).toMatchObject({ suspendedReason: null });
    for (const reason of [undefined, '', '  ', 'ab', 'x'.repeat(141)]) {
      const res = await rami.patch(`/admin/clients/${id}`, {
        status: 'suspended',
        ...(reason === undefined ? {} : { reason }),
      });
      expect(res.status).toBe(422);
      expect(res.body.errors[0].field).toBe('reason');
    }
    expect((await clientRow(id)).status).toBe('active');
    expect((await rami.patch(`/admin/clients/${id}`, { status: 'suspended', reason: 'x'.repeat(140) })).status).toBe(
      200,
    );
  });

  it('moves a merchant to another group: it is audited, and prices only new orders (nothing else changes)', async () => {
    const { rami, id, standard, vip } = await pending();
    const { db } = await testDb();
    await db
      .update(s.ledgerAccounts)
      .set({ overdraftLimit: '0.0000' })
      .where(and(eq(s.ledgerAccounts.ownerId, id), eq(s.ledgerAccounts.kind, 'client_wallet')));
    const moved = await rami.patch(`/admin/clients/${id}`, { groupId: standard });
    expect(moved.status).toBe(200);
    expect(moved.body).toMatchObject({
      groupId: standard,
      group: { id: standard, name: 'Standard' },
      status: 'pending',
    });
    const audit = (await auditRows()).at(-1)!;
    expect(audit).toMatchObject({ action: 'changed group of', entityType: 'merchant', entityId: id });
    expect(audit.before).toEqual({ groupId: vip, group: 'VIP' });
    expect(audit.after).toEqual({ groupId: standard, group: 'Standard' });
    expect((await rami.patch(`/admin/clients/${id}`, { groupId: vip })).body.groupId).toBe(vip);
  });

  it('refuses a group move to the same group, an unknown group, the storefront group, or a group without credit while the limit is above zero (422 on groupId)', async () => {
    const { rami, id, standard, vip, retail } = await pending();
    for (const groupId of [vip, 999_999, retail, standard]) {
      const res = await rami.patch(`/admin/clients/${id}`, { groupId });
      expect(res.status).toBe(422);
      expect(res.body.errors[0].field).toBe('groupId');
    }
    expect((await clientRow(id)).groupId).toBe(vip);
    // The credit limit is 300: lowering it to zero makes the move possible.
    const { db } = await testDb();
    await db
      .update(s.ledgerAccounts)
      .set({ overdraftLimit: '0.0000' })
      .where(and(eq(s.ledgerAccounts.ownerId, id), eq(s.ledgerAccounts.kind, 'client_wallet')));
    expect((await rami.patch(`/admin/clients/${id}`, { groupId: standard })).status).toBe(200);
  });

  it('refuses a body that changes the status and the group together, or neither (422), and an unknown merchant (404)', async () => {
    const { rami, id, standard } = await pending();
    const both = await rami.patch(`/admin/clients/${id}`, { status: 'active', groupId: standard });
    expect(both.status).toBe(422);
    expect(both.body.errors[0].field).toBe('status');
    expect((await rami.patch(`/admin/clients/${id}`, {})).status).toBe(422);
    expect((await rami.patch(`/admin/clients/${id}`, { status: 'dormant' })).body.errors[0].field).toBe('status');
    const missing = await rami.patch('/admin/clients/999999', { status: 'active' });
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('NOT_FOUND');
    expect((await clientRow(id)).status).toBe('pending');
  });

  it('lets only one of two parallel status changes win (the row is locked)', async () => {
    const { rami, id } = await pending();
    await rami.patch(`/admin/clients/${id}`, { status: 'active' });
    const answers = await Promise.all([
      rami.patch(`/admin/clients/${id}`, { status: 'suspended', reason: 'First request' }),
      rami.patch(`/admin/clients/${id}`, { status: 'suspended', reason: 'Second request' }),
    ]);
    expect(answers.map((answer) => answer.status).sort()).toEqual([200, 409]);
  });

  it('needs clients:update and a CSRF token', async () => {
    const { rami, id } = await pending();
    const reader = await adminWith(t, ['clients:read', 'clients:create'], { ip: CALLER_IP });
    const refused = await reader.patch(`/admin/clients/${id}`, { status: 'active' });
    expect(refused.status).toBe(403);
    expect(refused.body.detail).toContain('clients:update');
    const noCsrf = await rami.withoutCsrf('PATCH', `/admin/clients/${id}`, { status: 'active' });
    expect(noCsrf.body.code).toBe('CSRF_FAILED');
    expect((await clientRow(id)).status).toBe('pending');
  });
});
