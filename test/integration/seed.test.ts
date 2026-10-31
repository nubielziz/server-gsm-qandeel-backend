// The seed framework (`bun run db:seed`): it loads the frontend demo state, is idempotent, mirrors the frontend mocks
// (ids, roles' permissions, rebased timestamps, 4-decimal money) and refuses production. Needs the frontend checkout.
import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { schema as s } from '../../src/infra/db';
import { demoStatePath, loadDemoState } from '../../scripts/seed/demo-state';
import { ROLES, permissionsOf } from '../../scripts/seed/identity';
import { runSeed } from '../../scripts/seed/run';
import { TEST_DATABASE_URL, closeTestDb, resetDb, testDb } from '../support/db';

const ROOT = join(import.meta.dir, '../..');
const frontendPresent = existsSync(demoStatePath());

beforeEach(resetDb);
afterAll(closeTestDb);

/** Everything the seeders write, as comparable JSON (ids ascending). */
async function snapshot() {
  const { db } = await testDb();
  return JSON.stringify({
    roles: await db.select().from(s.roles).orderBy(s.roles.id),
    staff: await db.select().from(s.staffUsers).orderBy(s.staffUsers.id),
    ipRules: await db.select().from(s.ipRules).orderBy(s.ipRules.id),
    settings: await db.select().from(s.settings).orderBy(s.settings.id),
    currencies: await db.select().from(s.currencies).orderBy(s.currencies.id),
    accounts: await db.select().from(s.ledgerAccounts).orderBy(s.ledgerAccounts.id),
  });
}

describe.skipIf(!frontendPresent)('runSeed', () => {
  it('writes the demo roles, staff, IP rules, settings, currencies and system accounts', async () => {
    const { db } = await testDb();
    const reports = await runSeed(db, await loadDemoState());
    expect(reports.map((r) => `${r.table}:${r.inserted}`)).toEqual([
      'roles:6',
      'staff_users:6',
      'ip_rules:7',
      'settings:1',
      'currencies:7',
      'ledger_accounts:12',
    ]);

    const staff = await db.select().from(s.staffUsers).orderBy(s.staffUsers.id);
    expect(staff.map((row) => [row.id, row.name, row.roleId, row.status])).toEqual([
      [1, 'Rami K.', 1, 'active'],
      [2, 'Lina S.', 4, 'active'],
      [3, 'Omar T.', 3, 'active'],
      [4, 'Dana M.', 2, 'active'],
      [5, 'Nadia H.', 5, 'invited'],
      [6, 'Yusuf A.', 6, 'suspended'],
    ]);
    // Credentials are left for P2.6; "Setup" created the owner, Rami created the rest; the demo names no suspender.
    expect(staff.every((row) => row.passwordHash === null && row.totpSecretEnc === null)).toBe(true);
    expect(staff.map((row) => row.createdBy)).toEqual([null, 1, 1, 1, 1, 1]);
    expect(staff[5]).toMatchObject({ suspendedBy: 1, suspendedReason: 'Left the team' });
    expect(staff[4]!.lastLoginAt).toBeNull();

    const rules = await db.select().from(s.ipRules).orderBy(s.ipRules.id);
    expect(rules.map((row) => [row.kind, row.scope, row.cidr, row.source, row.createdBy])).toEqual([
      ['allow', 'admin', '203.0.113.24/32', 'manual', 1],
      ['allow', 'admin', '203.0.113.31/32', 'manual', 1],
      ['allow', 'admin', '198.51.100.77/32', 'manual', 1],
      ['block', 'store', '192.0.2.0/24', 'auto', null],
      ['block', 'admin', '198.51.100.200/32', 'auto', null],
      ['block', 'api', '203.0.113.160/28', 'manual', 1],
      ['block', 'all', '198.51.100.231/32', 'manual', 1],
    ]);

    expect(await db.select({ key: s.settings.key, value: s.settings.value }).from(s.settings)).toEqual([
      { key: 'adminAllowlistOnly', value: true },
    ]);

    const accounts = await db.select().from(s.ledgerAccounts);
    expect(accounts.map((row) => row.kind).sort()).toEqual(
      s.LEDGER_ACCOUNT_KINDS.filter(
        (kind) => !['client_wallet', 'client_hold', 'supplier_prepaid'].includes(kind),
      ).sort(),
    );
    expect(accounts.every((row) => row.currency === 'USD' && row.balance === '0.0000' && row.ownerId === null)).toBe(
      true,
    );
    expect(accounts.map((row) => row.kind)).toContain('owner_capital');

    const currencies = await db.select().from(s.currencies).orderBy(s.currencies.id);
    expect(currencies.map((row) => [row.id, row.code, row.rateToBase, row.markupPercent])).toEqual([
      [1, 'USD', '1.00000000', '0.0000'],
      [2, 'GBP', '0.79000000', '1.5000'],
      [3, 'EUR', '0.92000000', '1.5000'],
      [4, 'SEK', '10.60000000', '1.5000'],
      [5, 'CAD', '1.37000000', '1.5000'],
      [6, 'AED', '3.67000000', '1.5000'],
      [7, 'SAR', '3.75000000', '1.5000'],
    ]);
  });

  it('rebases timestamps to now', async () => {
    const { db } = await testDb();
    const before = Date.now();
    await runSeed(db, await loadDemoState());
    const [rami] = await db
      .select()
      .from(s.staffUsers)
      .where(sql`${s.staffUsers.id} = 1`);
    // The demo captured Rami's last sign-in about 12 minutes before its capture time.
    expect(before - rami!.lastLoginAt!.getTime()).toBeGreaterThan(0);
    expect(before - rami!.lastLoginAt!.getTime()).toBeLessThan(30 * 60_000);
  });

  it('is idempotent: a second run inserts nothing and changes nothing', async () => {
    const { db } = await testDb();
    const demo = await loadDemoState();
    await runSeed(db, demo);
    const first = await snapshot();
    // A later clock must not matter: existing rows are skipped, not rewritten.
    const second = await runSeed(db, await loadDemoState({ now: Date.now() + 3_600_000 }));
    expect(second.every((report) => report.inserted === 0)).toBe(true);
    expect(await snapshot()).toBe(first);
  });

  it('moves the id sequences past the seeded ids', async () => {
    const { db } = await testDb();
    await runSeed(db, await loadDemoState());
    const [role] = await db.insert(s.roles).values({ name: 'Auditor' }).returning({ id: s.roles.id });
    expect(role!.id).toBe(7);
    const [rule] = await db
      .insert(s.ipRules)
      .values({ kind: 'allow', scope: 'admin', cidr: '10.0.0.1' })
      .returning({ id: s.ipRules.id });
    expect(rule!.id).toBe(8);
  });

  it('grants each role the permissions the frontend mock grants', async () => {
    const { db } = await testDb();
    await runSeed(db, await loadDemoState());
    const rows = await db.select().from(s.roles).orderBy(s.roles.id);
    expect(rows.map((row) => row.name)).toEqual(ROLES.map((role) => role.name));
    expect(rows[0]!.permissions).toEqual(['*']);
    expect(rows[1]!.permissions).toContain('orders:*');
    expect(rows[1]!.permissions).toContain('staff:read');
    expect(rows[1]!.permissions).not.toContain('staff:*');
    expect(
      rows[5]!.permissions.every((permission) => permission === 'dashboard:read' || permission.endsWith(':read')),
    ).toBe(true);
    for (const row of rows)
      expect(row.permissions).toEqual(permissionsOf(ROLES.find((role) => role.id === row.id)!.key));
  });

  it('matches the frontend mock implementation when it can be imported', async () => {
    const mock = join(import.meta.dir, '../../../frontend-admin/src/mocks/roles.ts');
    if (!existsSync(mock)) return;
    const roles = (await import(mock)) as {
      permissionsOf: (key: string) => string[];
      ROLES: Array<{ key: string; id: number; name: string }>;
    };
    expect(roles.ROLES).toEqual(ROLES.map(({ key, id, name }) => ({ key, id, name })));
    for (const role of ROLES) expect(permissionsOf(role.key), role.key).toEqual(roles.permissionsOf(role.key));
  });
});

describe('bun run db:seed', () => {
  async function run(env: Record<string, string>) {
    const child = Bun.spawn([process.execPath, '--no-env-file', 'scripts/seed/index.ts'], {
      cwd: ROOT,
      // The child must seed the database this test resets (DATABASE_URL_TEST may point at a private database).
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '/tmp',
        DATABASE_URL_TEST: TEST_DATABASE_URL,
        ...env,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { stdout, stderr, code };
  }

  it('refuses NODE_ENV=production, even with an incomplete production environment', async () => {
    const result = await run({ NODE_ENV: 'production' });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('development only');
    expect(result.stdout).not.toContain('Seeding');
  });

  it.skipIf(!frontendPresent)(
    'runs twice against the test database without error',
    async () => {
      await testDb();
      const first = await run({ NODE_ENV: 'test' });
      expect(first.stderr).toBe('');
      expect(first.code).toBe(0);
      expect(first.stdout).toContain('roles            6 new, 0 already there');
      const second = await run({ NODE_ENV: 'test' });
      expect(second.code).toBe(0);
      expect(second.stdout).toContain('roles            0 new, 6 already there');
      expect(second.stdout).toContain('Seed finished.');
    },
    60_000,
  );
});
