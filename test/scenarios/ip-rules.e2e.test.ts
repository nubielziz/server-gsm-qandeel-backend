// End-to-end walk of the map scenario `ip-rules` (block an IP and keep an allow list, docs/slices/identity.json), step by step
// through HTTP on the real application: the tables and statuses each step names are read back from Postgres and Redis.
// The steps share one story, so the tests of this file run in order and keep their state in the variables below.
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { and, asc, eq } from 'drizzle-orm';
import { CacheKeys } from '../../src/infra/cache';
import { schema as s } from '../../src/infra/db';
import { RedisService } from '../../src/infra/redis';
import {
  IpRuleCache,
  IpRuleHits,
  IpRuleHitsFlush,
  IpRuleHitsFlushModule,
  SessionService,
} from '../../src/modules/identity';
import { type AdminApi, adminFor, adminWith } from '../support/admin-api';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches, clearRateLimits } from '../support/auth';
import { DAY, HOUR, TestClock } from '../support/clock';
import { closeTestDb, resetDb, testDb } from '../support/db';

const clock = new TestClock();
let t: TestApp;

/** The Owner's own address: the office. */
const OFFICE = '203.0.113.24';
const COLLEAGUE = '203.0.113.31';
const TRAVELLER_RANGE = '198.51.100.0/24';
const TRAVELLER = '198.51.100.9';
const OUTSIDER = '192.0.2.99';
const CUSTOMER_IP = '192.0.2.50';
const OTHER_NETWORK = '192.0.2.77';
const BOT_RANGE = '198.18.0.0/24';
const BOT = '198.18.0.40';

let owner: AdminApi;
let officeRule = 0;
let colleagueRule = 0;
let travellerRule = 0;
let travellerExpiry = '';
let customerId = 0;
let customerSessionId = 0;
let customerBlock = 0;
let autoBlock = 0;

beforeAll(async () => {
  t = await createTestApp({ clock, imports: [IpRuleHitsFlushModule] });
  clock.reset();
  await resetDb();
  await clearIdentityCaches(t);
  await clearRateLimits(t);
  await t.app.get(IpRuleCache).invalidate();
  owner = await adminWith(t, ['*'], { name: 'Rami K.', roleName: 'Owner', ip: OFFICE });
});
afterAll(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await t.app.get(IpRuleCache).invalidate();
  await t.app.get(RedisService).cache.del(t.app.get(CacheKeys).ipRuleHits());
  await t.close();
  await closeTestDb();
});

const ruleRow = async (id: number) => {
  const { db } = await testDb();
  return (await db.select().from(s.ipRules).where(eq(s.ipRules.id, id)))[0];
};
const restrictionRow = async () => {
  const { db } = await testDb();
  return (await db.select().from(s.settings).where(eq(s.settings.key, 'adminAllowlistOnly')))[0];
};
const auditActions = async () => {
  const { db } = await testDb();
  return (await db.select().from(s.auditLogs).orderBy(asc(s.auditLogs.id))).map((row) => row.action);
};
/** Writes the hit counters Redis holds to `ip_rules.hit_count` (the worker's flush job). */
async function flushHits(): Promise<void> {
  await t.app.get(IpRuleHits).idle();
  await t.app.get(IpRuleHitsFlush).flush();
}
/** A request with no session from an address (the console, the storefront or an API caller). */
const from = (ip: string, url: string, method: 'GET' | 'POST' = 'GET') =>
  t.app.inject({ method, url, remoteAddress: ip, ...(method === 'POST' ? { payload: {} } : {}) });
const code = (res: { json: () => unknown }) => (res.json() as { code?: string }).code;

describe('scenario ip-rules: block an IP and keep an allow list', () => {
  it('step 1: the Owner adds allow rules (an address, and a range for a traveller that expires); a range wider than /16 and a duplicate are refused', async () => {
    const colleague = await owner.post('/admin/ip-rules', {
      kind: 'allow',
      scope: 'admin',
      cidr: COLLEAGUE,
      label: 'Colleague at home',
    });
    expect(colleague.status).toBe(201);
    colleagueRule = colleague.body.id;
    travellerExpiry = new Date(clock.nowMs() + 2 * HOUR).toISOString();
    const traveller = await owner.post('/admin/ip-rules', {
      kind: 'allow',
      scope: 'admin',
      cidr: TRAVELLER_RANGE,
      label: 'Traveller hotel',
      expiresAt: travellerExpiry,
    });
    expect(traveller.status).toBe(201);
    travellerRule = traveller.body.id;
    expect(traveller.body).toMatchObject({
      cidr: TRAVELLER_RANGE,
      expiresAt: travellerExpiry,
      kind: 'allow',
      scope: 'admin',
    });

    const wide = await owner.post('/admin/ip-rules', { kind: 'allow', scope: 'admin', cidr: '10.0.0.0/8' });
    expect(wide.status).toBe(422);
    expect(wide.body.errors[0].field).toBe('cidr');
    const duplicate = await owner.post('/admin/ip-rules', { kind: 'allow', scope: 'admin', cidr: `${COLLEAGUE}/32` });
    expect(duplicate.status).toBe(422);
    expect(duplicate.body.errors[0].field).toBe('cidr');

    expect(await ruleRow(colleagueRule)).toMatchObject({
      kind: 'allow',
      scope: 'admin',
      cidr: `${COLLEAGUE}/32`,
      createdBy: owner.staffId,
      source: 'manual',
    });
    expect(await auditActions()).toEqual(['allowed IP for the admin console', 'allowed IP for the admin console']);
  });

  it("step 2: turning the restriction on is refused unless the caller's own address is on the list; the key is stored in settings", async () => {
    const refused = await owner.put('/admin/access/restriction', { enabled: true });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('IP_NOT_IN_ALLOWLIST');
    expect(await restrictionRow()).toBeUndefined();

    const office = await owner.post('/admin/ip-rules', {
      kind: 'allow',
      scope: 'admin',
      cidr: OFFICE,
      label: 'Amman office',
    });
    expect(office.status).toBe(201);
    officeRule = office.body.id;
    const on = await owner.put('/admin/access/restriction', { enabled: true });
    expect(on.status).toBe(200);
    expect(on.body).toEqual({ enabled: true });
    expect((await restrictionRow())!.value).toBe(true);
    expect((await auditActions()).at(-1)).toBe('turned on the IP restriction for the admin console');
    expect((await owner.get('/admin/settings')).body.adminAllowlistOnly).toBe(true);
  });

  it('step 3: a visitor from an address that is not on the list gets 403 before any login form; the rule that admitted others is counted', async () => {
    await flushHits();
    const before = (await ruleRow(officeRule))!.hitCount;

    const outsider = await from(OUTSIDER, '/admin/auth/me');
    expect(outsider.statusCode).toBe(403);
    expect(code(outsider)).toBe('IP_NOT_ALLOWED');
    expect(code(await from(OUTSIDER, '/admin/auth/login', 'POST'))).toBe('IP_NOT_ALLOWED');
    // From the office the request gets through the IP stage (and then needs a session: 401, not 403).
    expect((await from(OFFICE, '/admin/auth/me')).statusCode).toBe(401);
    expect((await from(OFFICE, '/admin/auth/me')).statusCode).toBe(401);

    await flushHits();
    const after = await ruleRow(officeRule);
    expect(after!.hitCount - before).toBe(2);
    expect(after!.lastHitAt).toEqual(clock.now());
  });

  it('step 4: the live rules are cached in Redis and dropped on every change; an expired rule falls out by itself', async () => {
    const redis = t.app.get(RedisService).cache;
    const key = t.app.get(CacheKeys).ipRules();
    await t.app.get(IpRuleCache).get();
    expect(await redis.exists(key)).toBe(1);

    // Any change clears it: a rule is added and removed again.
    const probe = await owner.post('/admin/ip-rules', {
      kind: 'block',
      scope: 'api',
      cidr: '198.19.0.5',
      reason: 'Probe',
    });
    expect(await redis.exists(key)).toBe(0);
    await t.app.get(IpRuleCache).get();
    expect(await redis.exists(key)).toBe(1);
    expect((await owner.delete(`/admin/ip-rules/${probe.body.id}`)).status).toBe(204);
    expect(await redis.exists(key)).toBe(0);

    // The traveller's range lets the hotel in until its expiry, with no change and no invalidation at the end.
    const expiry = new Date(travellerExpiry).getTime();
    clock.set(expiry - 1);
    expect((await from(TRAVELLER, '/admin/auth/me')).statusCode).toBe(401);
    clock.set(expiry);
    const gone = await from(TRAVELLER, '/admin/auth/me');
    expect(gone.statusCode).toBe(403);
    expect(code(gone)).toBe('IP_NOT_ALLOWED');
    expect((await ruleRow(travellerRule))!.expiresAt!.toISOString()).toBe(travellerExpiry);
    // The list shows only live rules, but the expired one can still be read by id.
    owner = await adminFor(t, owner.staffId, owner.roleId, OFFICE);
    expect((await owner.get('/admin/ip-rules')).body.map((rule: { id: number }) => rule.id)).not.toContain(
      travellerRule,
    );
    expect((await owner.get(`/admin/ip-rules/${travellerRule}`)).status).toBe(200);
  });

  it("step 5: from a customer page the Owner blocks the last address of the customer for the storefront for seven days; a range with the Owner's own address is refused", async () => {
    const { db } = await testDb();
    const [customer] = await db
      .insert(s.customers)
      .values({ email: 'customer@example.com', name: 'Customer', hasAccount: true })
      .returning({ id: s.customers.id });
    customerId = customer!.id;
    const issued = await t.app.get(SessionService).create({
      subjectType: 'customer',
      subjectId: customerId,
      stage: 'active',
      ip: CUSTOMER_IP,
      userAgent: 'bun-test',
    });
    customerSessionId = issued.session.id;
    // The console reads the address from the customer's latest session (the last checkout session is the fallback).
    const [latest] = await db
      .select({ ip: s.sessions.ip })
      .from(s.sessions)
      .where(and(eq(s.sessions.subjectType, 'customer'), eq(s.sessions.subjectId, customerId)))
      .orderBy(asc(s.sessions.id));
    expect(latest!.ip).toBe(CUSTOMER_IP);

    const sevenDays = new Date(clock.nowMs() + 7 * DAY).toISOString();
    const block = await owner.post('/admin/ip-rules', {
      kind: 'block',
      scope: 'store',
      cidr: latest!.ip,
      reason: 'Card testing from this address',
      expiresAt: sevenDays,
    });
    expect(block.status).toBe(201);
    customerBlock = block.body.id;
    expect(await ruleRow(customerBlock)).toMatchObject({
      kind: 'block',
      scope: 'store',
      reason: 'Card testing from this address',
      createdBy: owner.staffId,
    });
    expect((await ruleRow(customerBlock))!.expiresAt!.toISOString()).toBe(sevenDays);
    expect((await auditActions()).at(-1)).toBe('blocked IP');

    for (const scope of ['admin', 'all']) {
      const own = await owner.post('/admin/ip-rules', {
        kind: 'block',
        scope,
        cidr: '203.0.113.0/24',
        reason: 'Whole subnet',
      });
      expect(own.status).toBe(409);
      expect(own.body.code).toBe('SELF_LOCKOUT');
      expect(own.body.errors[0].field).toBe('cidr');
    }
  });

  it('step 6: a storefront request from the blocked address is refused with 403 before any payment logic; the account itself is untouched', async () => {
    const blocked = await from(CUSTOMER_IP, '/store/v1/checkout-sessions', 'POST');
    expect(blocked.statusCode).toBe(403);
    expect(code(blocked)).toBe('IP_NOT_ALLOWED');
    // Another network: the request reaches the router (this route is not built yet, so 404 is the proof that it was let in).
    expect((await from(OTHER_NETWORK, '/store/v1/nope')).statusCode).toBe(404);

    await flushHits();
    expect((await ruleRow(customerBlock))!.hitCount).toBe(1);
    const { db } = await testDb();
    expect((await db.select().from(s.customers).where(eq(s.customers.id, customerId)))[0]).toMatchObject({
      status: 'active',
      hasAccount: true,
    });
    expect((await db.select().from(s.sessions).where(eq(s.sessions.id, customerSessionId)))[0]!.revokedAt).toBeNull();
  });

  it('step 7: an automatic block (written by the risk engine, feature 18) is a rule like the others: source auto, no creator, it blocks', async () => {
    const { db } = await testDb();
    const [auto] = await db
      .insert(s.ipRules)
      .values({
        kind: 'block',
        scope: 'store',
        cidr: BOT_RANGE,
        reason: '60 card attempts in 10 minutes',
        source: 'auto',
        createdBy: null,
        expiresAt: new Date(clock.nowMs() + 30 * DAY),
      })
      .returning({ id: s.ipRules.id });
    autoBlock = auto!.id;
    await t.app.get(IpRuleCache).invalidate();

    const listed = await owner.get('/admin/ip-rules?source=auto');
    expect(listed.body).toHaveLength(1);
    expect(listed.body[0]).toMatchObject({
      id: autoBlock,
      source: 'auto',
      createdBy: null,
      kind: 'block',
      scope: 'store',
      cidr: BOT_RANGE,
    });
    expect(listed.body[0].expiresAt).toBe(new Date(clock.nowMs() + 30 * DAY).toISOString());
    expect(code(await from(BOT, '/store/v1/nope'))).toBe('IP_NOT_ALLOWED');
    // The risk assessment that the engine records next to the rule (risk_assessments) belongs to feature 18.
  });

  it('step 8: testing an address answers allowed or refused and the rule that decided, by the audience chosen', async () => {
    const check = async (ip: string, scope: string) => (await owner.post('/admin/ip-rules/check', { ip, scope })).body;
    const blocked = await check(CUSTOMER_IP, 'store');
    expect(blocked.decision).toBe('refused');
    expect(blocked.rule).toMatchObject({ id: customerBlock, kind: 'block', scope: 'store' });
    expect(await check(CUSTOMER_IP, 'api')).toEqual({ decision: 'allowed', rule: null });
    const bot = await check(BOT, 'store');
    expect(bot.decision).toBe('refused');
    expect(bot.rule).toMatchObject({ id: autoBlock, source: 'auto' });
    // The admin console is restricted: the office is let in by its rule, an address that is not listed is not.
    const office = await check(OFFICE, 'admin');
    expect(office.decision).toBe('allowed');
    expect(office.rule.id).toBe(officeRule);
    expect(await check(CUSTOMER_IP, 'admin')).toEqual({ decision: 'refused', rule: null });
    // Testing counts no hit and writes no audit row.
    const actions = await auditActions();
    await flushHits();
    expect((await ruleRow(customerBlock))!.hitCount).toBe(1);
    expect(await auditActions()).toEqual(actions);
  });

  it('step 9: removing a block unblocks the address; removing the only allow rule that lets the Owner in is refused while the restriction is on', async () => {
    const removed = await owner.delete(`/admin/ip-rules/${customerBlock}`);
    expect(removed.status).toBe(204);
    expect(await ruleRow(customerBlock)).toBeUndefined();
    expect((await auditActions()).at(-1)).toBe('unblocked IP');
    expect((await from(CUSTOMER_IP, '/store/v1/nope')).statusCode).toBe(404);

    // A rule that does not cover the Owner can always go.
    expect((await owner.delete(`/admin/ip-rules/${colleagueRule}`)).status).toBe(204);
    expect((await auditActions()).at(-1)).toBe('removed allowed IP');

    const lockout = await owner.delete(`/admin/ip-rules/${officeRule}`);
    expect(lockout.status).toBe(409);
    expect(lockout.body.code).toBe('SELF_LOCKOUT');
    expect(await ruleRow(officeRule)).toBeDefined();
    expect((await owner.get('/admin/ip-rules')).status).toBe(200);

    // With the restriction off the last allow rule may go.
    expect((await owner.put('/admin/access/restriction', { enabled: false })).body).toEqual({ enabled: false });
    expect((await owner.delete(`/admin/ip-rules/${officeRule}`)).status).toBe(204);
    expect((await restrictionRow())!.value).toBe(false);
    // The traveller's expired rule is still readable by id and the automatic block still stands.
    expect((await ruleRow(autoBlock))!.source).toBe('auto');
  });
});
