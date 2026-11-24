// Integration tests of the staff edit of an account (PATCH /admin/clients/:id, decision 064): suspend and reactivate with their access effects, the
// refusal of a rank in the body, the details of a retail and of a merchant account, and the email rule of the two partitions with the second
// permissions (decisions 046 and 047), through HTTP on the real application.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import { AppError } from '@src/common/errors';
import { schema as s } from '@src/infra/db';
import { AccountCreateGuards, ApiKeyDirectory } from '@src/modules/identity';
import { NEVER_APPROVED_REASON } from '@src/modules/identity/domain/client-rules';
import { type AdminApi, adminWith } from '../../support/admin-api';
import { accountLinks, captureAccountLinks } from '../../support/account-links';
import { accountRow, ensureRetailGroup, makeAccount } from '../../support/accounts';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches, openSession } from '../../support/auth';
import { HOUR, TestClock } from '../../support/clock';
import { insertTaxRates } from '../../support/customers';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { insertUsd } from '../../support/fixtures';
import { clearAccountMailLimits } from '../../support/identity-mail';
import { insertApiKey } from '../../support/machine-auth';
import { notificationRows } from '../../support/notifications';

const clock = new TestClock();
let t: TestApp;
const CALLER_IP = '203.0.113.50';
const BLOCKED_EMAIL = 'blocked@example.com';

beforeAll(async () => {
  t = await createTestApp({ clock });
  t.app.get(AccountCreateGuards).register('accounts-update-spec', (_tx, facts) => {
    if (facts.email === BLOCKED_EMAIL) {
      return Promise.reject(
        new AppError('VALIDATION_FAILED', {
          errors: [{ field: 'email', code: 'blocked', message: 'This email is blocked.' }],
        }),
      );
    }
    return Promise.resolve();
  });
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
  await insertTaxRates(db, ['GB', 'DE']);
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
const sessionRows = async () => (await testDb()).db.select().from(s.sessions).orderBy(s.sessions.id);

/** A staff member who may edit accounts and holds the second permission of decisions 046 and 047. */
const editor = () =>
  adminWith(t, ['clients:read', 'clients:update', 'clients:security'], { name: 'Rami K.', ip: CALLER_IP });

/** Leaves one open link of a purpose on an account (or a guest row). */
async function openLink(accountId: number, purpose: 'reset' | 'verify_email' | 'magic_link' | 'invite', hash: string) {
  const { db } = await testDb();
  const [row] = await db
    .insert(s.authTokens)
    .values({
      purpose,
      subjectType: 'account',
      subjectId: accountId,
      tokenHash: hash.padEnd(64, '0'),
      expiresAt: new Date(clock.nowMs() + HOUR),
    })
    .returning();
  return row!;
}

describe('PATCH /admin/clients/:id: status', () => {
  it.each(['retail', 'merchant'] as const)(
    'suspends an active %s account: reason, who and when are stored, its sessions and links end, the others stay',
    async (rank) => {
      const rami = await editor();
      const account = await makeAccount(t, { rank });
      const other = await makeAccount(t, { rank });
      const session = await openSession(t, { type: 'account', id: account.id });
      const otherSession = await openSession(t, { type: 'account', id: other.id });
      const link = await openLink(account.id, 'reset', 'reset-hash');
      clock.advance(5 * 60_000);

      const res = await rami.patch(`/admin/clients/${account.id}`, {
        status: 'suspended',
        reason: '  Chargeback abuse: three in a week ',
      });
      expect(res.status).toBe(200);
      expect(await accountRow(account.id)).toMatchObject({
        status: 'suspended',
        suspendedReason: 'Chargeback abuse: three in a week',
        suspendedBy: rami.staffId,
        suspendedAt: clock.now(),
      });
      const sessions = await sessionRows();
      expect(sessions.find((row) => row.id === session.sessionId)!.revokedAt).toEqual(clock.now());
      expect(sessions.find((row) => row.id === otherSession.sessionId)!.revokedAt).toBeNull();
      expect((await tokensOf(account.id)).find((row) => row.id === link.id)!.usedAt).not.toBeNull();
      const audit = (await auditRows()).at(-1)!;
      expect(audit).toMatchObject({ action: 'suspended account of', entityType: 'account', entityId: account.id });
      expect(audit.before).toEqual({ status: 'active' });
      expect(audit.after).toEqual({
        status: 'suspended',
        reason: 'Chargeback abuse: three in a week',
        sessionsEnded: 1,
      });
    },
  );

  it('keeps the API keys of a suspended merchant (they answer as suspended) and drops their cached view', async () => {
    const rami = await editor();
    const merchant = await makeAccount(t, { rank: 'merchant' });
    const { db } = await testDb();
    const key = await insertApiKey(t, db, merchant.id);
    const directory = t.app.get(ApiKeyDirectory);
    expect((await directory.findByKey(key.key))!.client.status).toBe('active');
    expect(
      (await rami.patch(`/admin/clients/${merchant.id}`, { status: 'suspended', reason: 'Under review' })).status,
    ).toBe(200);
    expect((await directory.findByKey(key.key))!.client.status).toBe('suspended');
    const [stored] = await db.select().from(s.apiKeys).where(eq(s.apiKeys.id, key.id));
    expect(stored!.revokedAt).toBeNull();
    expect((await rami.patch(`/admin/clients/${merchant.id}`, { status: 'active' })).status).toBe(200);
    expect((await directory.findByKey(key.key))!.client.status).toBe('active');
  });

  it('reactivates a suspended account: the suspension is cleared and no session comes back', async () => {
    const rami = await editor();
    const account = await makeAccount(t, { rank: 'retail' });
    const session = await openSession(t, { type: 'account', id: account.id });
    await rami.patch(`/admin/clients/${account.id}`, { status: 'suspended', reason: 'Under review' });
    const res = await rami.patch(`/admin/clients/${account.id}`, { status: 'active', reason: 'unused' });
    expect(res.status).toBe(200);
    expect(await accountRow(account.id)).toMatchObject({
      status: 'active',
      suspendedReason: null,
      suspendedBy: null,
      suspendedAt: null,
    });
    expect((await sessionRows()).find((row) => row.id === session.sessionId)!.revokedAt).not.toBeNull();
    const audit = (await auditRows()).at(-1)!;
    expect(audit).toMatchObject({ action: 'reactivated account of', entityType: 'account' });
    expect(audit.before).toEqual({ status: 'suspended' });
    expect(audit.after).toEqual({ status: 'active' });
  });

  it('lets only the Owner reactivate a merchant-rank account that was suspended because it was never approved (403 for anyone else)', async () => {
    const neverApproved = {
      rank: 'merchant',
      status: 'suspended',
      suspendedAt: new Date(clock.nowMs() - HOUR),
      suspendedReason: NEVER_APPROVED_REASON,
    } as const;
    const first = await makeAccount(t, neverApproved);
    const second = await makeAccount(t, neverApproved);
    // Staff who may reactivate any other account, one request per account as the console's bulk Reactivate sends them.
    const rami = await editor();
    for (const account of [first, second]) {
      const refused = await rami.patch(`/admin/clients/${account.id}`, { status: 'active' });
      expect(refused.status).toBe(403);
      expect(refused.body.code).toBe('FORBIDDEN');
      expect(refused.body.detail).toBe('Only the Owner may activate an account that was never approved.');
      expect(await accountRow(account.id)).toMatchObject({
        status: 'suspended',
        suspendedReason: NEVER_APPROVED_REASON,
      });
    }
    expect(await auditRows()).toHaveLength(0);

    const owner = await adminWith(t, ['*'], { name: 'Owner One', ip: CALLER_IP });
    expect((await owner.patch(`/admin/clients/${first.id}`, { status: 'active' })).status).toBe(200);
    expect(await accountRow(first.id)).toMatchObject({ status: 'active', suspendedAt: null, suspendedReason: null });
  });

  it('keeps the Owner rule to that suspension: staff may reactivate a merchant they suspended with the same words, and a retail account', async () => {
    const rami = await editor();
    const merchant = await makeAccount(t, { rank: 'merchant' });
    // A suspension staff wrote has an author: it is not the mark of an account that was never approved.
    expect(
      (await rami.patch(`/admin/clients/${merchant.id}`, { status: 'suspended', reason: NEVER_APPROVED_REASON }))
        .status,
    ).toBe(200);
    expect((await rami.patch(`/admin/clients/${merchant.id}`, { status: 'active' })).status).toBe(200);
    const retail = await makeAccount(t, {
      rank: 'retail',
      status: 'suspended',
      suspendedAt: new Date(clock.nowMs() - HOUR),
      suspendedReason: NEVER_APPROVED_REASON,
    });
    expect((await rami.patch(`/admin/clients/${retail.id}`, { status: 'active' })).status).toBe(200);
  });

  it('refuses every other change (409 INVALID_TRANSITION on status), a blocked account included, and writes nothing', async () => {
    const rami = await editor();
    const account = await makeAccount(t, { rank: 'retail' });
    const blocked = await makeAccount(t, { rank: 'retail', status: 'blocked' });
    const refused = async (id: number, body: Record<string, unknown>) => {
      const res = await rami.patch(`/admin/clients/${id}`, body);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('INVALID_TRANSITION');
      expect(res.body.errors[0].field).toBe('status');
    };
    await refused(account.id, { status: 'active' });
    await rami.patch(`/admin/clients/${account.id}`, { status: 'suspended', reason: 'Under review' });
    await refused(account.id, { status: 'suspended', reason: 'Again please' });
    // A blocked account is unblocked on the block route, never here.
    await refused(blocked.id, { status: 'active' });
    expect((await accountRow(blocked.id)).status).toBe('blocked');
    expect(await auditRows()).toHaveLength(1);
  });

  it('refuses blocked, anonymized and pending as a status written here (422 on status)', async () => {
    const rami = await editor();
    const account = await makeAccount(t, { rank: 'retail' });
    for (const status of ['blocked', 'anonymized', 'pending']) {
      const res = await rami.patch(`/admin/clients/${account.id}`, { status, reason: 'Some reason' });
      expect(res.status, status).toBe(422);
      expect(res.body.errors[0].field, status).toBe('status');
    }
    expect((await accountRow(account.id)).status).toBe('active');
    expect(await auditRows()).toHaveLength(0);
  });

  it('needs a reason of 3 to 140 characters to suspend (422 on reason)', async () => {
    const rami = await editor();
    const account = await makeAccount(t, { rank: 'merchant' });
    for (const reason of [undefined, '', '  ', 'ab', 'x'.repeat(141)]) {
      const res = await rami.patch(`/admin/clients/${account.id}`, {
        status: 'suspended',
        ...(reason === undefined ? {} : { reason }),
      });
      expect(res.status).toBe(422);
      expect(res.body.errors[0].field).toBe('reason');
    }
    expect((await accountRow(account.id)).status).toBe('active');
    expect(
      (await rami.patch(`/admin/clients/${account.id}`, { status: 'suspended', reason: 'x'.repeat(140) })).status,
    ).toBe(200);
  });

  it('refuses a guest (409 NO_ACCOUNT) and any write on an anonymized account (409 ANONYMIZED)', async () => {
    const rami = await editor();
    const guest = await makeAccount(t, { rank: 'retail', guest: true });
    const gone = await makeAccount(t, { rank: 'retail', status: 'anonymized', anonymizedAt: clock.now() });
    const suspend = await rami.patch(`/admin/clients/${guest.id}`, { status: 'suspended', reason: 'Under review' });
    expect(suspend.status).toBe(409);
    expect(suspend.body.code).toBe('NO_ACCOUNT');
    for (const body of [
      { status: 'suspended', reason: 'Under review' },
      { phone: '+49 1' },
      { email: 'new@example.com' },
    ]) {
      const res = await rami.patch(`/admin/clients/${gone.id}`, body);
      expect(res.status, JSON.stringify(body)).toBe(409);
      expect(res.body.code).toBe('ANONYMIZED');
    }
    expect(await auditRows()).toHaveLength(0);
  });

  it('lets only one of two parallel status changes win (the row is locked)', async () => {
    const rami = await editor();
    const account = await makeAccount(t, { rank: 'retail' });
    const answers = await Promise.all([
      rami.patch(`/admin/clients/${account.id}`, { status: 'suspended', reason: 'First request' }),
      rami.patch(`/admin/clients/${account.id}`, { status: 'suspended', reason: 'Second request' }),
    ]);
    expect(answers.map((answer) => answer.status).sort()).toEqual([200, 409]);
  });

  it('needs clients:update and a CSRF token; suspending and reactivating also need clients:security (decision 046)', async () => {
    const rami = await editor();
    const active = await makeAccount(t, { rank: 'retail' });
    const suspended = await makeAccount(t, {
      rank: 'merchant',
      status: 'suspended',
      suspendedReason: 'Fraud check',
    });
    const reader = await adminWith(t, ['clients:read', 'clients:create'], { ip: CALLER_IP });
    const noUpdate = await reader.patch(`/admin/clients/${active.id}`, { status: 'suspended', reason: 'Under review' });
    expect(noUpdate.status).toBe(403);
    expect(noUpdate.body.detail).toContain('clients:update');
    const noCsrf = await rami.withoutCsrf('PATCH', `/admin/clients/${active.id}`, {
      status: 'suspended',
      reason: 'Under review',
    });
    expect(noCsrf.body.code).toBe('CSRF_FAILED');

    const plain = await adminWith(t, ['clients:read', 'clients:update'], { ip: CALLER_IP });
    for (const [id, body] of [
      [active.id, { status: 'suspended', reason: 'Under review' }],
      [suspended.id, { status: 'active' }],
    ] as const) {
      const res = await plain.patch(`/admin/clients/${id}`, body);
      expect(res.status).toBe(403);
      expect(res.body.detail).toBe('You need the clients:security permission to do this.');
    }
    expect((await accountRow(active.id)).status).toBe('active');
    expect((await accountRow(suspended.id)).status).toBe('suspended');
    expect(await auditRows()).toHaveLength(0);
  });
});

describe('PATCH /admin/clients/:id: the rank is not a detail', () => {
  it('answers 422 use_rank_route on groupId, alone or beside anything else, and writes nothing', async () => {
    const rami = await editor();
    const account = await makeAccount(t, { rank: 'merchant' });
    const before = await accountRow(account.id);
    for (const body of [
      { groupId: before.groupId },
      { groupId: 999_999 },
      { groupId: 1, phone: '+49 1' },
      { groupId: 1, status: 'active' },
    ]) {
      const res = await rami.patch(`/admin/clients/${account.id}`, body);
      expect(res.status, JSON.stringify(body)).toBe(422);
      expect(res.body.errors[0]).toMatchObject({ field: 'groupId', code: 'use_rank_route' });
    }
    expect(await accountRow(account.id)).toEqual(before);
    expect(await auditRows()).toHaveLength(0);
  });
});

describe('PATCH /admin/clients/:id: details', () => {
  it('edits several keys of a merchant account in one call and audits only the keys that changed', async () => {
    const api = await editor();
    const account = await makeAccount(t, { rank: 'merchant', company: 'Zain', phone: '+962 6', country: 'JO' });
    const res = await api.patch(`/admin/clients/${account.id}`, {
      name: '  Zain   Mobile  ',
      company: 'Zain', // unchanged
      phone: '+962 7 9999',
      country: 'ae',
      address: 'Abdali Boulevard, Amman',
      taxId: 'JO-123',
      internalNotes: 'Pays on Sundays.',
    });
    expect(res.status).toBe(200);
    expect(await accountRow(account.id)).toMatchObject({
      name: 'Zain Mobile',
      company: 'Zain',
      phone: '+962 7 9999',
      country: 'AE',
      address: 'Abdali Boulevard, Amman',
      taxId: 'JO-123',
      internalNotes: 'Pays on Sundays.',
    });
    const [audit] = await auditRows();
    expect(audit).toMatchObject({
      action: 'edited details of',
      entityType: 'account',
      entityId: account.id,
      entityLabel: 'Zain Mobile',
      actorName: 'Rami K.',
    });
    expect(Object.keys(audit!.before as object).sort()).toEqual(
      ['address', 'country', 'internalNotes', 'name', 'phone', 'taxId'].sort(),
    );
    expect(audit!.before).toMatchObject({ name: 'Test Merchant', country: 'JO' });
  });

  it('still writes an audit row, with nothing in before and after, when nothing changes', async () => {
    const api = await editor();
    const account = await makeAccount(t, { rank: 'retail' });
    const res = await api.patch(`/admin/clients/${account.id}`, { name: 'Test Customer' });
    expect(res.status).toBe(200);
    expect((await auditRows())[0]).toMatchObject({ action: 'edited details of', before: {}, after: {} });
  });

  it("keeps a retail account's country to one the shop sells to, and derives the currency again (422 on country)", async () => {
    const api = await editor();
    const account = await makeAccount(t, { rank: 'retail', country: 'GB' });
    const refused = await api.patch(`/admin/clients/${account.id}`, { country: 'JO' });
    expect(refused.status).toBe(422);
    expect(refused.body.errors[0]).toMatchObject({ field: 'country', code: 'unsupported' });
    expect((await accountRow(account.id)).country).toBe('GB');
    const accepted = await api.patch(`/admin/clients/${account.id}`, { country: 'de' });
    expect(accepted.status).toBe(200);
    expect(await accountRow(account.id)).toMatchObject({ country: 'DE', currency: 'USD' });
    // The stored country sent again is no change, so a window that ended since does not refuse it.
    const { db } = await testDb();
    await db.delete(s.taxRates);
    expect((await api.patch(`/admin/clients/${account.id}`, { country: 'DE', phone: '+49 2' })).status).toBe(200);
    // A merchant account may have any country.
    const merchant = await makeAccount(t, { rank: 'merchant' });
    expect((await api.patch(`/admin/clients/${merchant.id}`, { country: 'jo' })).status).toBe(200);
  });

  it('refuses a mixed body (422 on the first key of the second kind), a bad value (422 on its field) and an unknown account (404)', async () => {
    const api = await editor();
    const account = await makeAccount(t, { rank: 'merchant' });
    const mixed = await api.patch(`/admin/clients/${account.id}`, { status: 'suspended', reason: 'Fraud', phone: '1' });
    expect(mixed.status).toBe(422);
    expect(mixed.body.errors[0]).toMatchObject({ field: 'phone' });
    for (const [key, value] of [
      ['name', '   '],
      ['country', 'JOR'],
      ['email', 'not-an-email'],
      ['address', 'x'.repeat(301)],
      ['taxId', 'x'.repeat(41)],
      ['internalNotes', 'x'.repeat(2001)],
    ] as const) {
      const res = await api.patch(`/admin/clients/${account.id}`, { [key]: value });
      expect(res.status, key).toBe(422);
      expect(res.body.errors[0].field, key).toBe(key);
    }
    expect((await api.patch('/admin/clients/999999', { phone: '1' })).status).toBe(404);
    expect(await auditRows()).toHaveLength(0);
  });

  it('needs clients:update and a CSRF token', async () => {
    const account = await makeAccount(t, { rank: 'retail' });
    const reader = await adminWith(t, ['clients:read'], { ip: CALLER_IP });
    expect((await reader.patch(`/admin/clients/${account.id}`, { phone: '1' })).status).toBe(403);
    const api = await editor();
    expect((await api.withoutCsrf('PATCH', `/admin/clients/${account.id}`, { phone: '1' })).body.code).toBe(
      'CSRF_FAILED',
    );
  });

  it('keeps the sessions on a name change and sends no notice (decision 047)', async () => {
    const api = await editor();
    const account = await makeAccount(t, { rank: 'retail' });
    const session = await openSession(t, { type: 'account', id: account.id });
    expect((await api.patch(`/admin/clients/${account.id}`, { name: 'Renamed Customer' })).status).toBe(200);
    expect((await sessionRows()).find((row) => row.id === session.sessionId)!.revokedAt).toBeNull();
    expect(await notificationRows((await testDb()).db)).toHaveLength(0);
    expect((await auditRows()).at(-1)!.after).not.toHaveProperty('sessionsEnded');
  });
});

describe('PATCH /admin/clients/:id: the email of an account with a login', () => {
  it('clears the verification, uses every open link up, mails the new address once (ids only), ends the sessions and tells the old address', async () => {
    const api = await editor();
    const account = await makeAccount(t, { rank: 'retail', emailVerifiedAt: clock.now() });
    const one = await openSession(t, { type: 'account', id: account.id });
    const two = await openSession(t, { type: 'account', id: account.id });
    const reset = await openLink(account.id, 'reset', 'reset-hash');
    const verify = await openLink(account.id, 'verify_email', 'verify-hash');

    const res = await api.patch(`/admin/clients/${account.id}`, { email: 'New.Address@Example.com' });
    expect(res.status).toBe(200);
    expect(await accountRow(account.id)).toMatchObject({ email: 'new.address@example.com', emailVerifiedAt: null });

    const tokens = await tokensOf(account.id);
    const open = tokens.filter((row) => row.usedAt === null);
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ purpose: 'verify_email', createdBy: api.staffId });
    for (const used of [reset, verify]) expect(tokens.find((row) => row.id === used.id)!.usedAt).not.toBeNull();
    expect(accountLinks()).toEqual([{ kind: 'email_verification', accountId: account.id, token: expect.any(String) }]);
    const mail = (await outboxRows()).filter((row) => (row.payload as { tokenId?: number }).tokenId === open[0]!.id);
    expect(mail).toHaveLength(1);
    // Ids only: the link, its hash and the address never reach the queue.
    expect(JSON.stringify(mail[0]!.payload)).not.toMatch(/new\.address|hash|token"/i);

    // Decision 047: nobody stays signed in across the change, and the address before it is told.
    const sessions = await sessionRows();
    for (const session of [one, two])
      expect(sessions.find((row) => row.id === session.sessionId)!.revokedAt).not.toBeNull();
    const notices = (await notificationRows((await testDb()).db)).filter(
      (row) => (row.payload as { to?: string }).to === account.email,
    );
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ recipientId: account.id, channel: 'email' });
    expect(JSON.stringify(notices[0]!.payload)).not.toContain('new.address@example.com');
    const audit = (await auditRows()).at(-1)!;
    expect(audit.after).toMatchObject({ email: 'new.address@example.com', emailVerified: false, sessionsEnded: 2 });
    expect(audit.before).toMatchObject({ email: account.email });
  });

  it('mails the invitation, not a verification, when the account has no password yet; a suspended account gets no mail', async () => {
    const api = await editor();
    const invited = await makeAccount(t, { rank: 'merchant', password: null });
    expect((await api.patch(`/admin/clients/${invited.id}`, { email: 'other@example.com' })).status).toBe(200);
    expect(accountLinks()).toEqual([{ kind: 'invited', accountId: invited.id, token: expect.any(String) }]);
    expect((await tokensOf(invited.id)).filter((row) => row.usedAt === null)[0]).toMatchObject({ purpose: 'invite' });

    const suspended = await makeAccount(t, { rank: 'retail', status: 'suspended', suspendedReason: 'Fraud check' });
    expect((await api.patch(`/admin/clients/${suspended.id}`, { email: 'third@example.com' })).status).toBe(200);
    expect(accountLinks()).toHaveLength(1);
    expect((await tokensOf(suspended.id)).filter((row) => row.usedAt === null)).toHaveLength(0);
  });

  it('needs clients:security to change it, and a refused change writes and spends nothing (decision 047)', async () => {
    const account = await makeAccount(t, { rank: 'merchant', emailVerifiedAt: clock.now() });
    const plain = await adminWith(t, ['clients:read', 'clients:update'], { ip: CALLER_IP });
    const before = {
      account: await accountRow(account.id),
      tokens: await tokensOf(account.id),
      outbox: await outboxRows(),
      audit: await auditRows(),
    };
    const refused = await plain.patch(`/admin/clients/${account.id}`, { email: 'taken-over@example.com' });
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({
      code: 'FORBIDDEN',
      detail: 'You need the clients:security permission to do this.',
    });
    expect(await accountRow(account.id)).toEqual(before.account);
    expect(await tokensOf(account.id)).toEqual(before.tokens);
    expect(await outboxRows()).toEqual(before.outbox);
    expect(await auditRows()).toEqual(before.audit);
    // The other details still need only clients:update, and the same address again is no change.
    expect((await plain.patch(`/admin/clients/${account.id}`, { phone: '+962 79' })).status).toBe(200);
    expect((await plain.patch(`/admin/clients/${account.id}`, { email: account.email.toUpperCase() })).status).toBe(
      200,
    );
    // The refused call spent no point of the limiter: five changes still fit in the hour, the sixth is refused.
    const api = await editor();
    for (let i = 0; i < 5; i++) {
      expect((await api.patch(`/admin/clients/${account.id}`, { email: `mine-${i}@example.com` })).status).toBe(200);
    }
    expect((await api.patch(`/admin/clients/${account.id}`, { email: 'mine-6@example.com' })).status).toBe(429);
    expect((await accountRow(account.id)).email).toBe('mine-4@example.com');
    // The same address again is not a change: it spends no point.
    expect((await api.patch(`/admin/clients/${account.id}`, { email: 'mine-4@example.com' })).status).toBe(200);
  });

  it('refuses an address another account with a login uses, in any case (409 EMAIL_TAKEN on email), and lets only one of two parallel edits win', async () => {
    const api = await editor();
    await makeAccount(t, { rank: 'merchant', email: 'Taken@Example.com' });
    const one = await makeAccount(t, { rank: 'retail' });
    const two = await makeAccount(t, { rank: 'retail' });
    const refused = await api.patch(`/admin/clients/${one.id}`, { email: 'taken@example.COM' });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('EMAIL_TAKEN');
    expect(refused.body.errors[0]).toMatchObject({ field: 'email', code: 'taken' });
    expect((await accountRow(one.id)).email).toBe(one.email);

    const answers = await Promise.all([
      api.patch(`/admin/clients/${one.id}`, { email: 'race@example.com' }),
      api.patch(`/admin/clients/${two.id}`, { email: 'race@example.com' }),
    ]);
    expect(answers.map((answer) => answer.status).sort()).toEqual([200, 409]);
  });

  it("lets it take a guest row's address and voids that guest row's open sign-in link, leaving the guest row a guest", async () => {
    const api = await editor();
    const guest = await makeAccount(t, { rank: 'retail', guest: true, email: 'buyer@example.com' });
    const link = await openLink(guest.id, 'magic_link', 'magic-hash');
    const account = await makeAccount(t, { rank: 'retail' });
    expect((await api.patch(`/admin/clients/${account.id}`, { email: 'Buyer@Example.com' })).status).toBe(200);
    expect(await accountRow(account.id)).toMatchObject({ email: 'buyer@example.com', hasAccount: true });
    expect(await accountRow(guest.id)).toMatchObject({ hasAccount: false, email: 'buyer@example.com' });
    expect((await tokensOf(guest.id)).find((row) => row.id === link.id)!.usedAt).not.toBeNull();
  });

  it('refuses an address a blocklist check names (422 on email) and writes nothing', async () => {
    const api = await editor();
    const account = await makeAccount(t, { rank: 'retail' });
    const before = await accountRow(account.id);
    const res = await api.patch(`/admin/clients/${account.id}`, { email: BLOCKED_EMAIL });
    expect(res.status).toBe(422);
    expect(res.body.errors[0]).toMatchObject({ field: 'email', code: 'blocked' });
    expect(await accountRow(account.id)).toEqual(before);
  });
});

describe('PATCH /admin/clients/:id: the email of a guest row', () => {
  const guestApi = (api: AdminApi, id: number, body: Record<string, unknown>) =>
    api.patch(`/admin/clients/${id}`, body);

  it('needs only clients:update, sends nothing, ends nothing, and lets its old links die with the old address', async () => {
    const plain = await adminWith(t, ['clients:read', 'clients:update'], { ip: CALLER_IP });
    const guest = await makeAccount(t, { rank: 'retail', guest: true, email: 'old@example.com' });
    const link = await openLink(guest.id, 'magic_link', 'old-link');
    const res = await guestApi(plain, guest.id, { email: 'New@Example.com' });
    expect(res.status).toBe(200);
    expect(await accountRow(guest.id)).toMatchObject({ email: 'new@example.com', hasAccount: false });
    expect((await tokensOf(guest.id)).find((row) => row.id === link.id)!.usedAt).not.toBeNull();
    expect(accountLinks()).toEqual([]);
    expect(await notificationRows((await testDb()).db)).toHaveLength(0);
  });

  it("refuses another guest row's address and the address of an account with a login (409 EMAIL_TAKEN, code taken), and writes nothing", async () => {
    const api = await editor();
    await makeAccount(t, { rank: 'retail', guest: true, email: 'one@example.com' });
    const two = await makeAccount(t, { rank: 'retail', guest: true, email: 'two@example.com' });
    await makeAccount(t, { rank: 'merchant', email: 'login@example.com' });
    await makeAccount(t, { rank: 'retail', email: 'shopper@example.com' });
    const before = await accountRow(two.id);
    const refused = await guestApi(api, two.id, { email: 'ONE@example.com' });
    expect(refused.status).toBe(409);
    expect(refused.body.errors[0]).toMatchObject({ field: 'email', code: 'taken' });
    // The guest row of a login's email is the login's own guest history (its export, erasure and claim): staff cannot make one.
    for (const email of ['login@example.com', 'Shopper@Example.com']) {
      const res = await guestApi(api, two.id, { email });
      expect(res.status, email).toBe(409);
      expect(res.body.code).toBe('EMAIL_TAKEN');
      expect(res.body.errors[0]).toMatchObject({ field: 'email', code: 'taken' });
    }
    expect(await accountRow(two.id)).toEqual(before);
    expect(await auditRows()).toHaveLength(0);
  });
});
