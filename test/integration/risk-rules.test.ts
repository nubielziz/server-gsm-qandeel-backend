// Integration tests of the risk rules (feature 18, GET and PUT /admin/risk/rules): the defaults of a shop that never saved, the
// validation, the audit trail per change, the shared `require3ds` value and the permissions.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { schema as s } from '../../src/infra/db';
import { type AdminApi, adminWith } from '../support/admin-api';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches } from '../support/auth';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { auditRows } from '../support/risk';

let t: TestApp;
let owner: AdminApi;

beforeAll(async () => {
  t = await createTestApp();
});
beforeEach(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  owner = await adminWith(t, ['risk:*']);
});
afterAll(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await t.close();
  await closeTestDb();
});

type Rule = { id: string; on: boolean; value: number | null; label?: string; hint?: string; unit?: string };
const ruleOf = (rules: Rule[], id: string) => rules.find((rule) => rule.id === id)!;
/** The whole set with one change applied, like the console sends it. */
const withChange = (rules: Rule[], id: string, change: Partial<Pick<Rule, 'on' | 'value'>>) => ({
  rules: rules.map(({ id: ruleId, on, value }) => ({ id: ruleId, on, value, ...(ruleId === id ? change : {}) })),
});

describe('GET /admin/risk/rules', () => {
  it('answers the eight rules in display order with the demo defaults, words and units', async () => {
    const res = await owner.get('/admin/risk/rules');
    expect(res.status).toBe(200);
    expect(res.res.headers['cache-control']).toBe('no-store');
    const rules: Rule[] = res.body.rules;
    expect(rules.map((rule) => rule.id)).toEqual([
      'blockBlacklistedImei',
      'reviewThreshold',
      'blockThreshold',
      'maxOrdersPerEmail',
      'reviewFirstOrderAbove',
      'require3ds',
      'reviewIpCountryMismatch',
      'blockDisposableEmail',
    ]);
    expect(ruleOf(rules, 'reviewThreshold')).toMatchObject({
      on: true,
      value: 50,
      unit: 'points',
      label: 'Hold orders scoring at least',
    });
    expect(ruleOf(rules, 'blockThreshold')).toMatchObject({ on: true, value: 80 });
    expect(ruleOf(rules, 'maxOrdersPerEmail')).toMatchObject({ on: true, value: 3, unit: 'orders' });
    expect(ruleOf(rules, 'reviewFirstOrderAbove')).toMatchObject({ on: true, value: 40, unit: 'USD' });
    expect(ruleOf(rules, 'blockBlacklistedImei')).toMatchObject({ on: true, value: null });
    expect(ruleOf(rules, 'blockDisposableEmail')).toMatchObject({ on: false, value: null });
  });

  it('needs risk:read, and the read-only role cannot save', async () => {
    const reader = await adminWith(t, ['risk:read']);
    expect((await reader.get('/admin/risk/rules')).status).toBe(200);
    const none = await adminWith(t, ['orders:read']);
    expect((await none.get('/admin/risk/rules')).status).toBe(403);
    const save = await reader.put('/admin/risk/rules', { rules: [{ id: 'reviewThreshold', on: true, value: 40 }] });
    expect(save.status).toBe(403);
  });
});

describe('PUT /admin/risk/rules', () => {
  it('saves one change, answers the saved set and keeps the other rules', async () => {
    const before: Rule[] = (await owner.get('/admin/risk/rules')).body.rules;
    const res = await owner.put('/admin/risk/rules', withChange(before, 'reviewThreshold', { value: 45 }));
    expect(res.status).toBe(200);
    expect(ruleOf(res.body.rules, 'reviewThreshold').value).toBe(45);
    expect(ruleOf(res.body.rules, 'blockThreshold').value).toBe(80);
    const again = await owner.get('/admin/risk/rules');
    expect(ruleOf(again.body.rules, 'reviewThreshold')).toMatchObject({ on: true, value: 45 });
  });

  it('audits each change with the demo’s phrases, and writes one entry even when nothing changed', async () => {
    const { db } = await testDb();
    const current = async (): Promise<Rule[]> => (await owner.get('/admin/risk/rules')).body.rules;
    await owner.put('/admin/risk/rules', withChange(await current(), 'blockDisposableEmail', { on: true }));
    await owner.put('/admin/risk/rules', withChange(await current(), 'blockDisposableEmail', { on: false }));
    await owner.put('/admin/risk/rules', withChange(await current(), 'maxOrdersPerEmail', { value: 5 }));
    await owner.put('/admin/risk/rules', withChange(await current(), 'reviewIpCountryMismatch', { on: false }));
    const rows = await auditRows(db, 'setting');
    expect(rows.map((row) => [row.action, row.entityLabel])).toEqual([
      ['turned on risk rule', 'Block disposable email domains'],
      ['turned off risk rule', 'Block disposable email domains'],
      ['changed risk rule', 'Maximum orders per email in 24 hours'],
      ['turned off risk rule', 'Hold when the IP country differs from the card country'],
    ]);
    expect(rows[2]).toMatchObject({ before: { value: 3 }, after: { value: 5 } });
    const empty = await owner.put('/admin/risk/rules', { rules: [] });
    expect(empty.status).toBe(200);
    expect((await auditRows(db, 'setting')).at(-1)!.action).toBe('saved risk rules');
  });

  it('refuses the review threshold at or above the block threshold with the console’s message on reviewThreshold', async () => {
    const before: Rule[] = (await owner.get('/admin/risk/rules')).body.rules;
    for (const value of [80, 90]) {
      const res = await owner.put('/admin/risk/rules', withChange(before, 'reviewThreshold', { value }));
      expect(res.status).toBe(422);
      expect(res.body.errors).toEqual([
        expect.objectContaining({
          field: 'reviewThreshold',
          message: 'The review threshold must be lower than the block threshold.',
        }),
      ]);
    }
    // The comparison ignores the switches, and nothing was saved.
    const off = withChange(before, 'reviewThreshold', { on: false, value: 85 });
    expect((await owner.put('/admin/risk/rules', off)).status).toBe(422);
    expect(ruleOf((await owner.get('/admin/risk/rules')).body.rules, 'reviewThreshold').value).toBe(50);
    const { db } = await testDb();
    expect(await auditRows(db, 'setting')).toEqual([]);
  });

  it('answers 422 on the id of an unknown rule, a fractional or negative value, and a number on a switch', async () => {
    const before: Rule[] = (await owner.get('/admin/risk/rules')).body.rules;
    const unknown = await owner.put('/admin/risk/rules', { rules: [{ id: 'nope', on: true, value: null }] });
    expect(unknown.status).toBe(422);
    expect(unknown.body.errors[0].field).toBe('nope');
    for (const value of [1.5, -1]) {
      const res = await owner.put('/admin/risk/rules', withChange(before, 'maxOrdersPerEmail', { value }));
      expect(res.status).toBe(422);
      expect(res.body.errors[0].field).toBe('maxOrdersPerEmail');
    }
    const onSwitch = await owner.put('/admin/risk/rules', withChange(before, 'require3ds', { value: 3 }));
    expect(onSwitch.status).toBe(422);
    expect(onSwitch.body.errors[0].field).toBe('require3ds');
    const bodyless = await owner.put('/admin/risk/rules', {});
    expect(bodyless.status).toBe(422);
  });

  it('shares require3ds with the storefront policy: one stored value', async () => {
    const { db } = await testDb();
    const before: Rule[] = (await owner.get('/admin/risk/rules')).body.rules;
    await owner.put('/admin/risk/rules', withChange(before, 'require3ds', { on: false }));
    const [policy] = await db.select().from(s.settings).where(eq(s.settings.key, 'require3ds'));
    expect(policy!.value).toBe(false);
    // A change of the policy shows in the rule.
    await db.update(s.settings).set({ value: true }).where(eq(s.settings.key, 'require3ds'));
    expect(ruleOf((await owner.get('/admin/risk/rules')).body.rules, 'require3ds').on).toBe(true);
    // The other seven rules live under one key.
    const [stored] = await db.select().from(s.settings).where(eq(s.settings.key, 'riskRules'));
    expect(Object.keys(stored!.value as object)).toHaveLength(7);
  });

  it('is one value for both routes: PATCH /admin/storefront/settings moves the risk rule, PUT /admin/risk/rules moves the policy', async () => {
    const storefront = await adminWith(t, ['settings:storefront', 'settings:read']);
    const rule = async () => ruleOf((await owner.get('/admin/risk/rules')).body.rules, 'require3ds').on;
    const policy = async () => (await storefront.get('/admin/settings')).body.require3ds;
    // Nothing saved yet: the rule starts on (the demo's default) and the checkout treats an unset policy as on.
    expect(await rule()).toBe(true);
    // Storefront to risk, both ways.
    expect((await storefront.patch('/admin/storefront/settings', { require3ds: false })).body.require3ds).toBe(false);
    expect(await rule()).toBe(false);
    expect((await storefront.patch('/admin/storefront/settings', { require3ds: true })).body.require3ds).toBe(true);
    expect(await rule()).toBe(true);
    // Risk to storefront, both ways: the policy the storefront settings answer follows the rule.
    const rules: Rule[] = (await owner.get('/admin/risk/rules')).body.rules;
    expect((await owner.put('/admin/risk/rules', withChange(rules, 'require3ds', { on: false }))).status).toBe(200);
    expect(await policy()).toBe(false);
    expect((await storefront.patch('/admin/storefront/settings', { require3ds: true })).body.require3ds).toBe(true);
    expect(await rule()).toBe(true);
    expect((await storefront.patch('/admin/storefront/settings', { require3ds: false })).body.require3ds).toBe(false);
    const again: Rule[] = (await owner.get('/admin/risk/rules')).body.rules;
    expect((await owner.put('/admin/risk/rules', withChange(again, 'require3ds', { on: true }))).status).toBe(200);
    expect(await policy()).toBe(true);
    // One row holds it, whichever route wrote it last.
    const { db } = await testDb();
    expect(await db.select().from(s.settings).where(eq(s.settings.key, 'require3ds'))).toHaveLength(1);
  });

  it('needs the literal risk:* (risk:read, risk:decide and risk:create are not enough)', async () => {
    const lesser = await adminWith(t, ['risk:read', 'risk:decide', 'risk:create', 'risk:delete']);
    const res = await lesser.put('/admin/risk/rules', { rules: [{ id: 'reviewThreshold', on: true, value: 40 }] });
    expect(res.status).toBe(403);
    const wildcard = await adminWith(t, ['*']);
    expect(
      (await wildcard.put('/admin/risk/rules', { rules: [{ id: 'reviewThreshold', on: true, value: 40 }] })).status,
    ).toBe(200);
  });
});
