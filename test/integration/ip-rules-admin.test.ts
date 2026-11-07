// Integration tests of the IP rule routes and the admin access restriction (feature 2a, scenario ip-rules): list, show, add,
// remove, test an address and switch the allow-list restriction, through HTTP on the real application.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { schema as s } from '../../src/infra/db';
import { IpRuleCache } from '../../src/modules/identity';
import { type AdminApi, adminFor, adminWith } from '../support/admin-api';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches, insertStaff } from '../support/auth';
import { HOUR, TestClock } from '../support/clock';
import { closeTestDb, resetDb, testDb } from '../support/db';

const clock = new TestClock();
let t: TestApp;
/** The address every admin call of this file comes from. */
const CALLER_IP = '203.0.113.50';

beforeAll(async () => {
  t = await createTestApp({ clock });
});
beforeEach(async () => {
  clock.reset();
  await resetDb();
  await clearIdentityCaches(t);
  await t.app.get(IpRuleCache).invalidate();
});
afterAll(async () => {
  await resetDb();
  await t.app.get(IpRuleCache).invalidate();
  await clearIdentityCaches(t);
  await t.close();
  await closeTestDb();
});

const ruleRows = async () => (await testDb()).db.select().from(s.ipRules).orderBy(s.ipRules.id);
const auditRows = async () => (await testDb()).db.select().from(s.auditLogs).orderBy(s.auditLogs.id);
const restrictionRow = async () => {
  const { db } = await testDb();
  return (await db.select().from(s.settings).where(eq(s.settings.key, 'adminAllowlistOnly')))[0];
};

/** An Owner who calls from {@link CALLER_IP}. */
const owner = () => adminWith(t, ['*'], { name: 'Rami K.', ip: CALLER_IP });

type RuleValues = Partial<typeof s.ipRules.$inferInsert> &
  Pick<typeof s.ipRules.$inferInsert, 'kind' | 'scope' | 'cidr'>;

/** Writes a rule straight to the table (as the risk engine or an older console did) and refreshes the cached rule set. */
async function addRule(values: RuleValues): Promise<number> {
  const { db } = await testDb();
  const [row] = await db
    .insert(s.ipRules)
    .values({ reason: 'test', ...values })
    .returning({ id: s.ipRules.id });
  await t.app.get(IpRuleCache).invalidate();
  return row!.id;
}

const ids = (body: Array<{ id: number }>) => body.map((rule) => rule.id);

/**
 * Signs the same staff member in again. A staff session sits idle for at most 30 minutes, so a test that moves the clock by an
 * hour starts a new session for the caller (the rules under test are judged by the clock, not by the old session).
 */
const signedInAgain = (api: AdminApi) => adminFor(t, api.staffId, api.roleId, api.ip);

describe('GET /admin/ip-rules', () => {
  it('lists live rules newest first with creator, hit counters and the wire spelling of addresses; expired ones are left out', async () => {
    const rami = await owner();
    const { db } = await testDb();
    const older = await addRule({
      kind: 'allow',
      scope: 'admin',
      cidr: '203.0.113.24/32',
      label: 'Amman office',
      createdBy: rami.staffId,
      hitCount: 12,
      lastHitAt: new Date('2026-11-01T08:00:00.000Z'),
      createdAt: new Date('2026-10-01T09:30:00.000Z'),
    });
    const range = await addRule({
      kind: 'block',
      scope: 'store',
      cidr: '198.51.100.0/24',
      reason: 'Card testing',
      createdAt: new Date('2026-10-02T09:30:00.000Z'),
    });
    const v6 = await addRule({
      kind: 'block',
      scope: 'api',
      cidr: '2001:db8::1/128',
      reason: 'Scraper',
      source: 'auto',
      expiresAt: new Date(clock.nowMs() + HOUR),
      createdAt: new Date('2026-10-03T09:30:00.000Z'),
    });
    await addRule({
      kind: 'block',
      scope: 'all',
      cidr: '192.0.2.9/32',
      reason: 'Gone already',
      expiresAt: new Date(clock.nowMs() - 1),
      createdAt: new Date('2026-10-04T09:30:00.000Z'),
    });
    expect(await db.select().from(s.ipRules)).toHaveLength(4);

    const res = await rami.get('/admin/ip-rules');
    expect(res.status).toBe(200);
    expect(res.total).toBe(3);
    expect(ids(res.body)).toEqual([v6, range, older]);
    expect(res.body.find((rule: { id: number }) => rule.id === older)).toEqual({
      id: older,
      cidr: '203.0.113.24',
      label: 'Amman office',
      reason: 'test',
      expiresAt: null,
      hitCount: 12,
      lastHitAt: '2026-11-01T08:00:00.000Z',
      createdAt: '2026-10-01T09:30:00.000Z',
      kind: 'allow',
      scope: 'admin',
      source: 'manual',
      createdBy: { id: rami.staffId, name: 'Rami K.' },
    });
    // A range keeps its prefix, a single IPv6 address loses /128, and a rule the risk engine added has no creator.
    expect(res.body.find((rule: { id: number }) => rule.id === range).cidr).toBe('198.51.100.0/24');
    const auto = res.body.find((rule: { id: number }) => rule.id === v6);
    expect(auto).toMatchObject({ cidr: '2001:db8::1', source: 'auto', createdBy: null, label: '' });
    expect(auto.expiresAt).toBe(new Date(clock.nowMs() + HOUR).toISOString());
  });

  it('keeps a rule until the moment it expires, then drops it from the list and the count', async () => {
    const rami = await owner();
    const soon = await addRule({
      kind: 'block',
      scope: 'store',
      cidr: '198.51.100.7/32',
      expiresAt: new Date(clock.nowMs() + HOUR),
    });
    expect(ids((await rami.get('/admin/ip-rules')).body)).toEqual([soon]);
    clock.advance(HOUR - 1);
    const later = await signedInAgain(rami);
    expect((await later.get('/admin/ip-rules')).total).toBe(1);
    clock.advance(1);
    const gone = await later.get('/admin/ip-rules');
    expect(gone.total).toBe(0);
    expect(gone.body).toEqual([]);
  });

  it('filters by kind, scope and source, searches cidr, label and reason, sorts and pages with the exact total', async () => {
    const rami = await owner();
    const a = await addRule({
      kind: 'allow',
      scope: 'admin',
      cidr: '203.0.113.24/32',
      label: 'Amman office',
      hitCount: 5,
      createdAt: new Date('2026-10-01T00:00:00.000Z'),
      expiresAt: new Date(clock.nowMs() + 3 * HOUR),
    });
    const b = await addRule({
      kind: 'block',
      scope: 'store',
      cidr: '198.51.100.0/24',
      reason: 'Card testing from a hosting range',
      hitCount: 30,
      createdAt: new Date('2026-10-02T00:00:00.000Z'),
      expiresAt: new Date(clock.nowMs() + 1 * HOUR),
    });
    const c = await addRule({
      kind: 'block',
      scope: 'all',
      cidr: '192.0.2.0/24',
      reason: 'Fraud ring',
      source: 'auto',
      hitCount: 1,
      createdAt: new Date('2026-10-03T00:00:00.000Z'),
    });

    expect(ids((await rami.get('/admin/ip-rules?kind=block')).body)).toEqual([c, b]);
    expect(ids((await rami.get('/admin/ip-rules?scope=admin')).body)).toEqual([a]);
    expect(ids((await rami.get('/admin/ip-rules?source=auto')).body)).toEqual([c]);
    expect(ids((await rami.get(`/admin/ip-rules?id=${b}`)).body)).toEqual([b]);
    expect(ids((await rami.get('/admin/ip-rules?q=hosting')).body)).toEqual([b]);
    expect(ids((await rami.get('/admin/ip-rules?q=AMMAN')).body)).toEqual([a]);
    expect(ids((await rami.get('/admin/ip-rules?q=203.0.113')).body)).toEqual([a]);
    expect(ids((await rami.get('/admin/ip-rules?q=fraud&kind=block')).body)).toEqual([c]);
    expect((await rami.get('/admin/ip-rules?q=nothing-matches')).total).toBe(0);

    expect(ids((await rami.get('/admin/ip-rules?_sort=hitCount&_order=desc')).body)).toEqual([b, a, c]);
    expect(ids((await rami.get('/admin/ip-rules?_sort=hitCount&_order=asc')).body)).toEqual([c, a, b]);
    expect(ids((await rami.get('/admin/ip-rules?_sort=expiresAt&_order=asc')).body).slice(0, 2)).toEqual([b, a]);
    expect(ids((await rami.get('/admin/ip-rules?_sort=id&_order=asc')).body)).toEqual([a, b, c]);

    const page = await rami.get('/admin/ip-rules?_sort=id&_order=asc&_start=1&_end=2');
    expect(ids(page.body)).toEqual([b]);
    expect(page.total).toBe(3);
  });

  it('refuses a filter or sort the contract does not list (422) and needs access:read', async () => {
    const rami = await owner();
    expect((await rami.get('/admin/ip-rules?kind=maybe')).status).toBe(422);
    expect((await rami.get('/admin/ip-rules?scope=moon')).status).toBe(422);
    expect((await rami.get('/admin/ip-rules?_sort=label')).status).toBe(422);
    const nobody = await adminWith(t, ['staff:read'], { ip: CALLER_IP });
    const refused = await nobody.get('/admin/ip-rules');
    expect(refused.status).toBe(403);
    expect(refused.body.detail).toContain('access:read');
    expect((await rami.anonymous('GET', '/admin/ip-rules')).status).toBe(401);
  });
});

describe('GET /admin/ip-rules/:id', () => {
  it('shows a rule, also an expired one (so audit links keep working), and answers 404 for an unknown id', async () => {
    const rami = await owner();
    const expired = await addRule({
      kind: 'block',
      scope: 'store',
      cidr: '203.0.113.0/24',
      reason: 'Was blocked',
      expiresAt: new Date(clock.nowMs() - HOUR),
      createdBy: rami.staffId,
    });
    const shown = await rami.get(`/admin/ip-rules/${expired}`);
    expect(shown.status).toBe(200);
    expect(shown.body).toMatchObject({
      id: expired,
      cidr: '203.0.113.0/24',
      kind: 'block',
      createdBy: { id: rami.staffId, name: 'Rami K.' },
    });
    expect((await rami.get('/admin/ip-rules')).total).toBe(0);

    const missing = await rami.get('/admin/ip-rules/999999');
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('NOT_FOUND');
    expect((await rami.get('/admin/ip-rules/abc')).status).toBe(422);
  });

  it('needs access:read', async () => {
    const nobody = await adminWith(t, ['staff:read'], { ip: CALLER_IP });
    expect((await nobody.get('/admin/ip-rules/1')).status).toBe(403);
  });
});

describe('POST /admin/ip-rules', () => {
  it('adds an allow rule: the scope is forced to admin, the address is normalised, the creator and time are the caller and the clock', async () => {
    const rami = await owner();
    const res = await rami.post('/admin/ip-rules', {
      kind: 'allow',
      scope: 'store',
      cidr: ' 203.0.113.24/32 ',
      label: '  Amman office ',
    });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      id: expect.any(Number),
      cidr: '203.0.113.24',
      label: 'Amman office',
      reason: '',
      expiresAt: null,
      hitCount: 0,
      lastHitAt: null,
      createdAt: clock.now().toISOString(),
      kind: 'allow',
      scope: 'admin',
      source: 'manual',
      createdBy: { id: rami.staffId, name: 'Rami K.' },
    });
    const [row] = await ruleRows();
    expect(row).toMatchObject({
      kind: 'allow',
      scope: 'admin',
      cidr: '203.0.113.24/32',
      source: 'manual',
      createdBy: rami.staffId,
    });
    expect(await auditRows()).toHaveLength(1);
    expect((await auditRows())[0]).toMatchObject({
      action: 'allowed IP for the admin console',
      entityType: 'ip_rule',
      entityId: res.body.id,
      entityLabel: '203.0.113.24',
      actorId: rami.staffId,
      actorName: 'Rami K.',
      ip: CALLER_IP,
    });
  });

  it('stores one spelling per network: a range keeps its prefix, IPv6 and IPv4-mapped addresses are read back plainly', async () => {
    const rami = await owner();
    const range = await rami.post('/admin/ip-rules', { kind: 'allow', scope: 'admin', cidr: '203.0.113.0/24' });
    expect(range.body.cidr).toBe('203.0.113.0/24');
    const v6 = await rami.post('/admin/ip-rules', { kind: 'allow', scope: 'admin', cidr: '2001:db8::1' });
    expect(v6.body.cidr).toBe('2001:db8::1');
    const v6range = await rami.post('/admin/ip-rules', { kind: 'allow', scope: 'admin', cidr: '2001:db8:1::/48' });
    expect(v6range.body.cidr).toBe('2001:db8:1::/48');
    const mapped = await rami.post('/admin/ip-rules', { kind: 'allow', scope: 'admin', cidr: '::ffff:192.0.2.8' });
    expect(mapped.status).toBe(201);
    expect(mapped.body.cidr).toBe('192.0.2.8');
    const stored = (await ruleRows()).map((row) => row.cidr);
    expect(stored).toEqual(['203.0.113.0/24', '2001:db8::1/128', '2001:db8:1::/48', '192.0.2.8/32']);
  });

  it('refuses host bits after the prefix, a range wider than /16 (/48 for IPv6) and a non-address on cidr (422)', async () => {
    const rami = await owner();
    const hostBits = await rami.post('/admin/ip-rules', { kind: 'allow', scope: 'admin', cidr: '203.0.113.5/24' });
    expect(hostBits.status).toBe(422);
    expect(hostBits.body.errors[0].field).toBe('cidr');
    expect(hostBits.body.errors[0].message).toContain('203.0.113.0/24');
    for (const cidr of [
      '10.0.0.0/8',
      '0.0.0.0/0',
      '2001:db8::/32',
      '::/0',
      'not-an-ip',
      '203.0.113.256',
      '203.0.113.0/33',
    ]) {
      const res = await rami.post('/admin/ip-rules', { kind: 'allow', scope: 'admin', cidr });
      expect(res.status).toBe(422);
      expect(res.body.errors[0].field).toBe('cidr');
    }
    // /16 and /48 themselves are the widest allowed.
    expect((await rami.post('/admin/ip-rules', { kind: 'allow', scope: 'admin', cidr: '10.1.0.0/16' })).status).toBe(
      201,
    );
    expect((await rami.post('/admin/ip-rules', { kind: 'allow', scope: 'admin', cidr: '2001:db8::/48' })).status).toBe(
      201,
    );
    expect(await ruleRows()).toHaveLength(2);
    expect(await auditRows()).toHaveLength(2);
  });

  it('needs a reason for a block, and a future expiry (422 on reason / expiresAt)', async () => {
    const rami = await owner();
    const noReason = await rami.post('/admin/ip-rules', { kind: 'block', scope: 'store', cidr: '198.51.100.7' });
    expect(noReason.status).toBe(422);
    expect(noReason.body.errors[0].field).toBe('reason');
    const blank = await rami.post('/admin/ip-rules', {
      kind: 'block',
      scope: 'store',
      cidr: '198.51.100.7',
      reason: '   ',
    });
    expect(blank.body.errors[0].field).toBe('reason');

    const past = await rami.post('/admin/ip-rules', {
      kind: 'block',
      scope: 'store',
      cidr: '198.51.100.7',
      reason: 'Card testing',
      expiresAt: clock.now().toISOString(),
    });
    expect(past.status).toBe(422);
    expect(past.body.errors[0].field).toBe('expiresAt');
    const future = new Date(clock.nowMs() + 7 * 24 * HOUR).toISOString();
    const ok = await rami.post('/admin/ip-rules', {
      kind: 'block',
      scope: 'store',
      cidr: '198.51.100.7',
      reason: ' Card testing ',
      expiresAt: future,
    });
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ reason: 'Card testing', expiresAt: future, scope: 'store', kind: 'block' });
    expect((await auditRows()).at(-1)).toMatchObject({ action: 'blocked IP', entityLabel: '198.51.100.7' });
  });

  it('refuses a missing or unknown kind, scope or body shape (422) with the field names', async () => {
    const rami = await owner();
    const noKind = await rami.post('/admin/ip-rules', { scope: 'admin', cidr: '203.0.113.1' });
    expect(noKind.status).toBe(422);
    expect(noKind.body.errors.map((e: { field: string }) => e.field)).toContain('kind');
    const badScope = await rami.post('/admin/ip-rules', { kind: 'allow', scope: 'moon', cidr: '203.0.113.1' });
    expect(badScope.body.errors[0].field).toBe('scope');
    const noCidr = await rami.post('/admin/ip-rules', { kind: 'allow', scope: 'admin', cidr: '' });
    expect(noCidr.body.errors[0].field).toBe('cidr');
    expect((await rami.post('/admin/ip-rules', {})).status).toBe(422);
    expect(await ruleRows()).toHaveLength(0);
  });

  it('refuses a live duplicate (same network and kind; for blocks also the same scope) on cidr, but not another scope or kind', async () => {
    const rami = await owner();
    expect((await rami.post('/admin/ip-rules', { kind: 'allow', scope: 'admin', cidr: '203.0.113.24' })).status).toBe(
      201,
    );
    const dupAllow = await rami.post('/admin/ip-rules', { kind: 'allow', scope: 'admin', cidr: '203.0.113.24/32' });
    expect(dupAllow.status).toBe(422);
    expect(dupAllow.body.errors[0].field).toBe('cidr');

    const block = { kind: 'block', scope: 'store', cidr: '198.51.100.0/24', reason: 'Card testing' };
    expect((await rami.post('/admin/ip-rules', block)).status).toBe(201);
    expect((await rami.post('/admin/ip-rules', block)).status).toBe(422);
    expect((await rami.post('/admin/ip-rules', { ...block, scope: 'api' })).status).toBe(201);
    // The same network as a block and as an allow rule are two different rules.
    expect(
      (await rami.post('/admin/ip-rules', { kind: 'allow', scope: 'admin', cidr: '198.51.100.0/24' })).status,
    ).toBe(201);
    expect(await ruleRows()).toHaveLength(4);

    // An expired rule is not a duplicate.
    await addRule({
      kind: 'block',
      scope: 'all',
      cidr: '192.0.2.0/24',
      reason: 'Old',
      expiresAt: new Date(clock.nowMs() + HOUR),
    });
    clock.advance(HOUR);
    const again = await (
      await signedInAgain(rami)
    ).post('/admin/ip-rules', {
      kind: 'block',
      scope: 'all',
      cidr: '192.0.2.0/24',
      reason: 'New',
    });
    expect(again.status).toBe(201);
  });

  it('refuses a block of the admin console or of everything that covers the caller (409 SELF_LOCKOUT on cidr), and writes nothing', async () => {
    const rami = await owner();
    for (const scope of ['admin', 'all']) {
      for (const cidr of [CALLER_IP, '203.0.113.0/24', '203.0.0.0/16']) {
        const res = await rami.post('/admin/ip-rules', { kind: 'block', scope, cidr, reason: 'Oops' });
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('SELF_LOCKOUT');
        expect(res.body.errors[0].field).toBe('cidr');
      }
    }
    expect(await ruleRows()).toHaveLength(0);
    expect(await auditRows()).toHaveLength(0);

    // The storefront and the API are other audiences, and a block that misses the caller is fine for every scope.
    expect(
      (await rami.post('/admin/ip-rules', { kind: 'block', scope: 'store', cidr: '203.0.113.0/24', reason: 'Fraud' }))
        .status,
    ).toBe(201);
    expect(
      (await rami.post('/admin/ip-rules', { kind: 'block', scope: 'api', cidr: CALLER_IP, reason: 'Abuse' })).status,
    ).toBe(201);
    expect(
      (await rami.post('/admin/ip-rules', { kind: 'block', scope: 'all', cidr: '203.0.114.0/24', reason: 'Abuse' }))
        .status,
    ).toBe(201);
    // An allow rule can never lock anybody out.
    expect((await rami.post('/admin/ip-rules', { kind: 'allow', scope: 'admin', cidr: CALLER_IP })).status).toBe(201);
  });

  it('clears the cached rule set after the commit, and leaves it alone when the request is refused', async () => {
    const rami = await owner();
    const cache = t.app.get(IpRuleCache);
    const before = await cache.get();
    expect(before.rules).toHaveLength(0);

    await rami.post('/admin/ip-rules', { kind: 'block', scope: 'store', cidr: '198.51.100.0/24' });
    expect((await cache.get()).version).toBe(before.version);
    expect((await cache.get()).rules).toHaveLength(0);

    const added = await rami.post('/admin/ip-rules', {
      kind: 'block',
      scope: 'store',
      cidr: '198.51.100.0/24',
      reason: 'Fraud',
    });
    expect(added.status).toBe(201);
    const after = await cache.get();
    expect(after.version).not.toBe(before.version);
    expect(after.rules.map((compiled) => compiled.rule.id)).toEqual([added.body.id]);
  });

  it('needs access:create and a CSRF token', async () => {
    const reader = await adminWith(t, ['access:read'], { ip: CALLER_IP });
    const body = { kind: 'allow', scope: 'admin', cidr: '203.0.113.9' };
    const refused = await reader.post('/admin/ip-rules', body);
    expect(refused.status).toBe(403);
    expect(refused.body.detail).toContain('access:create');
    const rami = await owner();
    const noCsrf = await rami.withoutCsrf('POST', '/admin/ip-rules', body);
    expect(noCsrf.status).toBe(403);
    expect(noCsrf.body.code).toBe('CSRF_FAILED');
    expect(await ruleRows()).toHaveLength(0);
  });
});

describe('DELETE /admin/ip-rules/:id', () => {
  it('removes a block (unblocks the address) and an allow rule, audits each, clears the cache, and answers 204', async () => {
    const rami = await owner();
    const block = await addRule({
      kind: 'block',
      scope: 'store',
      cidr: '198.51.100.7/32',
      reason: 'Card testing',
      label: 'Hosting',
    });
    const allow = await addRule({ kind: 'allow', scope: 'admin', cidr: '192.0.2.0/24' });
    const cache = t.app.get(IpRuleCache);
    expect((await cache.get()).rules).toHaveLength(2);

    const res = await rami.delete(`/admin/ip-rules/${block}`);
    expect(res.status).toBe(204);
    expect(res.body).toBeUndefined();
    expect((await cache.get()).rules.map((compiled) => compiled.rule.id)).toEqual([allow]);
    expect((await rami.delete(`/admin/ip-rules/${allow}`)).status).toBe(204);
    expect(await ruleRows()).toHaveLength(0);
    expect((await cache.get()).rules).toHaveLength(0);

    const [first, second] = await auditRows();
    expect(first).toMatchObject({
      action: 'unblocked IP',
      entityType: 'ip_rule',
      entityId: block,
      entityLabel: '198.51.100.7',
    });
    expect(first!.before).toEqual({
      kind: 'block',
      scope: 'store',
      cidr: '198.51.100.7',
      label: 'Hosting',
      reason: 'Card testing',
    });
    expect(second).toMatchObject({ action: 'removed allowed IP', entityId: allow, entityLabel: '192.0.2.0/24' });
  });

  it('answers 404 for an unknown id and writes nothing', async () => {
    const rami = await owner();
    const res = await rami.delete('/admin/ip-rules/999999');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
    expect(await auditRows()).toHaveLength(0);
    expect((await rami.delete('/admin/ip-rules/abc')).status).toBe(422);
  });

  it('refuses removing the only live allow rule that lets the caller in while the restriction is on (409 SELF_LOCKOUT)', async () => {
    const rami = await owner();
    const mine = await addRule({ kind: 'allow', scope: 'admin', cidr: `${CALLER_IP}/32` });
    expect((await rami.put('/admin/access/restriction', { enabled: true })).status).toBe(200);
    const res = await rami.delete(`/admin/ip-rules/${mine}`);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('SELF_LOCKOUT');
    expect(res.body.errors[0].field).toBe('id');
    expect(await ruleRows()).toHaveLength(1);
  });

  it('allows the removal when the rule does not cover the caller, another live rule does, the restriction is off, or the rule expired', async () => {
    const rami = await owner();
    const mine = await addRule({ kind: 'allow', scope: 'admin', cidr: `${CALLER_IP}/32` });
    const office = await addRule({ kind: 'allow', scope: 'admin', cidr: '203.0.113.0/24' });
    const elsewhere = await addRule({ kind: 'allow', scope: 'admin', cidr: '192.0.2.0/24' });
    const temporary = await addRule({
      kind: 'allow',
      scope: 'admin',
      cidr: '198.51.100.0/24',
      expiresAt: new Date(clock.nowMs() + HOUR),
    });
    expect((await rami.put('/admin/access/restriction', { enabled: true })).status).toBe(200);

    // A rule that does not cover the caller.
    expect((await rami.delete(`/admin/ip-rules/${elsewhere}`)).status).toBe(204);
    // A rule that covers the caller while another live rule also does.
    expect((await rami.delete(`/admin/ip-rules/${office}`)).status).toBe(204);
    // Now `mine` is the only one: refused.
    expect((await rami.delete(`/admin/ip-rules/${mine}`)).status).toBe(409);
    // An expired rule is not letting anybody in any more.
    clock.advance(HOUR);
    const later = await signedInAgain(rami);
    expect((await later.delete(`/admin/ip-rules/${temporary}`)).status).toBe(204);
    // With the restriction off, the last rule can go.
    expect((await later.put('/admin/access/restriction', { enabled: false })).status).toBe(200);
    expect((await later.delete(`/admin/ip-rules/${mine}`)).status).toBe(204);
    expect(await ruleRows()).toHaveLength(0);
  });

  it('needs access:delete and a CSRF token', async () => {
    const rule = await addRule({ kind: 'block', scope: 'store', cidr: '198.51.100.7/32', reason: 'x' });
    const reader = await adminWith(t, ['access:read', 'access:create'], { ip: CALLER_IP });
    const refused = await reader.delete(`/admin/ip-rules/${rule}`);
    expect(refused.status).toBe(403);
    expect(refused.body.detail).toContain('access:delete');
    const rami = await owner();
    const noCsrf = await rami.withoutCsrf('DELETE', `/admin/ip-rules/${rule}`);
    expect(noCsrf.status).toBe(403);
    expect(noCsrf.body.code).toBe('CSRF_FAILED');
    expect(await ruleRows()).toHaveLength(1);
  });
});

describe('POST /admin/ip-rules/check', () => {
  it('tells what would happen to an address for each audience, with the deciding rule', async () => {
    const rami = await owner();
    const block = await addRule({ kind: 'block', scope: 'store', cidr: '198.51.100.0/24', reason: 'Card testing' });
    const allBlock = await addRule({ kind: 'block', scope: 'all', cidr: '192.0.2.0/24', reason: 'Fraud ring' });

    const blocked = await rami.post('/admin/ip-rules/check', { ip: '198.51.100.77', scope: 'store' });
    expect(blocked.status).toBe(200);
    expect(blocked.body.decision).toBe('refused');
    expect(blocked.body.rule).toMatchObject({ id: block, kind: 'block', scope: 'store', cidr: '198.51.100.0/24' });

    const otherAudience = await rami.post('/admin/ip-rules/check', { ip: '198.51.100.77', scope: 'admin' });
    expect(otherAudience.body).toEqual({ decision: 'allowed', rule: null });
    expect((await rami.post('/admin/ip-rules/check', { ip: '203.0.113.9', scope: 'store' })).body).toEqual({
      decision: 'allowed',
      rule: null,
    });

    // `all` is not an audience of its own: only a block with scope `all` answers it.
    const everything = await rami.post('/admin/ip-rules/check', { ip: '192.0.2.40', scope: 'all' });
    expect(everything.body.decision).toBe('refused');
    expect(everything.body.rule.id).toBe(allBlock);
    expect((await rami.post('/admin/ip-rules/check', { ip: '198.51.100.77', scope: 'all' })).body.decision).toBe(
      'allowed',
    );
    // A block of everything also stops the storefront.
    expect((await rami.post('/admin/ip-rules/check', { ip: '192.0.2.40', scope: 'store' })).body.rule.id).toBe(
      allBlock,
    );
  });

  it('judges the admin console by the allow list while the restriction is on, and a range by its first address', async () => {
    const rami = await owner();
    const office = await addRule({ kind: 'allow', scope: 'admin', cidr: '203.0.113.0/24' });
    // Restriction off: everybody may open the console.
    expect((await rami.post('/admin/ip-rules/check', { ip: '192.0.2.1', scope: 'admin' })).body).toEqual({
      decision: 'allowed',
      rule: null,
    });
    expect((await rami.put('/admin/access/restriction', { enabled: true })).status).toBe(200);

    const inside = await rami.post('/admin/ip-rules/check', { ip: '203.0.113.200', scope: 'admin' });
    expect(inside.body.decision).toBe('allowed');
    expect(inside.body.rule.id).toBe(office);
    const outside = await rami.post('/admin/ip-rules/check', { ip: '192.0.2.1', scope: 'admin' });
    expect(outside.body).toEqual({ decision: 'refused', rule: null });
    const range = await rami.post('/admin/ip-rules/check', { ip: '203.0.113.0/28', scope: 'admin' });
    expect(range.body.decision).toBe('allowed');
    // The restriction does not apply to the storefront.
    expect((await rami.post('/admin/ip-rules/check', { ip: '192.0.2.1', scope: 'store' })).body.decision).toBe(
      'allowed',
    );
  });

  it('ignores an expired rule, and counts no hit and writes no audit row', async () => {
    const rami = await owner();
    const rule = await addRule({
      kind: 'block',
      scope: 'store',
      cidr: '198.51.100.7/32',
      reason: 'Temporary',
      expiresAt: new Date(clock.nowMs() + HOUR),
    });
    expect((await rami.post('/admin/ip-rules/check', { ip: '198.51.100.7', scope: 'store' })).body.decision).toBe(
      'refused',
    );
    clock.advance(HOUR);
    const later = await signedInAgain(rami);
    expect((await later.post('/admin/ip-rules/check', { ip: '198.51.100.7', scope: 'store' })).body).toEqual({
      decision: 'allowed',
      rule: null,
    });
    const { db } = await testDb();
    expect((await db.select().from(s.ipRules).where(eq(s.ipRules.id, rule)))[0]!.hitCount).toBe(0);
    expect(await auditRows()).toHaveLength(0);
  });

  it('refuses a non-address (422 on ip) and needs access:read and a CSRF token', async () => {
    const rami = await owner();
    const bad = await rami.post('/admin/ip-rules/check', { ip: 'not-an-ip', scope: 'store' });
    expect(bad.status).toBe(422);
    expect(bad.body.errors[0].field).toBe('ip');
    expect((await rami.post('/admin/ip-rules/check', { ip: '', scope: 'store' })).body.errors[0].field).toBe('ip');
    expect((await rami.post('/admin/ip-rules/check', { ip: '203.0.113.1', scope: 'moon' })).body.errors[0].field).toBe(
      'scope',
    );
    const nobody = await adminWith(t, ['staff:read'], { ip: CALLER_IP });
    expect((await nobody.post('/admin/ip-rules/check', { ip: '203.0.113.1', scope: 'store' })).status).toBe(403);
    expect(
      (await rami.withoutCsrf('POST', '/admin/ip-rules/check', { ip: '203.0.113.1', scope: 'store' })).body.code,
    ).toBe('CSRF_FAILED');
  });
});

describe('PUT /admin/access/restriction', () => {
  it('refuses turning it on while no live allow rule covers the caller (409 IP_NOT_IN_ALLOWLIST) and stores nothing', async () => {
    const rami = await owner();
    const refused = await rami.put('/admin/access/restriction', { enabled: true });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('IP_NOT_IN_ALLOWLIST');
    expect(await restrictionRow()).toBeUndefined();

    // An allow rule for somebody else's address does not help, nor does an expired one for the caller.
    await addRule({ kind: 'allow', scope: 'admin', cidr: '192.0.2.0/24' });
    await addRule({ kind: 'allow', scope: 'admin', cidr: CALLER_IP, expiresAt: new Date(clock.nowMs() + HOUR) });
    clock.advance(HOUR);
    const later = await signedInAgain(rami);
    expect((await later.put('/admin/access/restriction', { enabled: true })).status).toBe(409);
    expect(await auditRows()).toHaveLength(0);
  });

  it('turns it on when an allow rule covers the caller: stores the setting, audits, and the next request still passes', async () => {
    const rami = await owner();
    await addRule({ kind: 'allow', scope: 'admin', cidr: '203.0.113.0/24' });
    const cache = t.app.get(IpRuleCache);
    expect((await cache.get()).restricted).toBe(false);

    const res = await rami.put('/admin/access/restriction', { enabled: true });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ enabled: true });
    expect((await restrictionRow())!.value).toBe(true);
    expect((await cache.get()).restricted).toBe(true);
    expect((await rami.get('/admin/ip-rules')).status).toBe(200);
    const [audit] = await auditRows();
    expect(audit).toMatchObject({
      action: 'turned on the IP restriction for the admin console',
      entityType: 'setting',
      entityLabel: 'adminAllowlistOnly',
      actorId: rami.staffId,
    });
    expect(audit!.before).toEqual({ adminAllowlistOnly: false });
    expect(audit!.after).toEqual({ adminAllowlistOnly: true });

    // `GET /admin/settings` reads the same key (the settings snapshot was cleared).
    expect((await rami.get('/admin/settings')).body.adminAllowlistOnly).toBe(true);
  });

  it('shuts out an address that is not on the list once it is on, and lets everyone back in when it is turned off', async () => {
    const rami = await owner();
    const outsider = await adminWith(t, ['*'], { name: 'Outsider', ip: '192.0.2.99' });
    await addRule({ kind: 'allow', scope: 'admin', cidr: '203.0.113.0/24' });
    expect((await outsider.get('/admin/ip-rules')).status).toBe(200);
    await rami.put('/admin/access/restriction', { enabled: true });
    const shut = await outsider.get('/admin/ip-rules');
    expect(shut.status).toBe(403);
    expect(shut.body.code).toBe('IP_NOT_ALLOWED');
    expect((await rami.put('/admin/access/restriction', { enabled: false })).body).toEqual({ enabled: false });
    expect((await outsider.get('/admin/ip-rules')).status).toBe(200);
    expect((await restrictionRow())!.value).toBe(false);
  });

  it('is idempotent, and turning it off needs no allow rule', async () => {
    const rami = await owner();
    expect((await rami.put('/admin/access/restriction', { enabled: false })).body).toEqual({ enabled: false });
    await addRule({ kind: 'allow', scope: 'admin', cidr: CALLER_IP });
    expect((await rami.put('/admin/access/restriction', { enabled: true })).status).toBe(200);
    expect((await rami.put('/admin/access/restriction', { enabled: true })).body).toEqual({ enabled: true });
    expect((await rami.put('/admin/access/restriction', { enabled: false })).status).toBe(200);
    const { db } = await testDb();
    expect(await db.select().from(s.settings).where(eq(s.settings.key, 'adminAllowlistOnly'))).toHaveLength(1);
  });

  it('refuses a non-boolean (422 on enabled) and needs access:update and a CSRF token', async () => {
    const rami = await owner();
    const bad = await rami.put('/admin/access/restriction', { enabled: 'yes' });
    expect(bad.status).toBe(422);
    expect(bad.body.errors[0].field).toBe('enabled');
    expect((await rami.put('/admin/access/restriction', {})).status).toBe(422);
    const reader = await adminWith(t, ['access:read', 'access:create'], { ip: CALLER_IP });
    const refused = await reader.put('/admin/access/restriction', { enabled: false });
    expect(refused.status).toBe(403);
    expect(refused.body.detail).toContain('access:update');
    expect((await rami.withoutCsrf('PUT', '/admin/access/restriction', { enabled: false })).body.code).toBe(
      'CSRF_FAILED',
    );
  });
});

describe('two staff members changing the rules at once', () => {
  it('cannot lock themselves out together: of two removals that each leave the other rule, only one goes through', async () => {
    const rami = await owner();
    const { db } = await testDb();
    const second = await insertStaff(db, rami.roleId, { name: 'Second' });
    const secondApi = await adminFor(t, second, rami.roleId, '203.0.113.60');
    // Both rules cover both callers: each removal alone leaves the other rule standing, both together would leave none.
    const wide = await addRule({ kind: 'allow', scope: 'admin', cidr: '203.0.113.0/24' });
    const narrow = await addRule({ kind: 'allow', scope: 'admin', cidr: '203.0.113.0/26' });
    expect((await rami.put('/admin/access/restriction', { enabled: true })).status).toBe(200);

    const answers = await Promise.all([
      rami.delete(`/admin/ip-rules/${wide}`),
      secondApi.delete(`/admin/ip-rules/${narrow}`),
    ]);
    expect(answers.map((answer) => answer.status).sort()).toEqual([204, 409]);
    expect(await ruleRows()).toHaveLength(1);
    expect((await rami.get('/admin/ip-rules')).status).toBe(200);
  });
});
