// Integration tests of "Make an account" (POST /admin/clients/:id/account, decision 064): staff give a guest row a login, with an emailed
// invitation or a temporary password, through HTTP on the real application.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import { schema as s } from '@src/infra/db';
import { adminWith } from '../../support/admin-api';
import { accountLinks, captureAccountLinks } from '../../support/account-links';
import { accountRow, ensureRetailGroup, makeAccount } from '../../support/accounts';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches } from '../../support/auth';
import { HOUR, TestClock } from '../../support/clock';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { insertUsd } from '../../support/fixtures';
import { clearAccountMailLimits } from '../../support/identity-mail';
import { notificationRows } from '../../support/notifications';
import { insertBlock } from '../../support/risk';

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
  await clearAccountMailLimits(t);
  captureAccountLinks(t);
  const { db } = await testDb();
  await insertUsd(db);
  await ensureRetailGroup(db);
});
afterEach(() => mock.restore());
afterAll(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await t.close();
  await closeTestDb();
});

const auditRows = async () => (await testDb()).db.select().from(s.auditLogs).orderBy(s.auditLogs.id);
const outboxRows = async () => (await testDb()).db.select().from(s.outboxEvents).orderBy(s.outboxEvents.id);
const tokensOf = async (accountId: number) => {
  const { db } = await testDb();
  return db
    .select()
    .from(s.authTokens)
    .where(and(eq(s.authTokens.subjectType, 'account'), eq(s.authTokens.subjectId, accountId)))
    .orderBy(s.authTokens.id);
};

/** A staff member who may update accounts, with or without the second permission of a temporary password. */
const updater = (security = false) =>
  adminWith(t, ['clients:read', 'clients:update', ...(security ? ['clients:security'] : [])], {
    name: 'Rami K.',
    ip: CALLER_IP,
  });

const guestRow = (email = 'buyer@example.com') =>
  makeAccount(t, { rank: 'retail', guest: true, email, name: 'Buyer One' });
const makeAccountOf = (api: Awaited<ReturnType<typeof updater>>, id: number, body: Record<string, unknown> = {}) =>
  api.post(`/admin/clients/${id}/account`, body);

describe('POST /admin/clients/:id/account: the invitation', () => {
  it('gives the guest row a login in place: still the retail rank, no password yet, an invitation sent, the answer never cached', async () => {
    const api = await updater();
    const guest = await guestRow();
    const res = await makeAccountOf(api, guest.id, { mode: 'reset_link' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ link: 'invite' });
    expect(res.res.headers['cache-control']).toContain('no-store');
    expect(await accountRow(guest.id)).toMatchObject({
      hasAccount: true,
      groupId: guest.groupId,
      passwordHash: null,
      username: null,
      email: 'buyer@example.com',
      status: 'active',
    });
    const [token, ...others] = await tokensOf(guest.id);
    expect(others).toHaveLength(0);
    expect(token).toMatchObject({
      purpose: 'invite',
      usedAt: null,
      createdBy: api.staffId,
      ip: CALLER_IP,
      expiresAt: new Date(clock.nowMs() + HOUR),
    });
    expect(accountLinks()).toEqual([{ kind: 'invited', accountId: guest.id, token: expect.any(String) }]);
    const mails = (await outboxRows()).filter((row) => (row.payload as { tokenId?: number }).tokenId === token!.id);
    expect(mails).toHaveLength(1);
    expect(JSON.stringify(mails[0]!.payload)).not.toContain('buyer@example.com');
  });

  it('defaults to the invitation when no mode is sent, and voids the guest row’s own open sign-in links', async () => {
    const api = await updater();
    const guest = await guestRow();
    const { db } = await testDb();
    const [link] = await db
      .insert(s.authTokens)
      .values({
        purpose: 'magic_link',
        subjectType: 'account',
        subjectId: guest.id,
        tokenHash: 'b'.repeat(64),
        expiresAt: new Date(clock.nowMs() + HOUR),
      })
      .returning();
    const res = await makeAccountOf(api, guest.id);
    expect(res.status).toBe(200);
    expect((await tokensOf(guest.id)).find((row) => row.id === link!.id)!.usedAt).not.toBeNull();
    expect(accountLinks().map((l) => l.kind)).toEqual(['invited']);
  });

  it('audits the change without any secret', async () => {
    const api = await updater();
    const guest = await guestRow();
    await makeAccountOf(api, guest.id, { mode: 'reset_link' });
    const [audit, ...others] = await auditRows();
    expect(others).toHaveLength(0);
    expect(audit).toMatchObject({
      action: 'made an account for',
      entityType: 'account',
      entityId: guest.id,
      entityLabel: 'Buyer One',
      actorId: api.staffId,
    });
    expect(audit!.before).toEqual({ account: 'guest' });
    expect(audit!.after).toEqual({ account: 'login', credential: 'invitation emailed' });
    const [token] = await tokensOf(guest.id);
    expect(JSON.stringify(audit)).not.toContain(token!.tokenHash);
  });
});

describe('POST /admin/clients/:id/account: a temporary password', () => {
  it('needs clients:security as well (decision 047), and a refused call reads and writes nothing', async () => {
    const plain = await updater(false);
    const guest = await guestRow();
    const before = await accountRow(guest.id);
    const refused = await makeAccountOf(plain, guest.id, { mode: 'temporary_password' });
    expect(refused.status).toBe(403);
    expect(refused.body.detail).toBe('You need the clients:security permission to do this.');
    expect(await accountRow(guest.id)).toEqual(before);
    expect(await auditRows()).toHaveLength(0);
  });

  it('stores the hash only, forces a change at the first sign-in, answers the password once, sends no link, and tells the address', async () => {
    const api = await updater(true);
    const guest = await guestRow();
    const res = await makeAccountOf(api, guest.id, { mode: 'temporary_password' });
    expect(res.status).toBe(200);
    expect(res.res.headers['cache-control']).toContain('no-store');
    const password = res.body.temporaryPassword as string;
    expect(password).toHaveLength(14);
    expect(res.body.link).toBeUndefined();
    const row = await accountRow(guest.id);
    expect(row).toMatchObject({
      hasAccount: true,
      mustChangePassword: true,
      passwordSetByStaff: true,
      passwordChangedAt: clock.now(),
    });
    expect(row.passwordHash).toMatch(/^\$argon2id\$/);
    expect(JSON.stringify(row)).not.toContain(password);
    expect(accountLinks().map((l) => l.kind)).toEqual([]);
    const notices = (await notificationRows((await testDb()).db)).filter((row) => row.recipientId === guest.id);
    expect(notices).toHaveLength(1);
    // The row holds the retail rank: the retail notice, never the merchant one (which has no retail text).
    expect(notices[0]!.event).toBe('customer.security_notice');
    const [audit] = await auditRows();
    expect(JSON.stringify(audit)).not.toContain(password);
    expect(audit!.after).toEqual({ account: 'login', credential: 'temporary password set' });
  });
});

describe('POST /admin/clients/:id/account: refusals', () => {
  it('refuses a row that already has a login (409 ACCOUNT_EXISTS) and an unknown row (404), and writes nothing', async () => {
    const api = await updater();
    const login = await makeAccount(t, { rank: 'retail' });
    const merchant = await makeAccount(t, { rank: 'merchant' });
    for (const id of [login.id, merchant.id]) {
      const res = await makeAccountOf(api, id, { mode: 'reset_link' });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('ACCOUNT_EXISTS');
    }
    expect((await makeAccountOf(api, 999_999, { mode: 'reset_link' })).status).toBe(404);
    expect(await auditRows()).toHaveLength(0);
    expect(accountLinks()).toEqual([]);
  });

  it('refuses an anonymized guest row (409 ANONYMIZED)', async () => {
    const api = await updater();
    const gone = await makeAccount(t, {
      rank: 'retail',
      guest: true,
      status: 'anonymized',
      anonymizedAt: clock.now(),
      email: 'deleted-account-1@redacted.invalid',
    });
    const res = await makeAccountOf(api, gone.id, { mode: 'reset_link' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ANONYMIZED');
  });

  it('refuses a guest whose email another row with a login holds (409 EMAIL_TAKEN, code login_exists) and leaves the guest a guest', async () => {
    const api = await updater();
    const guest = await guestRow('shared@example.com');
    await makeAccount(t, { rank: 'merchant', email: 'Shared@Example.com' });
    const before = await accountRow(guest.id);
    const res = await makeAccountOf(api, guest.id, { mode: 'reset_link' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('EMAIL_TAKEN');
    expect(res.body.errors[0]).toMatchObject({ field: 'email', code: 'login_exists' });
    expect(await accountRow(guest.id)).toEqual(before);
    expect(await tokensOf(guest.id)).toEqual([]);
    expect(await auditRows()).toHaveLength(0);
  });

  it('refuses a guest whose email is on the blocklist (422 on email, as a create does) and leaves the guest a guest', async () => {
    const { db } = await testDb();
    const api = await updater(true);
    const guest = await guestRow('chargeback@example.com');
    await insertBlock(t, db, 'email', 'chargeback@example.com');
    const before = await accountRow(guest.id);
    for (const mode of ['reset_link', 'temporary_password']) {
      const res = await makeAccountOf(api, guest.id, { mode });
      expect(res.status, mode).toBe(422);
      expect(res.body.errors).toEqual([expect.objectContaining({ field: 'email', code: 'blocked' })]);
    }
    expect(await accountRow(guest.id)).toEqual(before);
    expect(await tokensOf(guest.id)).toEqual([]);
    expect(await auditRows()).toHaveLength(0);
  });

  it('lets only one of two parallel calls win (the row is locked): the other is ACCOUNT_EXISTS', async () => {
    const api = await updater();
    const guest = await guestRow();
    const answers = await Promise.all([
      makeAccountOf(api, guest.id, { mode: 'reset_link' }),
      makeAccountOf(api, guest.id, { mode: 'reset_link' }),
    ]);
    expect(answers.map((answer) => answer.status).sort()).toEqual([200, 409]);
    expect(await tokensOf(guest.id)).toHaveLength(1);
  });

  it('needs clients:update and a CSRF token', async () => {
    const guest = await guestRow();
    const reader = await adminWith(t, ['clients:read'], { ip: CALLER_IP });
    const refused = await reader.post(`/admin/clients/${guest.id}/account`, { mode: 'reset_link' });
    expect(refused.status).toBe(403);
    expect(refused.body.detail).toContain('clients:update');
    const api = await updater();
    const noCsrf = await api.withoutCsrf('POST', `/admin/clients/${guest.id}/account`, { mode: 'reset_link' });
    expect(noCsrf.status).toBe(403);
    expect(noCsrf.body.code).toBe('CSRF_FAILED');
    expect((await accountRow(guest.id)).hasAccount).toBe(false);
  });
});
