// The seed framework (`bun run db:seed`): it loads the frontend demo state, is idempotent, mirrors the frontend mocks
// (ids, roles' permissions, rebased timestamps, 4-decimal money) and refuses production. Needs the frontend checkout.
import { afterAll, beforeEach, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { parseEnv } from '../../src/config';
import { EncryptionService, PasswordHasher } from '../../src/infra/crypto';
import { STAFF_TOTP_AAD } from '../../src/modules/identity';
import { schema as s } from '../../src/infra/db';
import { findBalanceDifferences } from '../../src/modules/money/infra/ledger-read.repository';
import { demoStatePath, loadDemoState } from '../../scripts/seed/demo-state';
import { ROLES, permissionsOf } from '../../scripts/seed/identity';
import { DEV_PASSWORD, DEV_TOTP_SECRETS, seedDevCredentials } from '../../scripts/seed/dev-credentials';
import { runSeed } from '../../scripts/seed/run';
import { TEST_DATABASE_URL, closeTestDb, resetDb, testDb } from '../support/db';

// The demo seed opens 40 merchant accounts and posts about 2,000 journals through postTransaction, one transaction each:
// several seconds per run, more on a busy machine, so these tests get a minute instead of the suite's 15 s.
setDefaultTimeout(60_000);

const ROOT = join(import.meta.dir, '../..');
const frontendPresent = existsSync(demoStatePath());

beforeEach(resetDb);
// The seed turns the admin allowlist on and lists three office addresses: leave nothing behind, or the IP rules stage would
// refuse the /admin requests of the files that run after this one.
afterAll(async () => {
  await resetDb();
  await closeTestDb();
});

/** Everything the seeders write, as comparable JSON (ids ascending). */
async function snapshot() {
  const { db } = await testDb();
  return JSON.stringify({
    roles: await db.select().from(s.roles).orderBy(s.roles.id),
    staff: await db.select().from(s.staffUsers).orderBy(s.staffUsers.id),
    ipRules: await db.select().from(s.ipRules).orderBy(s.ipRules.id),
    clientGroups: await db.select().from(s.clientGroups).orderBy(s.clientGroups.id),
    clients: await db.select().from(s.clients).orderBy(s.clients.id),
    settings: await db.select().from(s.settings).orderBy(s.settings.id),
    currencies: await db.select().from(s.currencies).orderBy(s.currencies.id),
    accounts: await db.select().from(s.ledgerAccounts).orderBy(s.ledgerAccounts.id),
    categories: await db.select().from(s.serviceCategories).orderBy(s.serviceCategories.id),
    services: await db.select().from(s.services).orderBy(s.services.id),
    serviceFields: await db.select().from(s.serviceFields).orderBy(s.serviceFields.id),
    serviceOptions: await db.select().from(s.serviceOptions).orderBy(s.serviceOptions.id),
    groupPrices: await db.select().from(s.serviceGroupPrices).orderBy(s.serviceGroupPrices.id),
    codes: await db.select().from(s.inventoryCodes).orderBy(s.inventoryCodes.id),
  });
}

describe.skipIf(!frontendPresent)('runSeed', () => {
  it('writes the demo roles, staff, IP rules, client groups, merchants, settings, currencies and system accounts', async () => {
    const { db } = await testDb();
    const reports = await runSeed(db, await loadDemoState());
    // The ledger history is replayed through postTransaction: how many journals post depends on which demo merchants the
    // identity seed created (those journals are skipped otherwise), so the count is checked against the table.
    const journals = reports.find((r) => r.table === 'ledger_transactions')!;
    expect(journals.inserted).toBeGreaterThan(0);
    expect(journals.inserted).toBe(
      (await db.select({ n: sql<number>`count(*)::int` }).from(s.ledgerTransactions))[0]!.n,
    );
    expect(
      reports.map((r) => (r.table === 'ledger_transactions' ? r.table : `${r.table}:${r.inserted}`)).slice(0, 9),
    ).toEqual([
      'roles:6',
      'staff_users:6',
      'ip_rules:7',
      'ip_rules:2',
      'client_groups:4',
      'clients:20',
      'settings:1',
      'currencies:7',
      expect.stringMatching(/^ledger_accounts:\d+$/),
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
    // `runSeed` leaves the credentials empty (the development step is `seedDevCredentials`); "Setup" created the owner, Rami
    // created the rest; the demo names no suspender.
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
      // Local development: the console can sign in against a local API.
      ['allow', 'admin', '127.0.0.1/32', 'manual', null],
      ['allow', 'admin', '::1/128', 'manual', null],
    ]);

    expect(await db.select({ key: s.settings.key, value: s.settings.value }).from(s.settings)).toEqual([
      { key: 'adminAllowlistOnly', value: true },
    ]);

    const accounts = await db.select().from(s.ledgerAccounts);
    const systemAccounts = accounts.filter((row) => row.ownerId === null);
    expect(systemAccounts.map((row) => row.kind).sort()).toEqual(
      s.LEDGER_ACCOUNT_KINDS.filter(
        (kind) => !['client_wallet', 'client_hold', 'supplier_prepaid'].includes(kind),
      ).sort(),
    );
    expect(accounts.every((row) => row.currency === 'USD')).toBe(true);
    expect(accounts.map((row) => row.kind)).toContain('owner_capital');
    // The replayed history keeps the books: every journal sums to zero, and every balance is the sum of its entries.
    const [totals] = await db
      .select({ sum: sql<string>`coalesce(sum(${s.ledgerEntries.amount}), 0)::numeric(18,4)::text` })
      .from(s.ledgerEntries);
    expect(totals!.sum).toBe('0.0000');
    expect(await findBalanceDifferences(db)).toEqual([]);
    // The opening balance of the demo (25 000 in the bank against owner capital) is the first journal.
    const [opening] = await db.select().from(s.ledgerTransactions).orderBy(s.ledgerTransactions.id).limit(1);
    expect(opening).toMatchObject({
      kind: 'opening',
      refType: 'system',
      refId: 0,
      memo: 'Opening balance (owner capital)',
    });

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

  it('writes the demo merchants and their groups with the ids, names, groups and referrers of the frontend mocks', async () => {
    const { db } = await testDb();
    // A fixed "now": merchants joined N days ago, so the dates are exact.
    const now = Date.parse('2026-11-01T10:00:00.000Z');
    await runSeed(db, await loadDemoState({ now }));

    const groups = await db.select().from(s.clientGroups).orderBy(s.clientGroups.id);
    expect(
      groups.map((row) => [row.id, row.name, row.kind, row.discountPercent, row.isDefault, row.overdraftAllowed]),
    ).toEqual([
      [1, 'Standard', 'b2b', '0.0000', true, false],
      [2, 'Wholesale', 'b2b', '4.0000', false, true],
      [3, 'VIP', 'b2b', '8.0000', false, true],
      [4, 'Storefront retail', 'b2c_retail', '0.0000', false, false],
    ]);

    const merchants = await db.select().from(s.clients).orderBy(s.clients.id);
    expect(merchants).toHaveLength(20);
    expect(merchants.map((row) => row.id)).toEqual(Array.from({ length: 20 }, (_, index) => index + 1));
    expect(merchants.slice(0, 3).map((row) => [row.name, row.country, row.groupId, row.status, row.email])).toEqual([
      ['Zain Mobile Hub', 'JO', 3, 'active', 'ops@zainmobilehub.example'],
      ['Al-Noor Telecom', 'SA', 2, 'active', 'ops@alnoortelecom.example'],
      ['Phone Doctor FZE', 'AE', 3, 'active', 'ops@phonedoctorfze.example'],
    ]);
    expect(merchants[0]).toMatchObject({
      username: 'zain-mobile-hub',
      company: 'Zain Mobile Hub',
      referralCode: 'GSM0001',
      kycStatus: 'approved',
      passwordHash: null,
      referredById: null,
    });
    expect(merchants[0]!.createdAt.getTime()).toBe(now - 410 * 86_400_000);
    expect(merchants[0]!.emailVerifiedAt!.getTime()).toBe(now - 410 * 86_400_000 + 3_600_000);
    // Referrers, pending and suspended merchants, the in-review KYC.
    expect(merchants[7]).toMatchObject({ name: 'Casablanca Unlock', referredById: 1, groupId: 2 });
    expect(merchants[11]).toMatchObject({ name: 'Jeddah Tech Bar', referredById: 5 });
    expect(merchants.filter((row) => row.status === 'pending').map((row) => row.id)).toEqual([18, 20]);
    expect(merchants.filter((row) => row.status === 'suspended').map((row) => row.id)).toEqual([19]);
    expect(merchants[17]).toMatchObject({ kycStatus: 'pending', emailVerifiedAt: null });
    expect(new Set(merchants.map((row) => row.username)).size).toBe(20);
    expect(new Set(merchants.map((row) => row.referralCode)).size).toBe(20);
    // The money seed opens every merchant's wallet and hold with the merchant (resolution identity-platform-1).
    const owned = (await db.select().from(s.ledgerAccounts)).filter((row) => row.ownerType === 'client');
    for (const kind of ['client_wallet', 'client_hold']) {
      expect(new Set(owned.filter((row) => row.kind === kind).map((row) => row.ownerId)).size).toBe(20);
    }

    // The next merchant a staff member invites gets the next id.
    const [next] = await db
      .insert(s.clients)
      .values({ username: 'new', email: 'new@example.com', name: 'New', groupId: 1, referralCode: 'GSMNEW' })
      .returning({ id: s.clients.id });
    expect(next!.id).toBe(21);
  });

  it('rebases timestamps to now', async () => {
    const { db } = await testDb();
    // A fixed "now" (decision 031): the seed shifts every captured time by the distance to it, so the result is exact.
    const before = Date.parse('2026-11-01T10:00:00.000Z');
    await runSeed(db, await loadDemoState({ now: before }));
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
    const second = await runSeed(db, await loadDemoState({ now: Date.parse('2026-11-01T11:00:00.000Z') }));
    expect(second.filter((report) => report.inserted !== 0)).toEqual([]);
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
    expect(rule!.id).toBe(10);
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

describe.skipIf(!frontendPresent)('seedDevCredentials', () => {
  const config = parseEnv({ NODE_ENV: 'test' });

  it('gives the demo staff the development password and the members with 2FA their documented secret', async () => {
    const { db } = await testDb();
    await runSeed(db, await loadDemoState());
    const report = await db.transaction((tx) => seedDevCredentials(tx, config));
    expect(report).toMatchObject({ inserted: 6, existing: 0 });

    const staff = await db.select().from(s.staffUsers).orderBy(s.staffUsers.id);
    const hasher = new PasswordHasher(config);
    for (const row of staff) expect(await hasher.verify(row.passwordHash!, DEV_PASSWORD), row.email).toBe(true);
    const encryption = new EncryptionService(config);
    for (const row of staff) {
      const documented = DEV_TOTP_SECRETS[row.id];
      if (documented === undefined) expect(row.totpSecretEnc, row.email).toBeNull();
      else expect(encryption.decrypt(row.totpSecretEnc!, STAFF_TOTP_AAD), row.email).toBe(documented);
    }
    // Nadia is invited and has no 2FA yet: her secret comes from the setup step.
    expect(staff.find((row) => row.id === 5)).toMatchObject({ twofaEnabled: false, totpSecretEnc: null });
  });

  it('only fills what is empty: a changed password survives, and staff made later get nothing', async () => {
    const { db } = await testDb();
    await runSeed(db, await loadDemoState());
    await db.transaction((tx) => seedDevCredentials(tx, config));
    await db.update(s.staffUsers).set({ passwordHash: '$argon2id$changed' }).where(eq(s.staffUsers.id, 2));
    const [later] = await db
      .insert(s.staffUsers)
      .values({ email: 'later@example.com', name: 'Later', roleId: 1, status: 'invited' })
      .returning({ id: s.staffUsers.id });
    const again = await db.transaction((tx) => seedDevCredentials(tx, config));
    expect(again).toMatchObject({ inserted: 0, existing: 6 });
    const rows = await db.select().from(s.staffUsers).orderBy(s.staffUsers.id);
    expect(rows.find((row) => row.id === 2)!.passwordHash).toBe('$argon2id$changed');
    expect(rows.find((row) => row.id === later!.id)!.passwordHash).toBeNull();
  });
});

describe('bun run db:seed', () => {
  async function run(env: Record<string, string>) {
    const child = Bun.spawn([process.execPath, '--no-env-file', 'scripts/seed/index.ts'], {
      cwd: ROOT,
      // The child runs without env files, so it gets the test database explicitly (a worktree may use its own database).
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
