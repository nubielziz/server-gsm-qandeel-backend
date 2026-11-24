// Integration tests of the unsubscribe links sent before the accounts were merged (decision 064): the token of a marketing mail that
// signed `marketing-unsubscribe:customer:<n>` names an old customer number, never an account id. It is read only through the legacy id map
// (`LegacyAccounts.resolve('customer', n)`): it withdraws marketing of the account that customer became and touches nobody else (the
// merchant that kept the number n included), a new token for the account with the number n is another token, and an old number the map does not
// know changes nothing and answers the same 204. Real Postgres; the route is public.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { TokenService } from '@src/infra/crypto';
import { type Database, schema as s } from '@src/infra/db';
import { marketingUnsubscribeToken } from '@src/modules/platform';
import { makeAccount } from '../../support/accounts';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches, insertMerchant } from '../../support/auth';
import { TestClock } from '../../support/clock';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { mapLegacyCustomer } from '../../support/legacy-accounts';
import { STORE_ORIGIN } from '../../support/store';

const clock = new TestClock('2026-11-10T09:00:00.000Z');
let t: TestApp;
let db: Database;

/** The token a mail carried before the release: the same format, signed under the old prefix with the same key. */
const oldToken = (customerNumber: number): string =>
  `${customerNumber.toString(36)}.${t.app.get(TokenService).lookupHash(`marketing-unsubscribe:customer:${customerNumber}`).slice(0, 32)}`;
const newToken = (accountId: number): string => marketingUnsubscribeToken(t.app.get(TokenService), accountId);

const consents = (accountId: number) =>
  db.select().from(s.consentRecords).where(eq(s.consentRecords.subjectId, accountId)).orderBy(s.consentRecords.id);
const optIn = async (accountId: number) =>
  (await db.select({ marketingOptIn: s.clients.marketingOptIn }).from(s.clients).where(eq(s.clients.id, accountId)))[0]!
    .marketingOptIn;

/** What a mailbox provider or the site's page sends: no session, no CSRF token, no anti-bot token. */
function unsubscribe(token: string) {
  return t.app.inject({
    method: 'POST',
    url: `/store/v1/marketing/unsubscribe/${token}`,
    headers: { origin: STORE_ORIGIN, 'user-agent': 'Mailbox-Provider/1.0' },
    remoteAddress: '203.0.113.9',
  });
}

/** A consent as the account page records it: the switch and the proof. */
async function agree(accountId: number): Promise<void> {
  await db.update(s.clients).set({ marketingOptIn: true }).where(eq(s.clients.id, accountId));
  await db.insert(s.consentRecords).values({
    subjectType: 'account',
    subjectId: accountId,
    purpose: 'marketing',
    granted: true,
    ip: '',
    createdAt: clock.now(),
  });
}

beforeAll(async () => {
  t = await createTestApp({ clock });
  db = (await testDb()).db;
});
beforeEach(async () => {
  clock.set('2026-11-10T09:00:00.000Z');
  await resetDb();
  await clearIdentityCaches(t);
});
afterAll(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await t.close();
  await closeTestDb();
});

describe('a pre-release unsubscribe token', () => {
  it('withdraws the marketing of the account the old customer became and leaves the merchant with the same number untouched', async () => {
    // Merchant n kept its number; the old customer number n became another account.
    const merchantId = await insertMerchant(db, { marketingOptIn: true });
    const converted = await makeAccount({ db, rank: 'retail', password: null, email: 'dana@mail.example' });
    expect(converted.id).not.toBe(merchantId);
    await mapLegacyCustomer(db, merchantId, converted.id);
    await agree(converted.id);
    await agree(merchantId);

    const res = await unsubscribe(oldToken(merchantId));
    expect(res.statusCode).toBe(204);

    expect(await optIn(converted.id)).toBe(false);
    const records = await consents(converted.id);
    expect(records).toHaveLength(2);
    expect(records[1]).toMatchObject({
      subjectType: 'account',
      subjectId: converted.id,
      purpose: 'marketing',
      granted: false,
      ip: '203.0.113.9',
      userAgent: 'Mailbox-Provider/1.0',
    });
    // The merchant has the number the old link names, but it is not that person: nothing of it changed.
    expect(await optIn(merchantId)).toBe(true);
    expect(await consents(merchantId)).toHaveLength(1);
    // A second click changes nothing and writes nothing.
    expect((await unsubscribe(oldToken(merchantId))).statusCode).toBe(204);
    expect(await consents(converted.id)).toHaveLength(2);
  });

  it('is another token than the new one of the account with the same number, and each token names its own person', async () => {
    const merchantId = await insertMerchant(db, { marketingOptIn: true });
    const converted = await makeAccount({ db, rank: 'retail', password: null });
    await mapLegacyCustomer(db, merchantId, converted.id);
    await agree(converted.id);
    await agree(merchantId);
    expect(newToken(merchantId)).not.toBe(oldToken(merchantId));
    // The new token for account n names account n (the merchant); the converted account is not touched by it.
    expect((await unsubscribe(newToken(merchantId))).statusCode).toBe(204);
    expect(await optIn(merchantId)).toBe(false);
    expect(await optIn(converted.id)).toBe(true);
    // The new token of the converted account names it by its account id.
    expect((await unsubscribe(newToken(converted.id))).statusCode).toBe(204);
    expect(await optIn(converted.id)).toBe(false);
    expect(await consents(converted.id)).toHaveLength(2);
  });

  it('changes nothing for an old number the map does not know, and answers the same 204 as for a known one', async () => {
    const first = await makeAccount({ db, rank: 'retail', password: null });
    const second = await makeAccount({ db, rank: 'retail', password: null });
    await agree(first.id);
    await agree(second.id);
    // No map row: the old number of the token is neither account's id, and the id of an account is not an old number.
    for (const number of [first.id, second.id, 987_654]) {
      expect((await unsubscribe(oldToken(number))).statusCode, String(number)).toBe(204);
    }
    expect(await optIn(first.id)).toBe(true);
    expect(await optIn(second.id)).toBe(true);
    expect(await consents(first.id)).toHaveLength(1);
    expect(await consents(second.id)).toHaveLength(1);
  });

  it('changes nothing when the map leads to an erased account, and refuses a token of another key with 410', async () => {
    const gone = await makeAccount({
      db,
      rank: 'retail',
      password: null,
      status: 'anonymized',
      anonymizedAt: clock.now(),
    });
    await mapLegacyCustomer(db, 4242, gone.id);
    expect((await unsubscribe(oldToken(4242))).statusCode).toBe(204);
    expect(await consents(gone.id)).toHaveLength(0);
    // A token whose MAC fits neither prefix is not a token: 410, as for a new token.
    const [id] = oldToken(4242).split('.') as [string];
    expect((await unsubscribe(`${id}.${'0'.repeat(32)}`)).statusCode).toBe(410);
  });
});
