// Integration tests of the answer of `POST /store/v1/auth/verify` (decision 064): the account the link opened as `AccountMe`, whether this
// browser asked for it, the next step, and the optional claim of the orders of the guest row of the same email (`claimGuestOrders`).
// The exchange itself (and the claim's locks and its `busy` answer) is tested with the link sign-in service.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { eq } from 'drizzle-orm';
import { schema as s } from '@src/infra/db';
import { type TestApp, createTestApp } from '../../support/app';
import { makeAccount } from '../../support/accounts';
import { clearIdentityCaches } from '../../support/auth';
import { TestClock } from '../../support/clock';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { insertAnyService, insertCustomerOrder, insertStoreCurrencies } from '../../support/customers';
import { freshClientIp } from '../../support/pipeline-routes';
import {
  STORE_ORIGIN,
  StoreClient,
  captureCustomerLinks,
  clearStoreRateLimits,
  customerLinks,
} from '../../support/store';

const clock = new TestClock('2026-11-07T10:00:00.000Z');
let t: TestApp;

beforeAll(async () => {
  t = await createTestApp({ env: { CORS_ORIGINS: STORE_ORIGIN }, clock });
});
afterAll(async () => {
  await resetDb();
  await t.close();
  await closeTestDb();
});
beforeEach(async () => {
  clock.set('2026-11-07T10:00:00.000Z');
  await resetDb();
  await clearIdentityCaches(t);
  await clearStoreRateLimits(t);
  captureCustomerLinks(t);
  await insertStoreCurrencies((await testDb()).db);
});
afterEach(() => mock.restore());

/** Asks for a sign-in link as a browser and returns that browser with the token of the link. */
async function askForLink(email: string) {
  const client = new StoreClient(t, freshClientIp());
  expect((await client.magicLink(email)).statusCode).toBe(204);
  const link = customerLinks()
    .filter((candidate) => candidate.kind === 'magic_link')
    .at(-1);
  expect(link, 'a sign-in link was made for the email').toBeDefined();
  return { client, token: link!.token };
}

describe('POST /store/v1/auth/verify', () => {
  it('answers AccountMe of the account the link opened, with the browser, the masked address and the next step', async () => {
    const retail = await makeAccount(t, { rank: 'retail', password: null, name: 'Daniel Whitmore' });
    const { client, token } = await askForLink(retail.email);

    const res = await client.verify(token);
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.json()).toMatchObject({
      id: retail.id,
      name: 'Daniel Whitmore',
      email: retail.email,
      status: 'active',
      username: '',
      company: '',
      rank: { id: retail.groupId, kind: 'retail' },
      requestedHere: true,
      maskedEmail: expect.any(String),
      next: 'done',
      claimedOrders: 0,
    });
    expect(res.json()).not.toHaveProperty('claimSkipped');
    expect(client.sessionToken).toBeString();
  });

  it('moves the orders of the guest row of the same email only when the box was ticked', async () => {
    const { db } = await testDb();
    const serviceId = await insertAnyService(db);
    const retail = await makeAccount(t, { rank: 'retail', password: null });
    const guest = await makeAccount(t, { rank: 'retail', guest: true, email: retail.email });
    const orderId = await insertCustomerOrder(db, serviceId, guest.id);

    const untouched = await askForLink(retail.email);
    const without = await untouched.client.verify(untouched.token);
    expect(without.statusCode).toBe(200);
    expect(without.json()).toMatchObject({ claimedOrders: 0 });
    expect((await db.select().from(s.orders).where(eq(s.orders.id, orderId)))[0]!.accountId).toBe(guest.id);

    const claiming = await askForLink(retail.email);
    const withBox = await claiming.client.call('POST', '/store/v1/auth/verify', {
      token: claiming.token,
      claimGuestOrders: true,
    });
    expect(withBox.statusCode).toBe(200);
    expect(withBox.json()).toMatchObject({ id: retail.id, claimedOrders: expect.any(Number) });
    expect(withBox.json<{ claimedOrders: number }>().claimedOrders).toBeGreaterThanOrEqual(1);
    expect((await db.select().from(s.orders).where(eq(s.orders.id, orderId)))[0]!.accountId).toBe(retail.id);
  });

  it('answers 410 TOKEN_INVALID for a link that is unknown', async () => {
    const client = new StoreClient(t, freshClientIp());
    const res = await client.verify('k3Jx9Qd7mT2vN8bR5yHc1WzA4uLsE6oPgF0iVtXnDqM');
    expect(res.statusCode).toBe(410);
    expect(res.json<{ code: string }>().code).toBe('TOKEN_INVALID');
  });
});
