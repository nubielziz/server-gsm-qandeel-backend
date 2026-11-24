// Integration tests of the access effects of a status or a rank change (decision 064): which sessions end, which links are voided, which API
// keys are revoked, and when an invitation is queued, on the real database and the real session, key and token services. The effects run in the
// transaction of the change, as the rank change and the status writes call them.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import { DbService, type TransactionContext, schema as s } from '@src/infra/db';
import { AccountAccessEffects, ApiKeyDirectory } from '@src/modules/identity';
import { accountLinks, captureAccountLinks } from '../../support/account-links';
import { ensureRetailGroup, makeAccount } from '../../support/accounts';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches, openSession } from '../../support/auth';
import { HOUR, TestClock } from '../../support/clock';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { insertUsd } from '../../support/fixtures';
import { clearAccountMailLimits } from '../../support/identity-mail';
import { insertApiKey } from '../../support/machine-auth';

const clock = new TestClock();
let t: TestApp;

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

const effects = () => t.app.get(AccountAccessEffects);
/** Runs a change's effects in one transaction, as the use cases of the status and rank changes do. */
const inTransaction = <T>(run: (work: TransactionContext) => Promise<T>) => t.app.get(DbService).runInTransaction(run);

const sessionRevoked = async (sessionId: number) => {
  const { db } = await testDb();
  const [row] = await db.select().from(s.sessions).where(eq(s.sessions.id, sessionId));
  return row!.revokedAt !== null;
};
const keyRevoked = async (keyId: number) => {
  const { db } = await testDb();
  const [row] = await db.select().from(s.apiKeys).where(eq(s.apiKeys.id, keyId));
  return row!.revokedAt !== null;
};
const openLinksOf = async (accountId: number) => {
  const { db } = await testDb();
  const rows = await db
    .select()
    .from(s.authTokens)
    .where(and(eq(s.authTokens.subjectType, 'account'), eq(s.authTokens.subjectId, accountId)));
  return rows.filter((row) => row.usedAt === null);
};
const openLink = async (accountId: number, purpose: 'reset' | 'magic_link', hash: string) => {
  const { db } = await testDb();
  await db.insert(s.authTokens).values({
    purpose,
    subjectType: 'account',
    subjectId: accountId,
    tokenHash: hash.padEnd(64, '0'),
    expiresAt: new Date(clock.nowMs() + HOUR),
  });
};

describe('rankChanged', () => {
  it("across kinds ends every session of the account, and no other account's", async () => {
    const account = await makeAccount(t, { rank: 'retail' });
    const other = await makeAccount(t, { rank: 'retail' });
    const one = await openSession(t, { type: 'account', id: account.id });
    const step = await openSession(t, { type: 'account', id: account.id }, { stage: 'pending_totp' });
    const otherSession = await openSession(t, { type: 'account', id: other.id });
    const result = await inTransaction((work) =>
      effects().rankChanged(work, { accountId: account.id, fromKind: 'retail', toKind: 'merchant' }),
    );
    expect(result).toEqual({ sessionsEnded: 2, keysRevoked: 0, invited: false });
    expect(await sessionRevoked(one.sessionId)).toBe(true);
    expect(await sessionRevoked(step.sessionId)).toBe(true);
    expect(await sessionRevoked(otherSession.sessionId)).toBe(false);
  });

  it('to a merchant rank queues an invitation for an account without a password, and for none that has one', async () => {
    const withoutPassword = await makeAccount(t, { rank: 'retail', password: null });
    const withPassword = await makeAccount(t, { rank: 'retail' });
    const first = await inTransaction((work) =>
      effects().rankChanged(work, { accountId: withoutPassword.id, fromKind: 'retail', toKind: 'merchant' }),
    );
    const second = await inTransaction((work) =>
      effects().rankChanged(work, { accountId: withPassword.id, fromKind: 'retail', toKind: 'merchant' }),
    );
    expect(first.invited).toBe(true);
    expect(second.invited).toBe(false);
    expect(accountLinks().map((l) => [l.kind, l.accountId])).toEqual([['invited', withoutPassword.id]]);
    const [token] = await openLinksOf(withoutPassword.id);
    expect(token).toMatchObject({ purpose: 'invite', expiresAt: new Date(clock.nowMs() + HOUR) });
    expect(await openLinksOf(withPassword.id)).toEqual([]);
    const { db } = await testDb();
    const mails = (await db.select().from(s.outboxEvents)).filter(
      (row) => (row.payload as { tokenId?: number }).tokenId === token!.id,
    );
    expect(mails).toHaveLength(1);
  });

  it("out of the merchant kind revokes every live API key of the account and no other account's, and drops their cached views", async () => {
    const merchant = await makeAccount(t, { rank: 'merchant' });
    const other = await makeAccount(t, { rank: 'merchant' });
    const { db } = await testDb();
    const first = await insertApiKey(t, db, merchant.id);
    const second = await insertApiKey(t, db, merchant.id);
    const already = await insertApiKey(t, db, merchant.id, { revokedAt: clock.now() });
    const others = await insertApiKey(t, db, other.id);
    const session = await openSession(t, { type: 'account', id: merchant.id });
    const directory = t.app.get(ApiKeyDirectory);
    expect(await directory.findByKey(first.key)).toBeDefined();

    const result = await inTransaction((work) =>
      effects().rankChanged(work, { accountId: merchant.id, fromKind: 'merchant', toKind: 'retail' }),
    );
    expect(result).toEqual({ sessionsEnded: 1, keysRevoked: 2, invited: false });
    expect(await keyRevoked(first.id)).toBe(true);
    expect(await keyRevoked(second.id)).toBe(true);
    expect(await keyRevoked(already.id)).toBe(true);
    expect(await keyRevoked(others.id)).toBe(false);
    expect(await sessionRevoked(session.sessionId)).toBe(true);
    // The cached view of a revoked key is gone: the next read sees the revocation.
    expect((await directory.findByKey(first.key))!.revokedAtMs).not.toBeNull();
  });

  it('inside one kind only drops the cached views: sessions and keys stay, nothing is queued', async () => {
    const merchant = await makeAccount(t, { rank: 'merchant', password: null });
    const { db } = await testDb();
    const key = await insertApiKey(t, db, merchant.id);
    const session = await openSession(t, { type: 'account', id: merchant.id });
    const result = await inTransaction((work) =>
      effects().rankChanged(work, { accountId: merchant.id, fromKind: 'merchant', toKind: 'merchant' }),
    );
    expect(result).toEqual({ sessionsEnded: 0, keysRevoked: 0, invited: false });
    expect(await keyRevoked(key.id)).toBe(false);
    expect(await sessionRevoked(session.sessionId)).toBe(false);
    expect(accountLinks()).toEqual([]);
  });

  it('is part of the change: a transaction that rolls back ends nothing and revokes nothing', async () => {
    const merchant = await makeAccount(t, { rank: 'merchant' });
    const { db } = await testDb();
    const key = await insertApiKey(t, db, merchant.id);
    const session = await openSession(t, { type: 'account', id: merchant.id });
    const failed = await inTransaction(async (work) => {
      await effects().rankChanged(work, { accountId: merchant.id, fromKind: 'merchant', toKind: 'retail' });
      throw new Error('the change failed after its effects');
    }).catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(Error);
    expect((failed as Error).message).toContain('the change failed');
    expect(await keyRevoked(key.id)).toBe(false);
    expect(await sessionRevoked(session.sessionId)).toBe(false);
  });
});

describe('statusChanged', () => {
  it.each(['suspended', 'blocked'] as const)(
    'to %s ends every session and voids every open link, and keeps the API keys (they answer as not active)',
    async (to) => {
      const merchant = await makeAccount(t, { rank: 'merchant' });
      const { db } = await testDb();
      const key = await insertApiKey(t, db, merchant.id);
      const session = await openSession(t, { type: 'account', id: merchant.id });
      await openLink(merchant.id, 'reset', 'reset-link');
      const directory = t.app.get(ApiKeyDirectory);
      expect((await directory.findByKey(key.key))!.client.status).toBe('active');
      // The status is written by the caller before the effects run.
      await db.update(s.clients).set({ status: to }).where(eq(s.clients.id, merchant.id));

      const result = await inTransaction((work) => effects().statusChanged(work, { accountId: merchant.id, to }));
      expect(result).toEqual({ sessionsEnded: 1, keysRevoked: 0 });
      expect(await sessionRevoked(session.sessionId)).toBe(true);
      expect(await openLinksOf(merchant.id)).toEqual([]);
      expect(await keyRevoked(key.id)).toBe(false);
      expect((await directory.findByKey(key.key))!.client.status).toBe(to);
    },
  );

  it('to anonymized also revokes every live API key', async () => {
    const merchant = await makeAccount(t, { rank: 'merchant' });
    const { db } = await testDb();
    const key = await insertApiKey(t, db, merchant.id);
    const session = await openSession(t, { type: 'account', id: merchant.id });
    const result = await inTransaction((work) =>
      effects().statusChanged(work, { accountId: merchant.id, to: 'anonymized' }),
    );
    expect(result).toEqual({ sessionsEnded: 1, keysRevoked: 1 });
    expect(await keyRevoked(key.id)).toBe(true);
    expect(await sessionRevoked(session.sessionId)).toBe(true);
  });

  it('back to active ends nothing, revokes nothing and drops the cached views', async () => {
    const merchant = await makeAccount(t, { rank: 'merchant', status: 'suspended', suspendedReason: 'Fraud check' });
    const { db } = await testDb();
    const key = await insertApiKey(t, db, merchant.id);
    const session = await openSession(t, { type: 'account', id: merchant.id });
    const directory = t.app.get(ApiKeyDirectory);
    expect((await directory.findByKey(key.key))!.client.status).toBe('suspended');
    await db.update(s.clients).set({ status: 'active', suspendedReason: null }).where(eq(s.clients.id, merchant.id));
    const result = await inTransaction((work) =>
      effects().statusChanged(work, { accountId: merchant.id, to: 'active' }),
    );
    expect(result).toEqual({ sessionsEnded: 0, keysRevoked: 0 });
    expect(await keyRevoked(key.id)).toBe(false);
    expect(await sessionRevoked(session.sessionId)).toBe(false);
    expect((await directory.findByKey(key.key))!.client.status).toBe('active');
  });

  it('works the same for a retail account (no keys to revoke)', async () => {
    const retail = await makeAccount(t, { rank: 'retail' });
    const session = await openSession(t, { type: 'account', id: retail.id });
    await openLink(retail.id, 'magic_link', 'sign-in-link');
    const result = await inTransaction((work) =>
      effects().statusChanged(work, { accountId: retail.id, to: 'suspended' }),
    );
    expect(result).toEqual({ sessionsEnded: 1, keysRevoked: 0 });
    expect(await sessionRevoked(session.sessionId)).toBe(true);
    expect(await openLinksOf(retail.id)).toEqual([]);
  });
});
