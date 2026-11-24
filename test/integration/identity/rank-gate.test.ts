// Integration tests of the one account session and the default-deny rank gate (decision 064) through
// real HTTP: one cookie serves both URL families, the rank of the account decides which routes it may call, a refusal never signs it out,
// the gate comes after the session checks and before CSRF, a multipart body of the wrong rank is never read, and the session core
// (`SessionService`, the implementation of the `AccountSessions` port) sets and clears the cookies by rank kind.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { Readable } from 'node:stream';
import { Body, Controller, Res } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { type BodyOf, type ResultOf, Route, defineRoute } from '@src/common/contract';
import { AppError } from '@src/common/errors';
import { TokenService } from '@src/infra/crypto';
import { DbService, schema as s } from '@src/infra/db';
import { SESSION_COOKIE_NAMES, SessionCookies, SessionService, csrfTokenFor, rankKindOf } from '@src/modules/identity';
import { type AccountPrincipal, CurrentAccount } from '@src/modules/identity/ports/account-principal';
import { makeAccount } from '../../support/accounts';
import { csrfCookieNameOf, openAccountSession } from '../../support/account-sessions';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches, insertMerchant } from '../../support/auth';
import { TestClock } from '../../support/clock';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { freshClientIp } from '../../support/pipeline-routes';
import { expectRejection } from '../../support/rejection';
import { STORE_ORIGIN } from '../../support/store';

const Who = z.object({
  accountId: z.number(),
  clientId: z.number(),
  rankId: z.number(),
  rankKind: z.enum(['merchant', 'retail']),
  stage: z.string(),
});
const Okay = z.object({ ok: z.boolean() });

const whoMerchantRoute = defineRoute({
  key: 'GET /client/t/rank/who',
  summary: 'Who am I on a merchant route (rank gate test)',
  tags: ['rank-gate-test'],
  surface: 'client',
  access: 'merchant-session',
  success: { status: 200, schema: Who },
  errors: ['UNAUTHORIZED', 'ACCOUNT_SUSPENDED'],
});
const whoRetailRoute = defineRoute({
  key: 'GET /store/v1/t/rank/who',
  summary: 'Who am I on a retail route (rank gate test)',
  tags: ['rank-gate-test'],
  surface: 'store',
  access: 'customer-session',
  success: { status: 200, schema: Who },
  errors: ['UNAUTHORIZED', 'ACCOUNT_SUSPENDED'],
});
const writeMerchantRoute = defineRoute({
  key: 'POST /client/t/rank/write',
  summary: 'A mutation on a merchant route (rank gate test)',
  tags: ['rank-gate-test'],
  surface: 'client',
  access: 'merchant-session',
  success: { status: 200, schema: Okay },
  errors: ['UNAUTHORIZED', 'ACCOUNT_SUSPENDED', 'CSRF_FAILED'],
});
const StartBody = z.object({
  accountId: z.number().int().positive(),
  rankKind: z.enum(['merchant', 'retail']),
  stage: z.enum(['active', 'pending_totp']).default('active'),
});
const startRoute = defineRoute({
  key: 'POST /client/t/rank/start',
  summary: 'Opens an account session the way a sign-in does (rank gate test)',
  tags: ['rank-gate-test'],
  surface: 'client',
  access: 'public',
  csrf: false,
  body: StartBody,
  success: { status: 200, schema: z.object({ expiresAt: z.string() }) },
  errors: ['CSRF_FAILED', 'VALIDATION_FAILED'],
});
const RevokeBody = z.object({ accountId: z.number().int().positive(), rollback: z.boolean().default(false) });
const revokeAllRoute = defineRoute({
  key: 'POST /client/t/rank/revoke-all',
  summary: 'Ends every session of an account in a transaction (rank gate test)',
  tags: ['rank-gate-test'],
  surface: 'client',
  access: 'public',
  csrf: false,
  body: RevokeBody,
  success: { status: 200, schema: z.object({ ended: z.number() }) },
  errors: ['CSRF_FAILED', 'VALIDATION_FAILED', 'CONFLICT'],
});
const invalidateRoute = defineRoute({
  key: 'POST /client/t/rank/invalidate',
  summary: 'Drops the cached views of an account (rank gate test)',
  tags: ['rank-gate-test'],
  surface: 'client',
  access: 'public',
  csrf: false,
  body: z.object({ accountId: z.number().int().positive() }),
  success: { status: 200, schema: Okay },
  errors: ['CSRF_FAILED', 'VALIDATION_FAILED'],
});
const clearRoute = defineRoute({
  key: 'POST /client/t/rank/clear',
  summary: 'Clears the account cookies like a sign-out (rank gate test)',
  tags: ['rank-gate-test'],
  surface: 'client',
  access: 'public',
  csrf: false,
  success: { status: 204 },
  errors: ['CSRF_FAILED'],
});

/** The principal of an account route as a handler gets it. */
function whoOf(account: AccountPrincipal): z.infer<typeof Who> {
  return {
    accountId: account.accountId,
    clientId: account.clientId,
    rankId: account.rank.id,
    rankKind: account.rank.kind,
    stage: account.stage,
  };
}

@Controller()
class RankGateTestController {
  constructor(
    private readonly db: DbService,
    private readonly sessions: SessionService,
    private readonly cookies: SessionCookies,
  ) {}

  @Route(whoMerchantRoute)
  whoMerchant(@CurrentAccount() account: AccountPrincipal): ResultOf<typeof whoMerchantRoute> {
    return whoOf(account);
  }

  @Route(whoRetailRoute)
  whoRetail(@CurrentAccount() account: AccountPrincipal): ResultOf<typeof whoRetailRoute> {
    return whoOf(account);
  }

  @Route(writeMerchantRoute)
  writeMerchant(): ResultOf<typeof writeMerchantRoute> {
    return { ok: true };
  }

  @Route(startRoute)
  async start(
    @Body() body: BodyOf<typeof startRoute>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<ResultOf<typeof startRoute>> {
    const { expiresAt } = await this.db.runInTransaction((work) =>
      this.sessions.start(work, reply, { accountId: body.accountId, stage: body.stage, rankKind: body.rankKind }),
    );
    return { expiresAt: expiresAt.toISOString() };
  }

  @Route(revokeAllRoute)
  async revokeAll(@Body() body: BodyOf<typeof revokeAllRoute>): Promise<ResultOf<typeof revokeAllRoute>> {
    const ended = await this.db.runInTransaction(async ({ tx }) => {
      const count = await this.sessions.revokeAll(tx, body.accountId);
      if (body.rollback) throw new AppError('CONFLICT', { detail: 'rolled back on purpose' });
      return count;
    });
    return { ended };
  }

  @Route(invalidateRoute)
  async invalidate(@Body() body: BodyOf<typeof invalidateRoute>): Promise<ResultOf<typeof invalidateRoute>> {
    await this.sessions.invalidate(body.accountId);
    return { ok: true };
  }

  @Route(clearRoute)
  clear(@Res({ passthrough: true }) reply: FastifyReply): void {
    this.cookies.clearAccount(reply);
  }
}

const clock = new TestClock();
let t: TestApp;

beforeAll(async () => {
  t = await createTestApp({
    controllers: [RankGateTestController],
    env: { SHOP_ORIGINS: STORE_ORIGIN },
    clock,
  });
});
afterAll(async () => {
  await resetDb();
  await t.close();
  await closeTestDb();
});
beforeEach(async () => {
  clock.reset();
  await resetDb();
  await clearIdentityCaches(t);
});

const get = (url: string, headers: Record<string, string> = {}) => t.app.inject({ method: 'GET', url, headers });
const post = (url: string, headers: Record<string, string> = {}, payload?: unknown) =>
  t.app.inject({ method: 'POST', url, headers, ...(payload === undefined ? {} : { payload: payload as never }) });
const postFromShop = (url: string, payload?: unknown) => post(url, { origin: STORE_ORIGIN }, payload);
const accountSessionsOf = async (accountId: number) => {
  const { db } = await testDb();
  return db.select().from(s.sessions).where(eq(s.sessions.subjectId, accountId));
};

describe('one session cookie serves both URL families', () => {
  it('lets a merchant session call the merchant routes and a retail session the shop routes, and refuses each on the other family', async () => {
    const merchant = await makeAccount(t, { rank: 'merchant' });
    const retail = await makeAccount(t, { rank: 'retail' });
    const merchantSession = await openAccountSession(t, merchant.id);
    const retailSession = await openAccountSession(t, retail.id);
    // The same cookie name for both ranks: the one account cookie.
    expect(merchantSession.cookie.startsWith(`${SESSION_COOKIE_NAMES.account}=`)).toBe(true);
    expect(retailSession.cookie.startsWith(`${SESSION_COOKIE_NAMES.account}=`)).toBe(true);

    const merchantOnPortal = await get('/client/t/rank/who', merchantSession.headers);
    expect(merchantOnPortal.statusCode).toBe(200);
    // One principal for every rank: the account id twice (clientId stays until the contract release) and the rank it saw.
    expect(merchantOnPortal.json()).toEqual({
      accountId: merchant.id,
      clientId: merchant.id,
      rankId: merchant.groupId,
      rankKind: 'merchant',
      stage: 'active',
    });
    const retailOnShop = await get('/store/v1/t/rank/who', retailSession.headers);
    expect(retailOnShop.statusCode).toBe(200);
    expect(retailOnShop.json()).toEqual({
      accountId: retail.id,
      clientId: retail.id,
      rankId: retail.groupId,
      rankKind: 'retail',
      stage: 'active',
    });

    for (const [res, wanted] of [
      [await get('/store/v1/t/rank/who', merchantSession.headers), 'RANK_NOT_ALLOWED'],
      [await get('/client/t/rank/who', retailSession.headers), 'RANK_NOT_ALLOWED'],
    ] as const) {
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ code: wanted, status: 403 });
    }
  });

  it('never signs an account out for a rank refusal: the session stays live and works on its own family', async () => {
    const retail = await makeAccount(t, { rank: 'retail' });
    const session = await openAccountSession(t, retail.id);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect((await get('/client/t/rank/who', session.headers)).statusCode).toBe(403);
    }
    expect((await accountSessionsOf(retail.id)).every((row) => row.revokedAt === null)).toBe(true);
    expect((await get('/store/v1/t/rank/who', session.headers)).statusCode).toBe(200);
  });

  it('reads no cookie but the account cookie: a token under the old shop cookie name opens nothing on either family', async () => {
    const retail = await makeAccount(t, { rank: 'retail' });
    const merchant = await makeAccount(t, { rank: 'merchant' });
    for (const account of [retail, merchant]) {
      const session = await openAccountSession(t, account.id);
      const asOldShopCookie = { cookie: `gsm_store_session=${session.token}` };
      expect((await get('/store/v1/t/rank/who', asOldShopCookie)).statusCode).toBe(401);
      expect((await get('/client/t/rank/who', asOldShopCookie)).statusCode).toBe(401);
    }
  });

  it('keeps the staff cookie and the account cookie apart', async () => {
    const retail = await makeAccount(t, { rank: 'retail' });
    const session = await openAccountSession(t, retail.id);
    const asStaff = { cookie: `${SESSION_COOKIE_NAMES.staff}=${session.token}` };
    // A staff route of this app: the staff cookie that carries an account token names no staff session.
    expect((await get('/admin/auth/me', asStaff)).statusCode).toBe(401);
  });
});

describe('the real routes of the two families', () => {
  it('refuses a retail session on the merchant routes and serves it on its own', async () => {
    const retail = await makeAccount(t, { rank: 'retail' });
    const { headers, mutationHeaders } = await openAccountSession(t, retail.id);
    for (const [method, url] of [
      ['GET', '/client/wallet'],
      ['GET', '/client/notifications'],
      ['POST', '/client/orders'],
      ['POST', '/client/api-keys'],
    ] as const) {
      const res = await t.app.inject({ method, url, headers: method === 'GET' ? headers : mutationHeaders });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
      expect(res.json(), `${method} ${url}`).toMatchObject({ code: 'RANK_NOT_ALLOWED' });
    }
    for (const url of ['/store/v1/me', '/store/v1/me/notifications', '/store/v1/me/wallet']) {
      expect((await get(url, headers)).statusCode, url).toBe(200);
    }
  });

  it('refuses a merchant session on the shop routes and serves it on its own', async () => {
    const merchant = await makeAccount(t, { rank: 'merchant' });
    const { headers, mutationHeaders } = await openAccountSession(t, merchant.id);
    for (const [method, url] of [
      ['GET', '/store/v1/me/wallet'],
      ['POST', '/store/v1/me/wallet/top-ups'],
      ['POST', '/store/v1/files'],
    ] as const) {
      const res = await t.app.inject({ method, url, headers: method === 'GET' ? headers : mutationHeaders });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
      expect(res.json(), `${method} ${url}`).toMatchObject({ code: 'RANK_NOT_ALLOWED' });
    }
    expect((await get('/client/wallet', headers)).statusCode).toBe(200);
  });
});

describe('the order of the checks', () => {
  it('answers a pending step 401 before any rank check, and a suspended or blocked account 403 ACCOUNT_SUSPENDED with every session revoked', async () => {
    const retail = await makeAccount(t, { rank: 'retail' });
    const pending = await openAccountSession(t, retail.id, { stage: 'pending_totp' });
    expect((await get('/client/t/rank/who', pending.headers)).statusCode).toBe(401);

    for (const status of ['suspended', 'blocked'] as const) {
      const account = await makeAccount(t, { rank: 'retail', status });
      const first = await openAccountSession(t, account.id);
      const second = await openAccountSession(t, account.id);
      // Both families, whatever the rank of the route: the account state is judged first.
      const refused = await get('/client/t/rank/who', first.headers);
      expect(refused.statusCode, status).toBe(403);
      expect(refused.json().code, status).toBe('ACCOUNT_SUSPENDED');
      expect(
        (await accountSessionsOf(account.id)).every((row) => row.revokedAt !== null),
        status,
      ).toBe(true);
      // The other device is signed out too: a plain 401 now.
      expect((await get('/store/v1/t/rank/who', second.headers)).statusCode, status).toBe(401);
    }
  });

  it('answers an anonymized account and a guest row 401: their sessions are gone', async () => {
    const anonymized = await makeAccount(t, { rank: 'retail', status: 'anonymized', anonymizedAt: clock.now() });
    const guest = await makeAccount(t, { rank: 'retail', guest: true });
    for (const account of [anonymized, guest]) {
      const session = await openAccountSession(t, account.id);
      expect((await get('/store/v1/t/rank/who', session.headers)).statusCode).toBe(401);
    }
  });

  it('judges the rank before CSRF: a wrong rank without the token is RANK_NOT_ALLOWED, the right rank without it CSRF_FAILED', async () => {
    const retail = await makeAccount(t, { rank: 'retail' });
    const merchant = await makeAccount(t, { rank: 'merchant' });
    const retailSession = await openAccountSession(t, retail.id);
    const merchantSession = await openAccountSession(t, merchant.id);
    expect((await post('/client/t/rank/write', retailSession.headers)).json().code).toBe('RANK_NOT_ALLOWED');
    expect((await post('/client/t/rank/write', merchantSession.headers)).json().code).toBe('CSRF_FAILED');
    expect((await post('/client/t/rank/write', merchantSession.mutationHeaders)).statusCode).toBe(200);
  });
});

describe('a rank change', () => {
  it('is seen on the next request once the cached view is dropped, inside a kind and across kinds', async () => {
    const { db } = await testDb();
    const id = await insertMerchant(db);
    const session = await openAccountSession(t, id);
    const before = (await get('/client/t/rank/who', session.headers)).json();
    expect(before).toMatchObject({ rankKind: 'merchant' });

    // Inside the merchant kind: the principal names the new rank.
    const [other] = await db.insert(s.clientGroups).values({ name: 'Gold', kind: 'b2b' }).returning();
    await db.update(s.clients).set({ groupId: other!.id }).where(eq(s.clients.id, id));
    expect((await postFromShop('/client/t/rank/invalidate', { accountId: id })).statusCode).toBe(200);
    expect((await get('/client/t/rank/who', session.headers)).json()).toMatchObject({
      rankId: other!.id,
      rankKind: 'merchant',
    });

    // Across kinds: the merchant routes refuse it and the shop routes serve it.
    const retail = await makeAccount(t, { rank: 'retail' });
    await db.update(s.clients).set({ groupId: retail.groupId }).where(eq(s.clients.id, id));
    await postFromShop('/client/t/rank/invalidate', { accountId: id });
    expect((await get('/client/t/rank/who', session.headers)).json().code).toBe('RANK_NOT_ALLOWED');
    expect((await get('/store/v1/t/rank/who', session.headers)).json()).toMatchObject({
      rankId: retail.groupId,
      rankKind: 'retail',
    });
  });
});

describe('the upload pre-check', () => {
  const MIB = 1024 * 1024;

  /** Sends 30 MiB of a multipart body in chunks, without a length, and counts the chunks the server asked for. */
  async function chunked(url: string, headers: Record<string, string>) {
    let produced = 0;
    function* chunks() {
      for (let index = 0; index < 30; index += 1) {
        produced += 1;
        yield Buffer.alloc(MIB, 97);
      }
    }
    const res = await t.app.inject({
      method: 'POST',
      url,
      remoteAddress: freshClientIp(),
      headers: { ...headers, 'content-type': 'multipart/form-data; boundary=gsm' },
      payload: Readable.from(chunks()),
    });
    return { res, produced: () => produced };
  }

  it('refuses a retail session on the merchant upload route and a merchant session on the shop one, with the body unread', async () => {
    const retail = await openAccountSession(t, (await makeAccount(t, { rank: 'retail' })).id);
    const merchant = await openAccountSession(t, (await makeAccount(t, { rank: 'merchant' })).id);
    for (const [url, session] of [
      ['/client/files', retail],
      ['/store/v1/files', merchant],
    ] as const) {
      const { res, produced } = await chunked(url, session.mutationHeaders);
      expect(res.statusCode, url).toBe(403);
      expect(res.json(), url).toMatchObject({ code: 'RANK_NOT_ALLOWED' });
      // The server answered at the request's headers: it never asked for the body.
      expect(produced(), url).toBeLessThan(5);
    }
    // The refusal does not end the session.
    expect((await get('/store/v1/t/rank/who', retail.headers)).statusCode).toBe(200);
  });

  it('refuses a session without a rank the same way and still answers 401 for no session at all', async () => {
    const none = await chunked('/client/files', {});
    expect(none.res.statusCode).toBe(401);
    expect(none.produced()).toBeLessThan(5);
    const stale = await chunked('/store/v1/files', { cookie: `${SESSION_COOKIE_NAMES.account}=${'a'.repeat(43)}` });
    expect(stale.res.statusCode).toBe(401);
    expect(stale.produced()).toBeLessThan(5);
  });
});

describe('a rank kind outside the closed list', () => {
  it('cannot be stored, and the code gives retail rights to every kind it does not know', async () => {
    const { db } = await testDb();
    await expectRejection(
      Promise.resolve(db.insert(s.clientGroups).values({ name: 'Wholesale', kind: 'wholesale' as never })),
    );
    expect(rankKindOf('wholesale')).toBe('retail');
    expect(rankKindOf('')).toBe('retail');
    expect(rankKindOf('b2c_retail')).toBe('retail');
    expect(rankKindOf('b2b')).toBe('merchant');
  });
});

describe('the session core of the sign-in use cases (AccountSessions)', () => {
  const cookieNames = (cookies: ReadonlyArray<{ name: string; maxAge?: number }>, cleared: boolean) =>
    cookies
      .filter((cookie) => (cookie.maxAge === 0) === cleared)
      .map((cookie) => cookie.name)
      .sort();

  it('opens a session of subject account with the cookies of a merchant rank and clears the retail name and the old shop cookie', async () => {
    const merchant = await makeAccount(t, { rank: 'merchant' });
    const res = await postFromShop('/client/t/rank/start', { accountId: merchant.id, rankKind: 'merchant' });
    expect(res.statusCode).toBe(200);
    expect(cookieNames(res.cookies, false)).toEqual(
      [csrfCookieNameOf('merchant'), SESSION_COOKIE_NAMES.account].sort(),
    );
    expect(cookieNames(res.cookies, true)).toEqual([csrfCookieNameOf('retail'), 'gsm_store_session'].sort());
    const session = res.cookies.find((cookie) => cookie.name === SESSION_COOKIE_NAMES.account)!;
    expect(session).toMatchObject({ httpOnly: true, sameSite: 'Lax', path: '/' });
    const csrf = res.cookies.find((cookie) => cookie.name === csrfCookieNameOf('merchant'))!;
    expect(csrf.value).toBe(csrfTokenFor(t.config.security.csrfSecret, t.app.get(TokenService).hash(session.value)));
    expect(res.headers['x-csrf-token']).toBe(csrf.value);
    // The row passes the narrowed CHECK, and the new session works on its own family.
    expect(await accountSessionsOf(merchant.id)).toMatchObject([{ subjectType: 'account', stage: 'active' }]);
    const who = await get('/client/t/rank/who', { cookie: `${session.name}=${session.value}` });
    expect(who.statusCode).toBe(200);
  });

  it('sets the CSRF cookie of the retail rank for a retail account, and keeps a pending step pending', async () => {
    const retail = await makeAccount(t, { rank: 'retail' });
    const res = await postFromShop('/client/t/rank/start', {
      accountId: retail.id,
      rankKind: 'retail',
      stage: 'pending_totp',
    });
    expect(cookieNames(res.cookies, false)).toEqual([csrfCookieNameOf('retail'), SESSION_COOKIE_NAMES.account].sort());
    expect(cookieNames(res.cookies, true)).toEqual([csrfCookieNameOf('merchant'), 'gsm_store_session'].sort());
    expect(await accountSessionsOf(retail.id)).toMatchObject([{ stage: 'pending_totp' }]);
    const session = res.cookies.find((cookie) => cookie.name === SESSION_COOKIE_NAMES.account)!;
    // A pending step lives for the short pending time, not for 30 days.
    expect(session.maxAge).toBeLessThanOrEqual(600);
  });

  it("ends every live session of an account in the caller's transaction, and the cached views go with them", async () => {
    const retail = await makeAccount(t, { rank: 'retail' });
    const other = await makeAccount(t, { rank: 'retail' });
    const a = await openAccountSession(t, retail.id);
    const b = await openAccountSession(t, retail.id);
    const stranger = await openAccountSession(t, other.id);
    for (const session of [a, b, stranger])
      expect((await get('/store/v1/t/rank/who', session.headers)).statusCode).toBe(200);

    const res = await postFromShop('/client/t/rank/revoke-all', { accountId: retail.id });
    expect(res.json()).toEqual({ ended: 2 });
    for (const session of [a, b]) expect((await get('/store/v1/t/rank/who', session.headers)).statusCode).toBe(401);
    expect((await get('/store/v1/t/rank/who', stranger.headers)).statusCode).toBe(200);
    expect((await postFromShop('/client/t/rank/revoke-all', { accountId: retail.id })).json()).toEqual({ ended: 0 });
  });

  it('leaves the sessions and their cached views alone when the transaction rolls back', async () => {
    const retail = await makeAccount(t, { rank: 'retail' });
    const session = await openAccountSession(t, retail.id);
    expect((await get('/store/v1/t/rank/who', session.headers)).statusCode).toBe(200);
    const res = await postFromShop('/client/t/rank/revoke-all', { accountId: retail.id, rollback: true });
    expect(res.statusCode).toBe(409);
    expect((await accountSessionsOf(retail.id)).every((row) => row.revokedAt === null)).toBe(true);
    expect((await get('/store/v1/t/rank/who', session.headers)).statusCode).toBe(200);
  });

  it('clears the session cookie, both CSRF names and the old shop cookie on sign-out', async () => {
    const res = await postFromShop('/client/t/rank/clear');
    expect(res.statusCode).toBe(204);
    expect(res.cookies.map((cookie) => [cookie.name, cookie.maxAge]).sort()).toEqual(
      [
        [SESSION_COOKIE_NAMES.account, 0],
        [csrfCookieNameOf('merchant'), 0],
        [csrfCookieNameOf('retail'), 0],
        ['gsm_store_session', 0],
      ].sort(),
    );
  });
});
