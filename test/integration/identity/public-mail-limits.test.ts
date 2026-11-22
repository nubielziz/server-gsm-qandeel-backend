// Integration tests of decision 052, rule three: the mails a visitor can ask for (merchant and customer forgot password, the customer
// sign-in link) are capped per recipient (five an hour per kind, apart from the mails staff send; beyond it the answer is the same
// 204 and nothing is sent), and asking again does not void the link sent before (at most three work at once; the oldest goes first).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { and, eq, isNull } from 'drizzle-orm';
import type { LightMyRequestResponse } from 'fastify';
import { schema as s } from '@src/infra/db';
import { adminWith } from '../../support/admin-api';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches } from '../../support/auth';
import { TestClock } from '../../support/clock';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import {
  MerchantPortal,
  PORTAL_ORIGIN,
  captureEmailedLinks,
  clearPortalRateLimits,
  clientRow,
  emailedLinks,
  makeMerchant,
  seedPortalBasics,
} from '../../support/merchant-portal';
import { freshClientPrefix } from '../../support/pipeline-routes';
import { CONSOLE_ORIGIN } from '../../support/staff-console';
import {
  STORE_ORIGIN,
  StoreClient,
  captureCustomerLinks,
  clearStoreRateLimits,
  customerLinks,
  makeCustomer,
} from '../../support/store';

const clock = new TestClock('2026-11-21T09:00:00.000Z');
let t: TestApp;

beforeAll(async () => {
  t = await createTestApp({
    env: { CONSOLE_ORIGINS: CONSOLE_ORIGIN, SHOP_ORIGINS: `${PORTAL_ORIGIN},${STORE_ORIGIN}` },
    clock,
  });
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
  captureEmailedLinks(t);
  captureCustomerLinks(t);
});
afterEach(() => mock.restore());

/** An address in a network of its own, so the per-network counter never refuses. */
const stranger = () => `${freshClientPrefix()}::1`;
const outboxCount = async (type: string) => (await testDb()).db.$count(s.outboxEvents, eq(s.outboxEvents.type, type));
const liveTokens = async (subjectType: 'client' | 'customer', subjectId: number) =>
  (await testDb()).db
    .select()
    .from(s.authTokens)
    .where(
      and(
        eq(s.authTokens.subjectType, subjectType),
        eq(s.authTokens.subjectId, subjectId),
        isNull(s.authTokens.usedAt),
      ),
    );

/** One flow a visitor can start for an email, and how to use the link it mails. */
interface MailFlow {
  readonly name: string;
  readonly event: string;
  readonly subjectType: 'client' | 'customer';
  readonly account: () => Promise<{ id: number; email: string }>;
  readonly ask: (email: string) => Promise<LightMyRequestResponse>;
  readonly links: () => string[];
  readonly use: (token: string) => Promise<LightMyRequestResponse>;
  /** The status of a link that worked. */
  readonly used: number;
}

let passwords = 0;
const nextPassword = () => `a-long-new-passphrase-${++passwords}`;

const FLOWS: readonly MailFlow[] = [
  {
    name: 'merchant forgot password',
    event: 'merchant.password_reset',
    subjectType: 'client',
    account: () => makeMerchant(t),
    ask: (email) => new MerchantPortal(t, stranger()).forgot(email),
    links: () =>
      emailedLinks()
        .filter((link) => link.kind === 'password_reset')
        .map((link) => link.token),
    use: (token) => new MerchantPortal(t, stranger()).reset(token, nextPassword()),
    used: 204,
  },
  {
    name: 'customer forgot password',
    event: 'customer.password_reset',
    subjectType: 'customer',
    account: () => makeCustomer(t),
    ask: (email) => new StoreClient(t, stranger()).forgot(email),
    links: () =>
      customerLinks()
        .filter((link) => link.kind === 'password_reset')
        .map((link) => link.token),
    use: (token) => new StoreClient(t, stranger()).setPassword(token, nextPassword()),
    used: 204,
  },
  {
    name: 'customer sign-in link',
    event: 'customer.magic_link',
    subjectType: 'customer',
    account: () => makeCustomer(t),
    ask: (email) => new StoreClient(t, stranger()).magicLink(email),
    links: () =>
      customerLinks()
        .filter((link) => link.kind === 'magic_link')
        .map((link) => link.token),
    use: (token) => new StoreClient(t, stranger()).verify(token),
    used: 200,
  },
];

for (const flow of FLOWS) {
  describe(flow.name, () => {
    it('leaves both links of two requests working: the first one still works', async () => {
      const account = await flow.account();
      expect((await flow.ask(account.email)).statusCode).toBe(204);
      expect((await flow.ask(account.email)).statusCode).toBe(204);
      const [first, second] = flow.links();
      expect((await flow.use(first!)).statusCode).toBe(flow.used);
      // Using a link spends the others of its family.
      expect((await flow.use(second!)).statusCode).toBe(410);
    });

    it('keeps at most three live links: a fourth request voids the oldest, the other three work until one is used', async () => {
      const account = await flow.account();
      for (let i = 0; i < 4; i++) expect((await flow.ask(account.email)).statusCode).toBe(204);
      const links = flow.links();
      expect(links).toHaveLength(4);
      expect(await liveTokens(flow.subjectType, account.id)).toHaveLength(3);
      expect((await flow.use(links[0]!)).statusCode).toBe(410);
      expect((await flow.use(links[2]!)).statusCode).toBe(flow.used);
      expect((await flow.use(links[1]!)).statusCode).toBe(410);
      expect((await flow.use(links[3]!)).statusCode).toBe(410);
    });

    it('mails at most five an hour: the sixth request from a sixth network answers 204 and writes nothing', async () => {
      const account = await flow.account();
      for (let i = 0; i < 6; i++) {
        const res = await flow.ask(account.email);
        expect(res.statusCode, `request ${i + 1}`).toBe(204);
        expect(res.body).toBe('');
      }
      expect(await outboxCount(flow.event)).toBe(5);
      expect(flow.links()).toHaveLength(5);
    });
  });
}

describe('the budgets of visitors and staff are apart', () => {
  it('lets staff send a merchant a reset link after five forgot requests used the visitor budget', async () => {
    const merchant = await makeMerchant(t);
    for (let i = 0; i < 6; i++) await new MerchantPortal(t, stranger()).forgot(merchant.email);
    expect(await outboxCount('merchant.password_reset')).toBe(5);
    const staff = await adminWith(t, ['clients:read', 'clients:update', 'clients:security']);
    const res = await staff.post(`/admin/clients/${merchant.id}/password`, { mode: 'reset_link' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await outboxCount('merchant.password_reset')).toBe(6);
  });
});

describe('the verification resend of a signed-in merchant', () => {
  it('still replaces the older verification link', async () => {
    const merchant = await makeMerchant(t, { emailVerifiedAt: null });
    const p = new MerchantPortal(t, stranger());
    expect((await p.login(merchant.email)).statusCode).toBe(200);
    expect((await p.resendVerification()).statusCode).toBe(204);
    expect((await p.resendVerification()).statusCode).toBe(204);
    const [older, newer] = emailedLinks().filter((link) => link.kind === 'email_verification');
    expect((await new MerchantPortal(t, stranger()).verifyEmail(older!.token)).statusCode).toBe(410);
    expect((await new MerchantPortal(t, stranger()).verifyEmail(newer!.token)).statusCode).toBe(204);
    expect((await clientRow(merchant.id)).emailVerifiedAt).not.toBeNull();
  });
});
