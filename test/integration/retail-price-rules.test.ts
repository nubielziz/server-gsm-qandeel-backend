// Integration tests of the retail price rules (feature 31 slice B1, decision 040, spec B229): the four CRUD routes with their
// 422s, permissions, audit rows and the version bump; the soft delete; the preview (create, update, delete; nothing stored); the
// category delete; the one price writer (`RetailPrices.set`: the floor, typed and following); the listing route's
// `retailPricing: 'rule'` and its three new keys; the group price page turning following off.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq, sql } from 'drizzle-orm';
import { Money } from '../../src/common/money';
import { schema as s } from '../../src/infra/db';
import { RetailFloorError, RetailPrices } from '../../src/modules/catalog';
import { type AdminApi, adminWith } from '../support/admin-api';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches } from '../support/auth';
import { insertCategory, insertService } from '../support/catalog';
import { TestClock } from '../support/clock';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { catalogVersionOf } from '../support/pricing';
import { insertListingRow, insertRetailPrice, listingWorld } from '../support/storefront';

const clock = new TestClock('2026-11-17T09:00:00.000Z');
let t: TestApp;
let admin: AdminApi;

beforeAll(async () => {
  t = await createTestApp({ clock });
});
beforeEach(async () => {
  clock.set('2026-11-17T09:00:00.000Z');
  await resetDb();
  await clearIdentityCaches(t);
  admin = await adminWith(t, ['pricing:*', 'storefront:*', 'catalog:*'], { name: 'Rami K.' });
});
afterAll(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await t.close();
  await closeTestDb();
});

const db = async () => (await testDb()).db;
const auditRows = async () => (await db()).select().from(s.auditLogs).orderBy(s.auditLogs.id);
const ruleRows = async () => (await db()).select().from(s.retailPriceRules).orderBy(s.retailPriceRules.id);
const followOf = async (serviceId: number) =>
  (await (await db()).select().from(s.retailPriceFollows).where(eq(s.retailPriceFollows.serviceId, serviceId)))[0];
const retailOf = async (serviceId: number, groupId: number) =>
  (
    await (
      await db()
    )
      .select({ price: s.serviceGroupPrices.price })
      .from(s.serviceGroupPrices)
      .where(sql`${s.serviceGroupPrices.serviceId} = ${serviceId} and ${s.serviceGroupPrices.groupId} = ${groupId}`)
  )[0]?.price ?? null;

const IMEI_30 = { scope: 'type', serviceType: 'imei', percent: '30', rounding: 'ends_99' } as const;
const createRule = async (body: Record<string, unknown>) => {
  const res = await admin.post('/admin/retail-price-rules', body);
  expect(res.status).toBe(201);
  return res.body as { id: number; label: string };
};
const fieldsOf = (body: { errors?: { field: string; code: string }[] }) =>
  (body.errors ?? []).map((error) => `${error.field}:${error.code}`);

/**
 * The listing world with a listing per service. AT&T: cost 13.50, base 17.28, own minimum profit 0.81, storefront floor 19.01.
 * The check: cost 0.08, base 0.13, floor 0.14. Both IMEI, in one category open to every group.
 */
async function world() {
  const base = await listingWorld(await db());
  const attListing = await insertListingRow(await db(), base.att, { slug: 'att', publicTitle: 'AT&T USA' });
  const checkListing = await insertListingRow(await db(), base.check, { slug: 'check', publicTitle: 'iCloud check' });
  return { ...base, attListing, checkListing };
}

describe('POST /admin/retail-price-rules', () => {
  it('creates a rule with the defaults, its label, its audit row and a version bump', async () => {
    const before = await catalogVersionOf(t);
    const res = await admin.post('/admin/retail-price-rules', IMEI_30);
    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      id: expect.any(Number),
      scope: 'type',
      serviceType: 'imei',
      categoryId: null,
      categoryName: null,
      percent: '30.0000',
      fixed: '0.0000',
      rounding: 'ends_99',
      roundFrom: '5.0000',
      autoFollowPercent: 25,
      isActive: true,
      label: 'IMEI +30%, ends in .99',
      following: 0,
      updatedAt: expect.any(String),
    });
    expect(await catalogVersionOf(t)).not.toBe(before);
    const [row] = await ruleRows();
    expect(row).toMatchObject({ updatedBy: admin.staffId, deletedAt: null, changedAt: clock.now() });
    const [audit] = await auditRows();
    expect(audit).toMatchObject({
      action: 'created retail price rule',
      entityType: 'retail_price_rule',
      entityId: res.body.id,
      entityLabel: 'IMEI +30%, ends in .99',
      actorName: 'Rami K.',
      before: null,
    });
    expect(audit!.after).toMatchObject({ scope: 'type', serviceType: 'imei', percent: '30.0000' });
  });

  it('names the category of a category rule and adds the fixed amount to the label', async () => {
    const categoryId = await insertCategory(await db(), { name: 'AT&T USA' });
    const res = await admin.post('/admin/retail-price-rules', {
      scope: 'category',
      categoryId,
      percent: '20',
      fixed: '0.5000',
      rounding: 'cent',
      roundFrom: '0.0000',
      autoFollowPercent: 0,
      isActive: false,
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      categoryId,
      categoryName: 'AT&T USA',
      label: 'AT&T USA +20% +$0.50',
      autoFollowPercent: 0,
      isActive: false,
    });
  });

  it('refuses target fields that do not fit the scope, and an unknown category, before any write', async () => {
    const cases: Array<[Record<string, unknown>, string[]]> = [
      [{ scope: 'global', serviceType: 'imei', percent: '1', rounding: 'cent' }, ['serviceType:invalid']],
      [{ scope: 'type', percent: '1', rounding: 'cent' }, ['serviceType:invalid']],
      [{ scope: 'type', serviceType: 'imei', categoryId: 4, percent: '1', rounding: 'cent' }, ['categoryId:invalid']],
      [{ scope: 'category', percent: '1', rounding: 'cent' }, ['categoryId:invalid']],
      [{ scope: 'category', categoryId: 999999, percent: '1', rounding: 'cent' }, ['categoryId:invalid']],
    ];
    for (const [body, fields] of cases) {
      const res = await admin.post('/admin/retail-price-rules', body);
      expect(res.status, JSON.stringify(body)).toBe(422);
      expect(fieldsOf(res.body), JSON.stringify(body)).toEqual(fields);
    }
    expect(await ruleRows()).toEqual([]);
    expect(await auditRows()).toEqual([]);
  });

  it('refuses a second rule for the same target, also when two creates race', async () => {
    await createRule({ scope: 'global', percent: '25', rounding: 'ends_99' });
    const second = await admin.post('/admin/retail-price-rules', { scope: 'global', percent: '30', rounding: 'cent' });
    expect(second.status).toBe(422);
    expect(second.body.errors).toEqual([
      { field: 'scope', code: 'duplicate', message: 'A rule for this already exists. Edit it instead.' },
    ]);
    const racing = await Promise.all([
      admin.post('/admin/retail-price-rules', IMEI_30),
      admin.post('/admin/retail-price-rules', IMEI_30),
    ]);
    expect(racing.map((res) => res.status).sort()).toEqual([201, 422]);
    expect(fieldsOf(racing.find((res) => res.status === 422)!.body)).toEqual(['scope:duplicate']);
    expect(await ruleRows()).toHaveLength(2);
  });

  it('refuses numbers outside their limits and unknown keys', async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ ...IMEI_30, percent: '1000.0001' }, 'percent'],
      [{ ...IMEI_30, percent: '1.12345' }, 'percent'],
      [{ ...IMEI_30, percent: '-1' }, 'percent'],
      [{ ...IMEI_30, fixed: '100000.0001' }, 'fixed'],
      [{ ...IMEI_30, fixed: '-0.5000' }, 'fixed'],
      [{ ...IMEI_30, roundFrom: '-1.0000' }, 'roundFrom'],
      [{ ...IMEI_30, autoFollowPercent: 1001 }, 'autoFollowPercent'],
      [{ ...IMEI_30, autoFollowPercent: 2.5 }, 'autoFollowPercent'],
      [{ ...IMEI_30, rounding: 'none' }, 'rounding'],
    ];
    for (const [body, field] of cases) {
      const res = await admin.post('/admin/retail-price-rules', body);
      expect(res.status, JSON.stringify(body)).toBe(422);
      expect(
        res.body.errors.map((error: { field: string }) => error.field),
        JSON.stringify(body),
      ).toContain(field);
    }
    expect((await admin.post('/admin/retail-price-rules', { ...IMEI_30, priority: 1 })).status).toBe(422);
    // The limits themselves are accepted.
    expect(
      (
        await admin.post('/admin/retail-price-rules', {
          ...IMEI_30,
          percent: '1000',
          fixed: '100000.0000',
          roundFrom: '100000.0000',
          autoFollowPercent: 1000,
        })
      ).status,
    ).toBe(201);
  });
});

describe('GET /admin/retail-price-rules', () => {
  it('lists the rules global, type, category, then id, with filters, the total and the follower count', async () => {
    const w = await world();
    const category = await createRule({ scope: 'category', categoryId: w.categoryId, percent: '10', rounding: 'cent' });
    const type = await createRule(IMEI_30);
    const global = await createRule({ scope: 'global', percent: '50', rounding: 'cent', isActive: false });
    // AT&T follows the category rule.
    expect((await admin.patch(`/admin/service-listings/${w.attListing}`, { retailPricing: 'rule' })).status).toBe(200);

    const all = await admin.get('/admin/retail-price-rules');
    expect(all.status).toBe(200);
    expect(all.total).toBe(3);
    expect(all.body.map((row: { id: number }) => row.id)).toEqual([global.id, type.id, category.id]);
    expect(all.body[2]).toMatchObject({ categoryName: 'Carrier unlock', following: 1 });
    expect(all.body[1]).toMatchObject({ following: 0 });

    const types = await admin.get('/admin/retail-price-rules?scope=type');
    expect(types.body.map((row: { id: number }) => row.id)).toEqual([type.id]);
    const off = await admin.get('/admin/retail-price-rules?isActive=false');
    expect(off.body.map((row: { id: number }) => row.id)).toEqual([global.id]);
    const byId = await admin.get('/admin/retail-price-rules?_sort=id&_order=desc');
    expect(byId.body.map((row: { id: number }) => row.id)).toEqual([global.id, type.id, category.id]);
    expect((await admin.get('/admin/retail-price-rules?kind=margin')).status).toBe(422);
  });

  it('needs pricing:read; a role with only it cannot write', async () => {
    const reader = await adminWith(t, ['pricing:read']);
    expect((await reader.get('/admin/retail-price-rules')).status).toBe(200);
    const res = await reader.post('/admin/retail-price-rules', IMEI_30);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN');
    const rule = await createRule(IMEI_30);
    expect((await reader.patch(`/admin/retail-price-rules/${rule.id}`, { percent: '1' })).status).toBe(403);
    expect((await reader.delete(`/admin/retail-price-rules/${rule.id}`)).status).toBe(403);
    // The preview is a read.
    expect(
      (await reader.post('/admin/retail-price-rules/preview', { change: { kind: 'delete', id: rule.id } })).status,
    ).toBe(200);
    const outsider = await adminWith(t, ['storefront:*']);
    expect((await outsider.get('/admin/retail-price-rules')).status).toBe(403);
    expect((await admin.anonymous('GET', '/admin/retail-price-rules')).status).toBe(401);
    expect((await admin.withoutCsrf('POST', '/admin/retail-price-rules', IMEI_30)).status).toBe(403);
  });
});

describe('PATCH /admin/retail-price-rules/:id', () => {
  it('changes the figures, keeps the target, audits before and after, moves changed_at and the version', async () => {
    const rule = await createRule(IMEI_30);
    clock.advance(60_000);
    const before = await catalogVersionOf(t);
    const res = await admin.patch(`/admin/retail-price-rules/${rule.id}`, {
      percent: '35.5',
      fixed: '1.0000',
      rounding: 'step_0.05',
      roundFrom: '0.0000',
      autoFollowPercent: 10,
      isActive: false,
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: rule.id,
      scope: 'type',
      serviceType: 'imei',
      percent: '35.5000',
      fixed: '1.0000',
      rounding: 'step_0.05',
      roundFrom: '0.0000',
      autoFollowPercent: 10,
      isActive: false,
      label: 'IMEI +35.5% +$1.00, rounded up to $0.05',
    });
    expect(await catalogVersionOf(t)).not.toBe(before);
    const [row] = await ruleRows();
    expect(row!.changedAt).toEqual(clock.now());
    const audit = (await auditRows()).at(-1)!;
    expect(audit).toMatchObject({
      action: 'changed retail price rule',
      entityType: 'retail_price_rule',
      entityId: rule.id,
    });
    expect(audit.before).toMatchObject({ percent: '30.0000', isActive: true });
    expect(audit.after).toMatchObject({ percent: '35.5000', isActive: false, rounding: 'step_0.05' });
  });

  it('refuses a key for the scope or the target, an empty body, and an unknown rule', async () => {
    const rule = await createRule(IMEI_30);
    expect((await admin.patch(`/admin/retail-price-rules/${rule.id}`, { scope: 'global' })).status).toBe(422);
    expect((await admin.patch(`/admin/retail-price-rules/${rule.id}`, { serviceType: 'server' })).status).toBe(422);
    expect((await admin.patch(`/admin/retail-price-rules/${rule.id}`, {})).status).toBe(422);
    expect((await admin.patch(`/admin/retail-price-rules/${rule.id}`, { percent: '1001' })).status).toBe(422);
    const unknown = await admin.patch('/admin/retail-price-rules/999999', { percent: '1' });
    expect(unknown.status).toBe(404);
    expect(unknown.body.code).toBe('NOT_FOUND');
  });
});

describe('DELETE /admin/retail-price-rules/:id (a soft delete)', () => {
  it('keeps the row switched off with deleted_at, hides it, frees the target and keeps the follow row pointing at it', async () => {
    const w = await world();
    const rule = await createRule(IMEI_30);
    expect((await admin.patch(`/admin/service-listings/${w.attListing}`, { retailPricing: 'rule' })).status).toBe(200);
    clock.advance(60_000);
    const before = await catalogVersionOf(t);

    const res = await admin.delete(`/admin/retail-price-rules/${rule.id}`);
    expect(res.status).toBe(204);
    expect(await catalogVersionOf(t)).not.toBe(before);
    const [row] = await ruleRows();
    expect(row).toMatchObject({ id: rule.id, isActive: false, deletedAt: clock.now(), updatedBy: admin.staffId });
    expect((await admin.get('/admin/retail-price-rules')).body).toEqual([]);
    expect((await admin.patch(`/admin/retail-price-rules/${rule.id}`, { percent: '1' })).status).toBe(404);
    expect((await admin.delete(`/admin/retail-price-rules/${rule.id}`)).status).toBe(404);
    expect(
      (await admin.post('/admin/retail-price-rules/preview', { change: { kind: 'delete', id: rule.id } })).status,
    ).toBe(404);
    expect(
      (
        await admin.post('/admin/retail-price-rules/preview', {
          change: { kind: 'update', id: rule.id, rule: { percent: '1' } },
        })
      ).status,
    ).toBe(404);
    // The follow row keeps its rule, and the listing still names it (history).
    expect((await followOf(w.att))?.ruleId).toBe(rule.id);
    const listing = await admin.get(`/admin/service-listings/${w.attListing}`);
    expect(listing.body).toMatchObject({
      retailPriceSource: 'rule',
      retailPriceRule: { id: rule.id, label: rule.label },
    });
    // A new rule for the same target is accepted.
    const again = await createRule(IMEI_30);
    expect(again.id).not.toBe(rule.id);
    const audit = (await auditRows()).find((one) => one.action === 'deleted retail price rule')!;
    expect(audit).toMatchObject({
      entityType: 'retail_price_rule',
      entityId: rule.id,
      entityLabel: 'IMEI +30%, ends in .99',
    });
    expect(audit.before).toMatchObject({ scope: 'type', isActive: true });
    // The row after the delete: the same figures, switched off and marked deleted (plan section 6.6).
    expect(audit.after).toMatchObject({
      scope: 'type',
      isActive: false,
      deletedAt: (row!.deletedAt as Date).toISOString(),
    });
  });

  it('does not wait for a transaction that is writing a follow row of the rule', async () => {
    const w = await world();
    const rule = await createRule(IMEI_30);
    // Another transaction prices the check by the rule and stays open: its foreign-key check holds the rule row
    // FOR KEY SHARE. The delete takes FOR NO KEY UPDATE, which that lock does not block.
    const { pool } = await testDb();
    const other = await pool.connect();
    let guard: ReturnType<typeof setTimeout> | undefined;
    try {
      await other.query('BEGIN');
      await other.query(
        `insert into retail_price_follows (service_id, rule_id, applied_price, applied_cost, applied_at)
         values ($1, $2, '0.1400', '0.0800', $3)`,
        [w.check, rule.id, clock.now()],
      );
      const waited = new Promise<never>((_, reject) => {
        guard = setTimeout(() => reject(new Error('the delete waited for the open transaction')), 5_000);
      });
      const res = await Promise.race([admin.delete(`/admin/retail-price-rules/${rule.id}`), waited]);
      expect(res.status).toBe(204);
      await other.query('COMMIT');
    } catch (error) {
      await other.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      clearTimeout(guard);
      other.release();
    }
    // Both committed: the rule is deleted and the follow row still names it (the next pass moves it on).
    expect((await ruleRows())[0]).toMatchObject({ id: rule.id, isActive: false });
    expect((await ruleRows())[0]!.deletedAt).not.toBeNull();
    expect((await followOf(w.check))?.ruleId).toBe(rule.id);
  });
});

describe('DELETE /admin/service-categories/:id with a retail price rule', () => {
  it('removes the rule by the cascade and names it in the audit row', async () => {
    const categoryId = await insertCategory(await db(), { name: 'Empty' });
    const kept = await insertCategory(await db(), { name: 'Kept' });
    const rule = await createRule({ scope: 'category', categoryId, percent: '10', rounding: 'cent' });
    const other = await createRule({ scope: 'category', categoryId: kept, percent: '10', rounding: 'cent' });
    expect((await admin.delete(`/admin/service-categories/${categoryId}`)).status).toBe(204);
    expect((await ruleRows()).map((row) => row.id)).toEqual([other.id]);
    const audit = (await auditRows()).find((one) => one.action === 'deleted category')!;
    expect(audit.before).toMatchObject({ removedPricingRuleIds: [], removedRetailRuleId: rule.id });
    // A category without a retail rule writes no such key.
    const plain = await insertCategory(await db(), { name: 'Plain' });
    expect((await admin.delete(`/admin/service-categories/${plain}`)).status).toBe(204);
    const last = (await auditRows()).at(-1)!;
    expect(last.before).not.toHaveProperty('removedRetailRuleId');
  });
});

describe('POST /admin/retail-price-rules/preview', () => {
  /** AT&T and the check follow the IMEI rule (19.99 and 0.14); a third service has a typed price and is never counted. */
  async function following() {
    const w = await world();
    const rule = await createRule(IMEI_30);
    expect(
      (await admin.patch(`/admin/service-listings/${w.attListing}`, { retailPricing: 'rule' })).body.retailPrice,
    ).toBe('19.9900');
    expect(
      (await admin.patch(`/admin/service-listings/${w.checkListing}`, { retailPricing: 'rule' })).body.retailPrice,
    ).toBe('0.1400');
    const typed = await insertService(await db(), w.categoryId, {
      cost: '5.0000',
      effectiveCost: '5.0000',
      basePrice: '6.0000',
    });
    await insertRetailPrice(await db(), typed, w.groups.retail, '9.0000');
    return { ...w, rule };
  }

  /** Counts of every table a preview must leave alone. */
  const counts = async () => {
    const database = await db();
    const one = async (table: string) =>
      Number((await database.execute(sql.raw(`select count(*)::int as n from ${table}`))).rows[0]!.n);
    return {
      rules: await one('retail_price_rules'),
      follows: await one('retail_price_follows'),
      prices: await one('service_group_prices'),
      audit: await one('audit_logs'),
      changed: (await ruleRows()).map((row) => `${row.id}:${row.percent}:${row.isActive}`).join(','),
    };
  };

  it('previews an update: both followers rise, the largest change first, and nothing is stored', async () => {
    const w = await following();
    const before = await counts();
    const version = await catalogVersionOf(t);
    const res = await admin.post('/admin/retail-price-rules/preview', {
      change: { kind: 'update', id: w.rule.id, rule: { percent: '100' } },
    });
    expect(res.status).toBe(200);
    // AT&T: 13.50 x 2 = 27.00, then 27.99. The check: 0.16 (over the floor 0.14, under roundFrom).
    expect(res.body).toEqual({
      following: 2,
      changes: 2,
      raised: 2,
      lowered: 0,
      atFloor: 0,
      noRule: 0,
      lines: [
        {
          serviceId: w.att,
          name: 'AT&T USA Premier Unlock',
          code: 'IMEI-ATT-USA',
          cost: '13.5000',
          floorPrice: '19.0100',
          currentPrice: '19.9900',
          newPrice: '27.9900',
          atFloor: false,
        },
        {
          serviceId: w.check,
          name: 'iCloud Clean / Lost Check',
          code: 'IMEI-ICL-CHK',
          cost: '0.0800',
          floorPrice: '0.1400',
          currentPrice: '0.1400',
          newPrice: '0.1600',
          atFloor: false,
        },
      ],
      truncated: false,
    });
    expect(await counts()).toEqual(before);
    expect(await catalogVersionOf(t)).toBe(version);
  });

  it('previews a delete: with no rule left the prices stay; with a general rule they fall back to it', async () => {
    const w = await following();
    const alone = await admin.post('/admin/retail-price-rules/preview', { change: { kind: 'delete', id: w.rule.id } });
    expect(alone.body).toMatchObject({ following: 2, changes: 0, noRule: 2, lines: [], truncated: false });

    await createRule({ scope: 'global', percent: '50', rounding: 'cent' });
    const before = await counts();
    const res = await admin.post('/admin/retail-price-rules/preview', { change: { kind: 'delete', id: w.rule.id } });
    // AT&T: 13.50 x 1.5 = 20.25 (raised from 19.99); the check: 0.12 is lifted to the floor 0.14 (no change).
    expect(res.body).toMatchObject({ following: 2, changes: 1, raised: 1, lowered: 0, atFloor: 1, noRule: 0 });
    expect(res.body.lines).toEqual([expect.objectContaining({ serviceId: w.att, newPrice: '20.2500' })]);
    expect(await counts()).toEqual(before);
  });

  it('previews a create: a category rule takes over its services, a switched-off one changes nothing', async () => {
    const w = await following();
    const res = await admin.post('/admin/retail-price-rules/preview', {
      change: {
        kind: 'create',
        rule: { scope: 'category', categoryId: w.categoryId, percent: '10', rounding: 'cent' },
      },
    });
    // AT&T: 14.85 is lifted to the floor 19.01 (lowered from 19.99); the check stays at its floor 0.14.
    expect(res.body).toMatchObject({ following: 2, changes: 1, raised: 0, lowered: 1, atFloor: 2, noRule: 0 });
    expect(res.body.lines).toEqual([
      expect.objectContaining({ serviceId: w.att, currentPrice: '19.9900', newPrice: '19.0100', atFloor: true }),
    ]);
    const off = await admin.post('/admin/retail-price-rules/preview', {
      change: {
        kind: 'create',
        rule: { scope: 'category', categoryId: w.categoryId, percent: '10', rounding: 'cent', isActive: false },
      },
    });
    expect(off.body).toMatchObject({ following: 2, changes: 0 });
    // A server rule cannot reach IMEI services.
    const server = await admin.post('/admin/retail-price-rules/preview', {
      change: { kind: 'create', rule: { scope: 'type', serviceType: 'server', percent: '10', rounding: 'cent' } },
    });
    expect(server.body).toMatchObject({ following: 0, changes: 0, lines: [] });
  });

  it('counts a follower whose price was changed another way in `following` and in no other figure', async () => {
    const w = await following();
    // AT&T's retail row no longer holds the price its follow row applied: the pass detaches such a service, it does not
    // reprice it, so the preview leaves it out of changes, atFloor and noRule.
    await (
      await db()
    ).execute(
      sql`update service_group_prices set price = '21.0000' where service_id = ${w.att} and group_id = ${w.groups.retail}`,
    );
    const update = await admin.post('/admin/retail-price-rules/preview', {
      change: { kind: 'update', id: w.rule.id, rule: { percent: '100' } },
    });
    expect(update.body).toMatchObject({ following: 2, changes: 1, raised: 1, lowered: 0, atFloor: 0, noRule: 0 });
    expect(update.body.lines).toEqual([expect.objectContaining({ serviceId: w.check, newPrice: '0.1600' })]);
    // With no rule left only the check waits for one.
    const gone = await admin.post('/admin/retail-price-rules/preview', { change: { kind: 'delete', id: w.rule.id } });
    expect(gone.body).toMatchObject({ following: 2, changes: 0, atFloor: 0, noRule: 1, lines: [] });
    // With a 10 % category rule only the check is held at its floor (AT&T would be too, were it still following).
    const low = await admin.post('/admin/retail-price-rules/preview', {
      change: {
        kind: 'create',
        rule: { scope: 'category', categoryId: w.categoryId, percent: '10', rounding: 'cent' },
      },
    });
    expect(low.body).toMatchObject({ following: 2, changes: 0, atFloor: 1, noRule: 0, lines: [] });
  });

  it('answers the 422s of the write it previews, with the fields under change.rule', async () => {
    const w = await following();
    const duplicate = await admin.post('/admin/retail-price-rules/preview', {
      change: { kind: 'create', rule: IMEI_30 },
    });
    expect(duplicate.status).toBe(422);
    expect(fieldsOf(duplicate.body)).toEqual(['change.rule.scope:duplicate']);
    const misfit = await admin.post('/admin/retail-price-rules/preview', {
      change: { kind: 'create', rule: { scope: 'global', categoryId: w.categoryId, percent: '1', rounding: 'cent' } },
    });
    expect(fieldsOf(misfit.body)).toEqual(['change.rule.categoryId:invalid']);
    const limits = await admin.post('/admin/retail-price-rules/preview', {
      change: { kind: 'update', id: w.rule.id, rule: { percent: '1001' } },
    });
    expect(limits.status).toBe(422);
    expect(limits.body.errors[0].field).toBe('change.rule.percent');
    expect(
      (
        await admin.post('/admin/retail-price-rules/preview', {
          change: { kind: 'update', id: 999999, rule: { percent: '1' } },
        })
      ).status,
    ).toBe(404);
    expect((await admin.post('/admin/retail-price-rules/preview', { change: { kind: 'other' } })).status).toBe(422);
  });
});

describe('RetailPrices.set (the one writer of decision 040)', () => {
  it('refuses a price one cent under the floor for both origins, before any write', async () => {
    const w = await listingWorld(await db());
    const retail = t.app.get(RetailPrices);
    await insertRetailPrice(await db(), w.att, w.groups.retail, '25.9900');
    for (const origin of [{ kind: 'manual' }, { kind: 'rule', ruleId: 1, cost: Money.of('13.5') }] as const) {
      const refused = await (
        await db()
      )
        .transaction(async (tx) => {
          const quote = (await retail.quotes(tx, [w.att])).get(w.att)!;
          expect(quote.floor.toWire()).toBe('19.0100');
          await retail.set(tx, w.att, Money.of('19.00'), { origin, quote });
        })
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      expect(refused).toBeInstanceOf(RetailFloorError);
    }
    expect(await retailOf(w.att, w.groups.retail)).toBe('25.9900');
    expect(await followOf(w.att)).toBeUndefined();
  });

  it('refuses the quote of another service and a price that is not above zero, before any write', async () => {
    const w = await listingWorld(await db());
    const retail = t.app.get(RetailPrices);
    const attempt = async (quoteOf: number, price: string) =>
      (await db())
        .transaction(async (tx) => {
          await retail.lockLiveService(tx, w.att);
          const quote = (await retail.quotes(tx, [quoteOf])).get(quoteOf)!;
          await retail.set(tx, w.att, Money.of(price), { origin: { kind: 'manual' }, quote });
        })
        .then(
          () => undefined,
          (error: unknown) => error,
        );
    const otherQuote = await attempt(w.check, '25.0000');
    expect(otherQuote).toBeInstanceOf(Error);
    expect((otherQuote as Error).message).toContain('cannot price');
    expect(await attempt(w.att, '0')).toBeInstanceOf(RangeError);
    expect(await retailOf(w.att, w.groups.retail)).toBeNull();
    expect(await followOf(w.att)).toBeUndefined();
  });

  it('upserts the follow row for a rule price and deletes it for a typed one', async () => {
    const w = await listingWorld(await db());
    const rule = await createRule(IMEI_30);
    const retail = t.app.get(RetailPrices);
    const write = async (price: string, origin: Parameters<RetailPrices['set']>[3]['origin']) =>
      (await db()).transaction(async (tx) => {
        await retail.lockLiveService(tx, w.att);
        const quote = (await retail.quotes(tx, [w.att])).get(w.att)!;
        return retail.set(tx, w.att, Money.of(price), { origin, quote });
      });
    expect(await write('19.9900', { kind: 'rule', ruleId: rule.id, cost: Money.of('13.5') })).toBeNull();
    expect(await followOf(w.att)).toMatchObject({
      ruleId: rule.id,
      appliedPrice: '19.9900',
      appliedCost: '13.5000',
      appliedAt: clock.now(),
    });
    clock.advance(1000);
    expect((await write('20.9900', { kind: 'rule', ruleId: rule.id, cost: Money.of('14') }))?.toWire()).toBe('19.9900');
    expect(await followOf(w.att)).toMatchObject({
      appliedPrice: '20.9900',
      appliedCost: '14.0000',
      appliedAt: clock.now(),
    });
    expect((await write('22.0000', { kind: 'manual' }))?.toWire()).toBe('20.9900');
    expect(await followOf(w.att)).toBeUndefined();
    expect(await retailOf(w.att, w.groups.retail)).toBe('22.0000');
  });
});

describe('PATCH /admin/service-listings/:id with retailPricing', () => {
  it('writes the rule price of now, makes it follow, audits it and moves the version', async () => {
    const w = await world();
    const rule = await createRule(IMEI_30);
    const version = await catalogVersionOf(t);
    const res = await admin.patch(`/admin/service-listings/${w.attListing}`, { retailPricing: 'rule' });
    expect(res.status).toBe(200);
    // 13.50 x 1.30 = 17.55, lifted to the floor 19.01, then 19.99.
    expect(res.body).toMatchObject({
      retailPrice: '19.9900',
      retailPriceSource: 'rule',
      retailPriceRule: { id: rule.id, label: 'IMEI +30%, ends in .99' },
      retailPriceWaiting: false,
    });
    expect(await followOf(w.att)).toMatchObject({
      ruleId: rule.id,
      appliedPrice: '19.9900',
      appliedCost: '13.5000',
      appliedAt: clock.now(),
    });
    expect(await catalogVersionOf(t)).not.toBe(version);
    const audit = (await auditRows()).find((one) => one.action === 'changed retail price of')!;
    expect(audit).toMatchObject({ entityType: 'listing', entityId: w.attListing });
    expect(audit.before).toEqual({ retailPrice: null });
    expect(audit.after).toEqual({ retailPrice: '19.9900', pricing: 'rule', ruleId: rule.id, cost: '13.5000' });
  });

  it('a typed price afterwards turns following off', async () => {
    const w = await world();
    await createRule(IMEI_30);
    await admin.patch(`/admin/service-listings/${w.attListing}`, { retailPricing: 'rule' });
    const res = await admin.patch(`/admin/service-listings/${w.attListing}`, { retailPrice: '30.0000' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ retailPrice: '30.0000', retailPriceSource: 'manual', retailPriceRule: null });
    expect(await followOf(w.att)).toBeUndefined();
  });

  it('refuses no_rule, no_cost, a price sent too, and a locked service, writing nothing', async () => {
    const w = await world();
    const noRule = await admin.patch(`/admin/service-listings/${w.attListing}`, { retailPricing: 'rule' });
    expect(noRule.status).toBe(422);
    expect(noRule.body.errors).toEqual([
      { field: 'retailPricing', code: 'no_rule', message: 'No pricing rule covers this service.' },
    ]);
    // A switched-off rule covers nothing.
    await createRule({ ...IMEI_30, isActive: false });
    expect(
      fieldsOf((await admin.patch(`/admin/service-listings/${w.attListing}`, { retailPricing: 'rule' })).body),
    ).toEqual(['retailPricing:no_rule']);
    await createRule({ scope: 'global', percent: '30', rounding: 'cent' });

    const free = await insertService(await db(), w.categoryId, {
      name: 'Free check',
      cost: '0.0000',
      effectiveCost: '0.0000',
      basePrice: '0.1300',
    });
    const freeListing = await insertListingRow(await db(), free, { slug: 'free' });
    const noCost = await admin.patch(`/admin/service-listings/${freeListing}`, { retailPricing: 'rule' });
    expect(noCost.status).toBe(422);
    expect(noCost.body.errors).toEqual([
      { field: 'retailPricing', code: 'no_cost', message: 'This service has no cost, so a rule cannot price it.' },
    ]);

    const both = await admin.patch(`/admin/service-listings/${w.attListing}`, {
      retailPricing: 'rule',
      retailPrice: '25.0000',
    });
    expect(both.status).toBe(422);
    expect(fieldsOf(both.body)).toEqual(['retailPricing:conflict']);
    expect((await admin.patch(`/admin/service-listings/${w.attListing}`, { retailPricing: 'manual' })).status).toBe(
      422,
    );

    const b2b = await insertCategory(await db(), { name: 'Merchants only', allowedGroupIds: [w.groups.standard] });
    const locked = await insertService(await db(), b2b, { cost: '5.0000', effectiveCost: '5.0000' });
    const lockedListing = await insertListingRow(await db(), locked, { slug: 'locked' });
    const lock = await admin.patch(`/admin/service-listings/${lockedListing}`, { retailPricing: 'rule' });
    expect(lock.status).toBe(409);
    expect(lock.body.code).toBe('LISTING_LOCKED');

    for (const id of [w.att, free, locked]) {
      expect(await retailOf(id, w.groups.retail)).toBeNull();
      expect(await followOf(id)).toBeUndefined();
    }
    expect((await auditRows()).filter((one) => one.action === 'changed retail price of')).toEqual([]);
  });
});

describe('the three new keys of a listing row', () => {
  it('reads null without a price, manual for a typed price, rule with its rule for a following one', async () => {
    const w = await world();
    const none = await admin.get('/admin/service-listings?_sort=id');
    expect(
      none.body.map((row: Record<string, unknown>) => [
        row.retailPriceSource,
        row.retailPriceRule,
        row.retailPriceWaiting,
      ]),
    ).toEqual([
      [null, null, false],
      [null, null, false],
    ]);
    await insertRetailPrice(await db(), w.check, w.groups.retail, '3.9900');
    const rule = await createRule(IMEI_30);
    await admin.patch(`/admin/service-listings/${w.attListing}`, { retailPricing: 'rule' });
    const rows = (await admin.get('/admin/service-listings?_sort=id')).body as Array<Record<string, unknown>>;
    const byService = new Map(rows.map((row) => [row.serviceId, row]));
    expect(byService.get(w.att)).toMatchObject({
      retailPriceSource: 'rule',
      retailPriceRule: { id: rule.id, label: 'IMEI +30%, ends in .99' },
      retailPriceWaiting: false,
    });
    expect(byService.get(w.check)).toMatchObject({
      retailPriceSource: 'manual',
      retailPriceRule: null,
      retailPriceWaiting: false,
    });
    const shown = await admin.get(`/admin/service-listings/${w.checkListing}`);
    expect(shown.body).toMatchObject({ retailPriceSource: 'manual', retailPriceRule: null, retailPriceWaiting: false });
  });
});

describe('PUT /admin/services/:id/group-prices and following', () => {
  const put = (serviceId: number, prices: Array<{ groupId: number; price: string }>) =>
    admin.put(`/admin/services/${serviceId}/group-prices`, { prices });

  it('keeps following when the retail price is re-sent unchanged, and stops when it changes', async () => {
    const w = await world();
    await createRule(IMEI_30);
    await admin.patch(`/admin/service-listings/${w.attListing}`, { retailPricing: 'rule' });
    expect(
      (
        await put(w.att, [
          { groupId: w.groups.retail, price: '19.9900' },
          { groupId: w.groups.vip, price: '16.0000' },
        ])
      ).status,
    ).toBe(200);
    expect(await followOf(w.att)).toMatchObject({ appliedPrice: '19.9900' });
    expect((await put(w.att, [{ groupId: w.groups.retail, price: '21.0000' }])).status).toBe(200);
    expect(await followOf(w.att)).toBeUndefined();
    expect((await admin.get(`/admin/service-listings/${w.attListing}`)).body).toMatchObject({
      retailPrice: '21.0000',
      retailPriceSource: 'manual',
    });
  });

  it('stops following when the retail row is removed, and leaves the follow row alone on a refused save', async () => {
    const w = await world();
    await createRule(IMEI_30);
    await admin.patch(`/admin/service-listings/${w.attListing}`, { retailPricing: 'rule' });
    // Under the storefront floor: refused, nothing changes.
    expect((await put(w.att, [{ groupId: w.groups.retail, price: '19.0000' }])).status).toBe(422);
    expect(await followOf(w.att)).toMatchObject({ appliedPrice: '19.9900' });
    expect((await put(w.att, [{ groupId: w.groups.vip, price: '16.0000' }])).status).toBe(200);
    expect(await followOf(w.att)).toBeUndefined();
    expect(await retailOf(w.att, w.groups.retail)).toBeNull();
  });

  describe('a form that says what it loaded (retailPriceSeen)', () => {
    const save = (
      serviceId: number,
      prices: Array<{ groupId: number; price: string }>,
      retailPriceSeen: string | null,
    ) => admin.put(`/admin/services/${serviceId}/group-prices`, { prices, retailPriceSeen });

    /** The rule moved the following price from 19.99 to 21.99 after the form was opened. */
    async function movedSinceTheFormOpened(w: Awaited<ReturnType<typeof world>>) {
      await createRule(IMEI_30);
      await admin.patch(`/admin/service-listings/${w.attListing}`, { retailPricing: 'rule' });
      expect(await retailOf(w.att, w.groups.retail)).toBe('19.9900');
      const database = await db();
      await database
        .update(s.serviceGroupPrices)
        .set({ price: '21.9900' })
        .where(eq(s.serviceGroupPrices.serviceId, w.att));
      await database
        .update(s.retailPriceFollows)
        .set({ appliedPrice: '21.9900' })
        .where(eq(s.retailPriceFollows.serviceId, w.att));
    }

    it('a stale figure left in the retail box writes nothing: the moved price stays and keeps following', async () => {
      const w = await world();
      await movedSinceTheFormOpened(w);

      const res = await save(
        w.att,
        [
          { groupId: w.groups.retail, price: '19.9900' },
          { groupId: w.groups.vip, price: '16.0000' },
        ],
        '19.9900',
      );

      expect(res.status).toBe(200);
      expect(res.body).toContainEqual({ groupId: w.groups.retail, price: '21.9900' });
      expect(res.body).toContainEqual({ groupId: w.groups.vip, price: '16.0000' });
      expect(await retailOf(w.att, w.groups.retail)).toBe('21.9900');
      expect(await followOf(w.att)).toMatchObject({ appliedPrice: '21.9900' });
      expect((await admin.get(`/admin/service-listings/${w.attListing}`)).body).toMatchObject({
        retailPrice: '21.9900',
        retailPriceSource: 'rule',
      });
    });

    it('a form opened before the service had a retail price does not delete the one it has now', async () => {
      const w = await world();
      await movedSinceTheFormOpened(w);

      const res = await save(w.att, [{ groupId: w.groups.vip, price: '16.0000' }], null);

      expect(res.status).toBe(200);
      expect(res.body).toContainEqual({ groupId: w.groups.retail, price: '21.9900' });
      expect(await retailOf(w.att, w.groups.retail)).toBe('21.9900');
      expect(await followOf(w.att)).toMatchObject({ appliedPrice: '21.9900' });
    });

    it('a figure staff changed is theirs: it is written and following stops', async () => {
      const w = await world();
      await movedSinceTheFormOpened(w);

      const res = await save(w.att, [{ groupId: w.groups.retail, price: '25.0000' }], '19.9900');

      expect(res.status).toBe(200);
      expect(await retailOf(w.att, w.groups.retail)).toBe('25.0000');
      expect(await followOf(w.att)).toBeUndefined();
    });

    it('a retail box staff emptied removes the price and following stops', async () => {
      const w = await world();
      await movedSinceTheFormOpened(w);

      expect((await save(w.att, [{ groupId: w.groups.vip, price: '16.0000' }], '19.9900')).status).toBe(200);

      expect(await retailOf(w.att, w.groups.retail)).toBeNull();
      expect(await followOf(w.att)).toBeUndefined();
    });

    it('does not hold the retail box nobody touched to the floor, and still holds a figure staff typed', async () => {
      const w = await world();
      await movedSinceTheFormOpened(w);

      // The form loaded a figure that is under the floor now: saving a merchant price is not refused for it.
      const kept = await save(
        w.att,
        [
          { groupId: w.groups.retail, price: '1.0000' },
          { groupId: w.groups.vip, price: '16.0000' },
        ],
        '1.0000',
      );
      expect(kept.status).toBe(200);
      expect(await retailOf(w.att, w.groups.retail)).toBe('21.9900');

      expect((await save(w.att, [{ groupId: w.groups.retail, price: '1.0000' }], '21.9900')).status).toBe(422);
      expect(await retailOf(w.att, w.groups.retail)).toBe('21.9900');
    });

    it('refuses a seen figure that is not a money amount', async () => {
      const w = await world();
      const res = await admin.put(`/admin/services/${w.att}/group-prices`, { prices: [], retailPriceSeen: '19.99' });
      expect(res.status).toBe(422);
    });
  });
});
