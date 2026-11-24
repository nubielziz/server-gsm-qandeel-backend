// Integration tests of the one-time links of accounts (decision 064, decisions 019 and 052): one service for every rank issues, takes,
// rotates and voids them. The rows are of the subject type `account`, hold only a keyed hash, last one hour and work once; a link of
// another subject type or another purpose is not found; two requests with one link cannot both spend it.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { asc, eq } from 'drizzle-orm';
import { TokenService } from '@src/infra/crypto';
import { DbService, type TransactionContext, schema as s } from '@src/infra/db';
import { MerchantAuthTokens } from '@src/modules/identity';
import { AccountAuthTokenService } from '@src/modules/identity/application/account-auth-tokens';
import { AccountAuthTokens } from '@src/modules/identity/ports/account-auth-tokens';
import { makeAccount } from '../../support/accounts';
import { type TestApp, createTestApp } from '../../support/app';
import { HOUR, TestClock } from '../../support/clock';
import { closeTestDb, resetDb, testDb } from '../../support/db';

const clock = new TestClock('2026-11-07T10:00:00.000Z');
let t: TestApp;

beforeAll(async () => {
  t = await createTestApp({ clock });
});
afterAll(async () => {
  await resetDb();
  await t.close();
  await closeTestDb();
});
beforeEach(async () => {
  clock.set('2026-11-07T10:00:00.000Z');
  await resetDb();
});

const tokens = () => t.app.get(AccountAuthTokenService);
const inTx = <T>(fn: (work: TransactionContext) => Promise<T>) => t.app.get(DbService).runInTransaction(fn);
const rowsOf = async (accountId: number) =>
  (await testDb()).db
    .select()
    .from(s.authTokens)
    .where(eq(s.authTokens.subjectId, accountId))
    .orderBy(asc(s.authTokens.id));

describe('the port resolves to the one service', () => {
  it('is the instance the services inject', () => {
    expect(t.app.get(AccountAuthTokens)).toBe(tokens());
  });
});

describe('issue', () => {
  it('stores a link of the subject type account: the keyed hash only, one hour, the sender and the address', async () => {
    const account = await makeAccount(t, { rank: 'retail', password: null });
    const other = await makeAccount(t, { rank: 'merchant' });
    const issued = await inTx((work) =>
      tokens().issue(work, { accountId: account.id, purpose: 'invite', createdBy: null, ip: '203.0.113.9' }),
    );
    expect(issued.token.length).toBeGreaterThanOrEqual(43);
    const [row] = await rowsOf(account.id);
    expect(row).toMatchObject({
      id: issued.tokenId,
      purpose: 'invite',
      subjectType: 'account',
      subjectId: account.id,
      usedAt: null,
      ip: '203.0.113.9',
      createdBy: null,
      browserHash: null,
    });
    expect(row!.tokenHash).toBe(t.app.get(TokenService).hash(issued.token));
    expect(row!.tokenHash).not.toContain(issued.token);
    expect(row!.createdAt.getTime()).toBe(clock.nowMs());
    expect(row!.expiresAt.getTime()).toBe(clock.nowMs() + HOUR);
    expect(issued.expiresAt.getTime()).toBe(clock.nowMs() + HOUR);
    expect(await rowsOf(other.id)).toEqual([]);
  });

  it('lets only the newest invitation or reset link work, and keeps the other families apart', async () => {
    const account = await makeAccount(t, { rank: 'retail', password: null });
    await inTx(async (work) => {
      await tokens().issue(work, { accountId: account.id, purpose: 'invite' });
      await tokens().issue(work, { accountId: account.id, purpose: 'verify_email' });
      await tokens().issue(work, { accountId: account.id, purpose: 'magic_link' });
      await tokens().issue(work, { accountId: account.id, purpose: 'reset' });
    });
    const open = (await rowsOf(account.id)).filter((row) => row.usedAt === null).map((row) => row.purpose);
    // The reset replaced the invitation (one family); the verification and the sign-in link are families of their own.
    expect(open.sort()).toEqual(['magic_link', 'reset', 'verify_email']);
  });

  it('keeps the two newest earlier links of a family for a link the visitor asked for: at most three work at once', async () => {
    const account = await makeAccount(t, { rank: 'retail', password: null });
    for (let i = 0; i < 5; i++) {
      await inTx((work) => tokens().issue(work, { accountId: account.id, purpose: 'reset', keepEarlier: true }));
      clock.advance(1000);
    }
    const open = (await rowsOf(account.id)).filter((row) => row.usedAt === null);
    expect(open).toHaveLength(3);
    // A link nobody asked for replaces them all.
    await inTx((work) => tokens().issue(work, { accountId: account.id, purpose: 'reset' }));
    expect((await rowsOf(account.id)).filter((row) => row.usedAt === null)).toHaveLength(1);
  });

  it('stores the asking browser only on a sign-in link, as a keyed hash, and tells that browser from another', async () => {
    const account = await makeAccount(t, { rank: 'retail', password: null });
    const link = await inTx((work) =>
      tokens().issue(work, { accountId: account.id, purpose: 'magic_link', browserKey: 'browser-cookie-value' }),
    );
    const other = await inTx((work) =>
      tokens().issue(work, { accountId: account.id, purpose: 'reset', browserKey: 'browser-cookie-value' }),
    );
    const rows = await rowsOf(account.id);
    const magic = rows.find((row) => row.id === link.tokenId)!;
    expect(magic.browserHash).toBe(t.app.get(TokenService).hash('browser-cookie-value'));
    expect(rows.find((row) => row.id === other.tokenId)!.browserHash).toBeNull();
    expect(tokens().askedFrom(magic, 'browser-cookie-value')).toBe(true);
    expect(tokens().askedFrom(magic, 'another-browser')).toBe(false);
    expect(tokens().askedFrom(magic, undefined)).toBe(false);
  });
});

describe('take', () => {
  it('finds an unused, unexpired link of an accepted purpose and says whose it is', async () => {
    const account = await makeAccount(t, { rank: 'merchant', password: null });
    const issued = await inTx((work) => tokens().issue(work, { accountId: account.id, purpose: 'invite' }));
    const taken = await inTx((work) => tokens().take(work.tx, issued.token, ['invite', 'reset']));
    expect(taken).toMatchObject({ tokenId: issued.tokenId, accountId: account.id, purpose: 'invite' });
    // Taking does not spend: the caller marks the link used in its own transaction.
    expect((await rowsOf(account.id))[0]!.usedAt).toBeNull();
  });

  it('finds nothing for an unknown token, another purpose, a used link, an expired link or another subject type', async () => {
    const account = await makeAccount(t, { rank: 'retail', password: null });
    const issued = await inTx((work) => tokens().issue(work, { accountId: account.id, purpose: 'verify_email' }));
    const take = (token: string, purposes: Parameters<AccountAuthTokens['take']>[2]) =>
      inTx((work) => tokens().take(work.tx, token, purposes));
    expect(await take('A'.repeat(43), ['verify_email'])).toBeUndefined();
    expect(await take(issued.token, ['reset', 'invite'])).toBeUndefined();

    // The id spaces of staff and accounts overlap: a staff member's link is never an account's.
    const { db } = await testDb();
    await db.update(s.authTokens).set({ subjectType: 'staff' }).where(eq(s.authTokens.id, issued.tokenId));
    expect(await take(issued.token, ['verify_email'])).toBeUndefined();
    await db.update(s.authTokens).set({ subjectType: 'account' }).where(eq(s.authTokens.id, issued.tokenId));
    expect(await take(issued.token, ['verify_email'])).toBeDefined();

    clock.advance(HOUR);
    expect(await take(issued.token, ['verify_email'])).toBeUndefined();
    clock.set('2026-11-07T10:00:00.000Z');
    await inTx((work) => tokens().voidOpenOf(work.tx, account.id));
    expect(await take(issued.token, ['verify_email'])).toBeUndefined();
  });

  it('lets only one of two parallel requests spend the link', async () => {
    const account = await makeAccount(t, { rank: 'retail', password: null });
    const issued = await inTx((work) => tokens().issue(work, { accountId: account.id, purpose: 'reset' }));
    const spend = () =>
      inTx(async (work) => {
        const taken = await tokens().take(work.tx, issued.token, ['reset']);
        if (taken === undefined) return false;
        await tokens().voidOpenOf(work.tx, taken.accountId, ['invite', 'reset']);
        return true;
      });
    const results = await Promise.all([spend(), spend()]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });
});

describe('voidOpenOf', () => {
  it('voids the open links of the account of the given purposes, counts them, and touches no other account', async () => {
    const account = await makeAccount(t, { rank: 'retail', password: null });
    const other = await makeAccount(t, { rank: 'retail', password: null });
    await inTx(async (work) => {
      await tokens().issue(work, { accountId: account.id, purpose: 'magic_link' });
      await tokens().issue(work, { accountId: account.id, purpose: 'verify_email' });
      await tokens().issue(work, { accountId: account.id, purpose: 'reset' });
      await tokens().issue(work, { accountId: other.id, purpose: 'magic_link' });
    });
    expect(await inTx((work) => tokens().voidOpenOf(work.tx, account.id, ['magic_link']))).toBe(1);
    expect(await inTx((work) => tokens().voidOpenOf(work.tx, account.id, ['magic_link']))).toBe(0);
    // Without a list every purpose goes: the open links of an account that was suspended or whose email changed.
    expect(await inTx((work) => tokens().voidOpenOf(work.tx, account.id))).toBe(2);
    expect((await rowsOf(account.id)).every((row) => row.usedAt !== null)).toBe(true);
    expect((await rowsOf(other.id))[0]!.usedAt).toBeNull();
  });

  it('voids the open sign-in link of the guest row of an email', async () => {
    const guest = await makeAccount(t, { rank: 'retail', guest: true });
    await inTx((work) => tokens().issue(work, { accountId: guest.id, purpose: 'magic_link' }));
    expect(await inTx((work) => tokens().voidOpenOf(work.tx, guest.id, ['magic_link']))).toBe(1);
  });
});

describe('rotate, consume and the staff list time', () => {
  it('replaces the secret of a usable link only, keeping the row and its expiry', async () => {
    const account = await makeAccount(t, { rank: 'retail', password: null });
    const issued = await inTx((work) => tokens().issue(work, { accountId: account.id, purpose: 'invite' }));
    const rotated = await tokens().rotate(issued.tokenId);
    expect(rotated).toBeDefined();
    expect(rotated).not.toBe(issued.token);
    const [row] = await rowsOf(account.id);
    expect(row!.tokenHash).toBe(t.app.get(TokenService).hash(rotated!));
    expect(row!.expiresAt.getTime()).toBe(issued.expiresAt.getTime());
    expect(await inTx((work) => tokens().take(work.tx, issued.token, ['invite']))).toBeUndefined();

    expect(await inTx((work) => tokens().consume(work, issued.tokenId))).toBe(true);
    expect(await inTx((work) => tokens().consume(work, issued.tokenId))).toBe(false);
    expect(await tokens().rotate(issued.tokenId)).toBeUndefined();
  });

  it('reads when the newest invitation or reset link was created', async () => {
    const account = await makeAccount(t, { rank: 'retail', password: null });
    expect(await tokens().passwordLinkSentAt(account.id)).toBeNull();
    await inTx((work) => tokens().issue(work, { accountId: account.id, purpose: 'verify_email' }));
    expect(await tokens().passwordLinkSentAt(account.id)).toBeNull();
    clock.advance(5000);
    await inTx((work) => tokens().issue(work, { accountId: account.id, purpose: 'invite' }));
    expect((await tokens().passwordLinkSentAt(account.id))?.getTime()).toBe(clock.nowMs());
  });
});

describe('the merchant compatibility class (until the contract release)', () => {
  it('writes the same rows as the service, under the old input and answer', async () => {
    const merchant = await makeAccount(t, { rank: 'merchant', password: null });
    const issued = await inTx((work) =>
      t.app.get(MerchantAuthTokens).issue(work, { clientId: merchant.id, purpose: 'invite', ip: '203.0.113.9' }),
    );
    const [row] = await rowsOf(merchant.id);
    expect(row).toMatchObject({ id: issued.id, purpose: 'invite', subjectType: 'account', ip: '203.0.113.9' });
    expect(row!.tokenHash).toBe(t.app.get(TokenService).hash(issued.token));
    expect(await inTx((work) => tokens().take(work.tx, issued.token, ['invite']))).toMatchObject({
      accountId: merchant.id,
    });
  });
});
