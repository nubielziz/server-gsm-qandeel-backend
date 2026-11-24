// Integration tests of decision 052, rule seven: the public forgot-password routes run the same
// database statements for every email (a run that may keep nothing is rolled back at its end). The statements are recorded at the Postgres driver; only their texts are compared, never their values.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { schema as s } from '@src/infra/db';
import type { RequestMeta } from '@src/modules/identity';
import { CustomerPasswordService } from '@src/modules/customers/application/customer-password.service';
import { MerchantPasswordService } from '@src/modules/identity/application/merchant-password.service';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches } from '../../support/auth';
import { TestClock } from '../../support/clock';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { PORTAL_ORIGIN, clearPortalRateLimits, makeMerchant, seedPortalBasics } from '../../support/merchant-portal';
import { freshClientPrefix } from '../../support/pipeline-routes';
import { STORE_ORIGIN, clearStoreRateLimits, makeCustomer } from '../../support/store';

const clock = new TestClock('2026-11-21T09:00:00.000Z');
let t: TestApp;

beforeAll(async () => {
  t = await createTestApp({ env: { SHOP_ORIGINS: `${PORTAL_ORIGIN},${STORE_ORIGIN}` }, clock });
});
afterAll(async () => {
  await resetDb();
  await t.close();
  await closeTestDb();
});
beforeEach(async () => {
  clock.set('2026-11-21T09:00:00.000Z');
  await resetDb();
  await clearIdentityCaches(t);
  await clearPortalRateLimits(t);
  await clearStoreRateLimits(t);
  await seedPortalBasics();
});
afterEach(() => mock.restore());

/** A caller from a network of its own, so no per-network counter refuses. */
function newCaller(): RequestMeta {
  const prefix = freshClientPrefix();
  return { ip: `${prefix}::1`, limitKey: `${prefix}::/64`, userAgent: 'bun-test' };
}

/** The statements of the tables these use cases touch, and the transaction boundaries. */
const RELEVANT =
  /"(auth_tokens|outbox_events|clients|client_groups|ledger_accounts|customers|customer_credentials)"|pg_notify/;
const BOUNDARY = /^(begin|commit|rollback)\b/;

/** Runs the work and returns the texts of the statements it sent to Postgres (whitespace collapsed), in order. */
async function statementsOf(work: () => Promise<unknown>): Promise<string[]> {
  const query = spyOn(Client.prototype, 'query');
  try {
    await work();
    return query.mock.calls
      .map((call) => {
        const first: unknown = call[0];
        const text = typeof first === 'string' ? first : (first as { text?: string } | undefined)?.text;
        return (text ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
      })
      .filter((text) => RELEVANT.test(text) || BOUNDARY.test(text));
  } finally {
    query.mockRestore();
  }
}

/** The row counts a discarded run must leave unchanged. */
async function counts(): Promise<Record<string, number>> {
  const { db } = await testDb();
  return {
    authTokens: await db.$count(s.authTokens),
    outboxEvents: await db.$count(s.outboxEvents),
    clients: await db.$count(s.clients),
    ledgerAccounts: await db.$count(s.ledgerAccounts),
    customers: await db.$count(s.customers),
  };
}

/** Expects the runs to send the same statements, except their last one (`commit` for the first, `rollback` for the others). */
function expectSameWork(runs: readonly string[][]): void {
  const [kept, ...discarded] = runs;
  expect(kept!.at(-1)).toBe('commit');
  expect(kept!.some((text) => text.includes('"auth_tokens"'))).toBe(true);
  for (const run of discarded) {
    expect(run.at(-1)).toBe('rollback');
    expect(run.slice(0, -1)).toEqual(kept!.slice(0, -1));
  }
}

describe('POST /client/auth/password/forgot', () => {
  it('runs the same statements for a merchant, an unknown email, a suspended merchant and a merchant whose mail budget is spent', async () => {
    const forgot = t.app.get(MerchantPasswordService);
    const merchant = await makeMerchant(t);
    const suspended = await makeMerchant(t, { status: 'suspended' });
    const spent = await makeMerchant(t);
    for (let i = 0; i < 5; i++) await forgot.forgot(spent.email, newCaller());

    const kept = await statementsOf(() => forgot.forgot(merchant.email, newCaller()));
    const runs = [kept];
    for (const email of [`nobody-${randomUUID()}@example.com`, suspended.email, spent.email]) {
      const before = await counts();
      runs.push(await statementsOf(() => forgot.forgot(email, newCaller())));
      expect(await counts()).toEqual(before);
    }
    expectSameWork(runs);
  });
});

describe('POST /store/v1/auth/password/forgot', () => {
  it('runs the same statements for an account, an unknown email, a guest and a suspended account', async () => {
    const forgot = t.app.get(CustomerPasswordService);
    const account = await makeCustomer(t);
    const guest = await makeCustomer(t, { guest: true });
    const suspended = await makeCustomer(t, { status: 'suspended' });

    const runs = [await statementsOf(() => forgot.forgot(account.email, newCaller()))];
    for (const email of [`nobody-${randomUUID()}@example.com`, guest.email, suspended.email]) {
      const before = await counts();
      runs.push(await statementsOf(() => forgot.forgot(email, newCaller())));
      expect(await counts()).toEqual(before);
    }
    expectSameWork(runs);
  });
});
