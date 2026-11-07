// Integration tests of the system settings routes (feature 2a, resolution identity-platform-13): reading the flat object without
// secrets, and the allow-list of `PATCH /admin/settings` (the registry key, its validator, the cache invalidation and the audit
// row), through HTTP on the real application.
import { afterAll, beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { eq, sql } from 'drizzle-orm';
import { schema as s } from '../../src/infra/db';
import { IpRuleCache } from '../../src/modules/identity';
import { MaintenanceService, SettingsReader } from '../../src/modules/platform';
import { IMEI_RETENTION_MAX_DAYS } from '../../src/modules/platform/settings/settings-registry';
import { adminWith } from '../support/admin-api';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches } from '../support/auth';
import { TestClock } from '../support/clock';
import { closeTestDb, resetDb, testDb } from '../support/db';

const clock = new TestClock();
let t: TestApp;

beforeAll(async () => {
  t = await createTestApp({ clock });
});
beforeEach(async () => {
  clock.reset();
  await resetDb();
  await clearIdentityCaches(t);
  await t.app.get(IpRuleCache).invalidate();
  await t.app.get(MaintenanceService).invalidate();
});
afterAll(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await t.app.get(IpRuleCache).invalidate();
  await t.app.get(MaintenanceService).invalidate();
  await t.close();
  await closeTestDb();
});

const settingRows = async () => (await testDb()).db.select().from(s.settings).orderBy(s.settings.key);
const auditRows = async () => (await testDb()).db.select().from(s.auditLogs).orderBy(s.auditLogs.id);
const putSettings = async (values: Record<string, unknown>) => {
  const { db } = await testDb();
  await db.insert(s.settings).values(Object.entries(values).map(([key, value]) => ({ key, value })));
  await t.app.get(SettingsReader).invalidate();
};

describe('GET /admin/settings', () => {
  it('answers an empty object while nothing is set, and the flat object of every key with its JSON type otherwise', async () => {
    const reader = await adminWith(t, ['settings:read']);
    const empty = await reader.get('/admin/settings');
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual({});

    await putSettings({
      adminAllowlistOnly: false,
      imeiRetentionDays: 90,
      'payments.auto_credit_delay_minutes': 10,
      'sessions.staff_idle_minutes': 45,
      storefrontNote: 'Back on Monday',
      riskRules: { cardAttempts: { limit: 60, windowMinutes: 10 } },
      allowedCountries: ['JO', 'AE'],
    });
    // A JSON null (the column is NOT NULL, so it holds the JSON value `null`) is sent as null.
    const { db } = await testDb();
    await db.execute(sql`insert into settings (key, value) values ('nothing', 'null'::jsonb)`);
    await t.app.get(SettingsReader).invalidate();
    const res = await reader.get('/admin/settings');
    expect(res.body).toEqual({
      adminAllowlistOnly: false,
      imeiRetentionDays: 90,
      'payments.auto_credit_delay_minutes': 10,
      'sessions.staff_idle_minutes': 45,
      storefrontNote: 'Back on Monday',
      riskRules: { cardAttempts: { limit: 60, windowMinutes: 10 } },
      allowedCountries: ['JO', 'AE'],
      nothing: null,
    });
  });

  it('never sends a key whose name marks a secret', async () => {
    const reader = await adminWith(t, ['settings:read']);
    await putSettings({
      imeiRetentionDays: 30,
      smtpPassword: 'hunter2',
      telegramBotToken: '123:abc',
      webhookSecret: 'whsec_x',
      signingKey: 'k',
      stripeApiKey: 'sk_live_x',
      passwordHash: '$argon2id$x',
      totpSecretEnc: 'sealed',
      cookie: 'c',
      authorization: 'Bearer x',
      // Not secrets: the words only look alike.
      keyboardLayout: 'ar',
      tokenizerMode: 'fast',
    });
    const res = await reader.get('/admin/settings');
    expect(Object.keys(res.body).sort()).toEqual(['imeiRetentionDays', 'keyboardLayout', 'tokenizerMode']);
    expect(JSON.stringify(res.body)).not.toMatch(/hunter2|whsec_|sk_live|argon2id|sealed|Bearer/);
  });

  it('needs settings:read', async () => {
    const nobody = await adminWith(t, ['staff:read']);
    const refused = await nobody.get('/admin/settings');
    expect(refused.status).toBe(403);
    expect(refused.body.detail).toContain('settings:read');
    expect((await nobody.anonymous('GET', '/admin/settings')).status).toBe(401);
  });
});

describe('PATCH /admin/settings', () => {
  it('stores imeiRetentionDays and answers the whole settings object after the change, without secrets', async () => {
    const admin = await adminWith(t, ['settings:update']);
    await putSettings({ adminAllowlistOnly: false, smtpPassword: 'hunter2' });
    const res = await admin.patch('/admin/settings', { imeiRetentionDays: 30 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ adminAllowlistOnly: false, imeiRetentionDays: 30 });
    expect((await settingRows()).map((row) => [row.key, row.value])).toEqual([
      ['adminAllowlistOnly', false],
      ['imeiRetentionDays', 30],
      ['smtpPassword', 'hunter2'],
    ]);
    // Changing it again updates the same row.
    expect((await admin.patch('/admin/settings', { imeiRetentionDays: 45 })).body.imeiRetentionDays).toBe(45);
    const { db } = await testDb();
    expect(await db.select().from(s.settings).where(eq(s.settings.key, 'imeiRetentionDays'))).toHaveLength(1);
  });

  it('accepts the whole range 0 to 3650 and nothing outside it or that is not a whole JSON number (422 on the key)', async () => {
    const admin = await adminWith(t, ['settings:update']);
    expect(IMEI_RETENTION_MAX_DAYS).toBe(3650);
    for (const days of [0, 1, 90, 3650]) {
      const res = await admin.patch('/admin/settings', { imeiRetentionDays: days });
      expect(res.status, String(days)).toBe(200);
      expect(res.body.imeiRetentionDays).toBe(days);
    }
    const before = await settingRows();
    for (const bad of [-1, 3651, 1.5, '30', null, true, [30], { days: 30 }, Number.MAX_SAFE_INTEGER]) {
      const res = await admin.patch('/admin/settings', { imeiRetentionDays: bad });
      expect(res.status, JSON.stringify(bad)).toBe(422);
      expect(res.body.code).toBe('VALIDATION_FAILED');
      expect(res.body.errors.map((error: { field: string }) => error.field)).toEqual(['imeiRetentionDays']);
    }
    expect(await settingRows()).toEqual(before);
  });

  it('refuses any other key (422 with errors[].field = the key), the keys that have their own guarded routes among them', async () => {
    const admin = await adminWith(t, ['settings:update']);
    for (const key of [
      'adminAllowlistOnly',
      'maintenance',
      'riskRules',
      'storefrontPolicy',
      'madeUp',
      'sessions.staff_idle_minutes',
    ]) {
      const res = await admin.patch('/admin/settings', { [key]: 1 });
      expect(res.status, key).toBe(422);
      expect(res.body.errors).toEqual([expect.objectContaining({ field: key })]);
    }
    expect(await settingRows()).toHaveLength(0);
    expect(await auditRows()).toHaveLength(0);
  });

  it('judges every key of the patch and writes nothing when one is refused (one error per refused key)', async () => {
    const admin = await adminWith(t, ['settings:update']);
    const res = await admin.patch('/admin/settings', {
      imeiRetentionDays: 30,
      maintenance: {},
      other: 'x',
      adminAllowlistOnly: false,
    });
    expect(res.status).toBe(422);
    expect(res.body.errors.map((error: { field: string }) => error.field).sort()).toEqual([
      'adminAllowlistOnly',
      'maintenance',
      'other',
    ]);
    expect(await settingRows()).toHaveLength(0);
    expect(await auditRows()).toHaveLength(0);
  });

  it('refuses an empty body or an array (422)', async () => {
    const admin = await adminWith(t, ['settings:update']);
    const empty = await admin.patch('/admin/settings', {});
    expect(empty.status).toBe(422);
    expect(empty.body.errors[0].field).toBe('body');
    expect((await admin.patch('/admin/settings', [])).status).toBe(422);
    expect(await settingRows()).toHaveLength(0);
  });

  it('clears the settings snapshot and the maintenance state after the commit, and not when the patch is refused', async () => {
    const admin = await adminWith(t, ['settings:update']);
    const reader = t.app.get(SettingsReader);
    const maintenance = t.app.get(MaintenanceService);
    const readerSpy = spyOn(reader, 'invalidate');
    const maintenanceSpy = spyOn(maintenance, 'invalidate');
    try {
      // Warm the snapshot: it says "not set".
      expect(await reader.get('imeiRetentionDays')).toBeUndefined();
      expect((await admin.patch('/admin/settings', { imeiRetentionDays: 400 })).status).toBe(200);
      expect(readerSpy).toHaveBeenCalledTimes(1);
      expect(maintenanceSpy).toHaveBeenCalledTimes(1);
      // The snapshot was dropped: the next read sees the new value, not the cached "not set".
      expect(await reader.get('imeiRetentionDays')).toBe(400);

      expect((await admin.patch('/admin/settings', { imeiRetentionDays: -5 })).status).toBe(422);
      expect(readerSpy).toHaveBeenCalledTimes(1);
      expect(maintenanceSpy).toHaveBeenCalledTimes(1);
    } finally {
      readerSpy.mockRestore();
      maintenanceSpy.mockRestore();
    }
  });

  it('audits one row with the before and after of the changed keys, no secret in it, and the key as the label', async () => {
    const admin = await adminWith(t, ['settings:update'], { name: 'Rami K.', ip: '203.0.113.50' });
    await putSettings({ imeiRetentionDays: 90, smtpPassword: 'hunter2' });
    await admin.patch('/admin/settings', { imeiRetentionDays: 30 });
    await admin.patch('/admin/settings', { imeiRetentionDays: 0 });
    const [first, second] = await auditRows();
    expect(first).toMatchObject({
      action: 'changed settings',
      entityType: 'setting',
      entityId: 0,
      entityLabel: 'imeiRetentionDays',
      actorType: 'staff',
      actorId: admin.staffId,
      actorName: 'Rami K.',
      ip: '203.0.113.50',
    });
    expect(first!.before).toEqual({ imeiRetentionDays: 90 });
    expect(first!.after).toEqual({ imeiRetentionDays: 30 });
    expect(second!.before).toEqual({ imeiRetentionDays: 30 });
    expect(second!.after).toEqual({ imeiRetentionDays: 0 });
    expect(JSON.stringify(await auditRows())).not.toContain('hunter2');

    // The first change of a key that was never set has a null "before".
    await resetDb();
    await clearIdentityCaches(t);
    const another = await adminWith(t, ['settings:update']);
    await another.patch('/admin/settings', { imeiRetentionDays: 15 });
    expect((await auditRows())[0]!.before).toEqual({ imeiRetentionDays: null });
  });

  it('needs settings:update and a CSRF token', async () => {
    const reader = await adminWith(t, ['settings:read']);
    const refused = await reader.patch('/admin/settings', { imeiRetentionDays: 30 });
    expect(refused.status).toBe(403);
    expect(refused.body.detail).toContain('settings:update');
    const admin = await adminWith(t, ['settings:update']);
    const noCsrf = await admin.withoutCsrf('PATCH', '/admin/settings', { imeiRetentionDays: 30 });
    expect(noCsrf.status).toBe(403);
    expect(noCsrf.body.code).toBe('CSRF_FAILED');
    expect(await settingRows()).toHaveLength(0);
  });
});
