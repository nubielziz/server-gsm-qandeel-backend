// The seed framework (`bun run db:seed`): it loads the frontend demo state, is idempotent, mirrors the frontend mocks
// (ids, roles' permissions, rebased timestamps, 4-decimal money) and refuses production. The demo's merchants are the accounts 1 to 20 and its
// customers the retail accounts 101 to 130 (decision 064). Needs the frontend checkout.
import { afterAll, beforeEach, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { type SQL, eq, sql } from 'drizzle-orm';
import { parseEnv } from '@src/config';
import { EncryptionService, PasswordHasher } from '@src/infra/crypto';
import { STAFF_TOTP_AAD } from '@src/modules/identity';
import { schema as s } from '@src/infra/db';
import { findBalanceDifferences } from '@src/modules/money/infra/ledger-read.repository';
import {
  CUSTOMER_ACCOUNT_OFFSET,
  INVENTED_ACCOUNT_ID_FIRST,
  accountIdOfDemo,
  customerAccountId,
  merchantAccountId,
} from '../../scripts/seed/account-ids';
import { demoRows, demoStatePath, frontendDir, loadDemoState } from '../../scripts/seed/demo-state';
import { ROLES, permissionsOf } from '../../scripts/seed/identity';
import { DEV_PASSWORD, DEV_TOTP_SECRETS, seedDevCredentials } from '../../scripts/seed/dev-credentials';
import { runSeed } from '../../scripts/seed/run';
import { TEST_DATABASE_URL, closeTestDb, resetDb, testDb } from '../support/db';

// The demo seed opens 20 merchant accounts and posts about 2,000 journals through postTransaction, one transaction each:
// several seconds per run, more on a busy machine, so these tests get a minute instead of the suite's 15 s.
setDefaultTimeout(60_000);

const ROOT = join(import.meta.dir, '../..');
const frontendPresent = existsSync(demoStatePath());

/**
 * Starts every test of the enclosing block from an empty database and leaves an empty one behind.
 *
 * Why: the seed turns the admin allowlist on and lists three office addresses, so nothing may be left behind, or the IP rules stage would
 * refuse the /admin requests of the files that run after this one. The block of pure tests below does not call it: it needs no database.
 */
function withEmptyDatabase(): void {
  beforeEach(resetDb);
  afterAll(async () => {
    await resetDb();
    await closeTestDb();
  });
}

/** Everything the seeders write, as comparable JSON (ids ascending). */
async function snapshot() {
  const { db } = await testDb();
  return JSON.stringify({
    roles: await db.select().from(s.roles).orderBy(s.roles.id),
    staff: await db.select().from(s.staffUsers).orderBy(s.staffUsers.id),
    ipRules: await db.select().from(s.ipRules).orderBy(s.ipRules.id),
    clientGroups: await db.select().from(s.clientGroups).orderBy(s.clientGroups.id),
    clients: await db.select().from(s.clients).orderBy(s.clients.id),
    legacyIds: await db.select().from(s.accountLegacyIds).orderBy(s.accountLegacyIds.id),
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

/** A count from one raw query (the queries below name fixed tables and words: nothing typed by a person reaches them). */
async function countOf(query: SQL): Promise<number> {
  const { db } = await testDb();
  const result = await db.execute<{ n: number }>(query);
  return Number(result.rows[0]!.n);
}

/** The demo's merchants and customers as the frontend stores them (the fields these tests read). */
interface DemoPerson {
  id: string;
}

describe('the account number rule', () => {
  it('keeps a merchant number and moves a customer number by 100, as the console mock does', () => {
    expect(CUSTOMER_ACCOUNT_OFFSET).toBe(100);
    expect([merchantAccountId(1), merchantAccountId(20)]).toEqual([1, 20]);
    expect([customerAccountId(1), customerAccountId(30)]).toEqual([101, 130]);
    expect(['m3', 'm20', 'c1', 'c30'].map(accountIdOfDemo)).toEqual([3, 20, 101, 130]);
    // The point of the move: customer 7 is account 107 and never names merchant 7.
    expect(accountIdOfDemo('c7')).not.toBe(accountIdOfDemo('m7'));
  });

  it('refuses a demo id that is neither a merchant nor a customer', () => {
    for (const id of ['ORD-48100', 'SF-20400', 'x5', 'c', 'm', '']) {
      expect(() => accountIdOfDemo(id), id).toThrow('Demo id');
    }
  });
});

describe.skipIf(!frontendPresent)('the account numbers of the demo', () => {
  it('numbers the twenty merchants 1 to 20 and the thirty customers 101 to 130 without a clash', async () => {
    const demo = await loadDemoState();
    const merchants = demoRows<DemoPerson>(demo, 'merchants').map((row) => accountIdOfDemo(row.id));
    const customers = demoRows<DemoPerson>(demo, 'customers').map((row) => accountIdOfDemo(row.id));
    expect(merchants).toEqual(Array.from({ length: 20 }, (_, index) => index + 1));
    expect(customers).toEqual(Array.from({ length: 30 }, (_, index) => index + 101));
    expect(new Set([...merchants, ...customers]).size).toBe(50);
    // The guest accounts the checkout seed invents stay clear of both lists.
    expect(INVENTED_ACCOUNT_ID_FIRST).toBeGreaterThan(Math.max(...customers));
  });
});

describe.skipIf(!frontendPresent)('runSeed', () => {
  withEmptyDatabase();

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
      reports.map((r) => (r.table === 'ledger_transactions' ? r.table : `${r.table}:${r.inserted}`)).slice(0, 15),
    ).toEqual([
      'roles:6',
      'staff_users:6',
      'ip_rules:7',
      'ip_rules:2',
      'client_groups:4',
      // The merchants are accounts 1 to 20, and each keeps its number in the legacy id map (decision 064).
      'clients:20',
      'account_legacy_ids:20',
      'settings:1',
      // Feature 12a: the platform seed also writes the demo's customer email templates and the notification log.
      // The abandoned-checkout mail and its 17 sent rows are retired (decision 062).
      'notification_templates:5',
      'notifications:293',
      // Feature 23: the notification center's three campaigns, the in-app items and the emails of the sent one.
      'notification_campaigns:3',
      'notification_inbox:3',
      'notifications (campaign emails):3',
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

    // The platform seeds the IP restriction; the risk seeder (feature 18) adds the risk rules and `require3ds`.
    const settings = await db.select({ key: s.settings.key, value: s.settings.value }).from(s.settings);
    expect(settings.find((row) => row.key === 'adminAllowlistOnly')).toEqual({
      key: 'adminAllowlistOnly',
      value: true,
    });
    expect(settings.map((row) => row.key).sort()).toEqual(['adminAllowlistOnly', 'require3ds', 'riskRules']);

    const accounts = await db.select().from(s.ledgerAccounts);
    const systemAccounts = accounts.filter((row) => row.ownerId === null);
    expect(systemAccounts.map((row) => row.kind).sort()).toEqual(
      s.LEDGER_ACCOUNT_KINDS.filter(
        (kind) => !['client_wallet', 'client_hold', 'supplier_prepaid', 'customer_wallet'].includes(kind),
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

  it('writes the twenty merchant accounts, with the ids, names and ranks of the frontend mocks', async () => {
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
    const kindOfRank = new Map(groups.map((row) => [row.id, row.kind]));

    // One table holds every account: the merchants are 1 to 20 (the demo's own numbers), the demo customers 101 to 130.
    const merchants = (await db.select().from(s.clients).orderBy(s.clients.id)).filter((row) => row.id <= 20);
    expect(merchants).toHaveLength(20);
    expect(merchants.map((row) => row.id)).toEqual(Array.from({ length: 20 }, (_, index) => index + 1));
    expect(merchants.every((row) => kindOfRank.get(row.groupId) === 'b2b' && row.hasAccount)).toBe(true);
    expect(merchants.slice(0, 3).map((row) => [row.name, row.country, row.groupId, row.status, row.email])).toEqual([
      ['Zain Mobile Hub', 'JO', 3, 'active', 'ops@zainmobilehub.example'],
      ['Al-Noor Telecom', 'SA', 2, 'active', 'ops@alnoortelecom.example'],
      ['Phone Doctor FZE', 'AE', 3, 'active', 'ops@phonedoctorfze.example'],
    ]);
    expect(merchants[0]).toMatchObject({
      username: 'zain-mobile-hub',
      company: 'Zain Mobile Hub',
      referralCode: 'zain-mobile-hub',
      passwordHash: null,
      referredById: null,
      currency: null,
      marketingOptIn: false,
    });
    expect(merchants[0]!.createdAt.getTime()).toBe(now - 410 * 86_400_000);
    expect(merchants[0]!.emailVerifiedAt!.getTime()).toBe(now - 410 * 86_400_000 + 3_600_000);
    // No referral link is seeded any more (decision 062); no account is pending any more (decision 064): the one demo merchant that still
    // was becomes a suspended account with a fixed reason, next to the suspended one, and the invited one is active, its email not proven yet.
    expect(merchants[7]).toMatchObject({ name: 'Casablanca Unlock', groupId: 2 });
    expect(merchants.every((row) => row.referredById === null)).toBe(true);
    expect(merchants.filter((row) => (row.status as string) === 'pending')).toEqual([]);
    expect(merchants.filter((row) => row.status === 'suspended').map((row) => row.id)).toEqual([19, 20]);
    expect(merchants[19]).toMatchObject({
      status: 'suspended',
      suspendedReason: 'Waiting for approval before the accounts were merged',
      emailVerifiedAt: null,
    });
    expect(merchants[19]!.suspendedAt).not.toBeNull();
    expect(merchants[17]).toMatchObject({ name: 'Algiers Service Plus', status: 'active', emailVerifiedAt: null });
    expect(merchants.filter((row) => row.emailVerifiedAt === null).map((row) => row.id)).toEqual([18, 20]);
    expect(new Set(merchants.map((row) => row.username)).size).toBe(20);
    expect(merchants.map((row) => row.referralCode)).toEqual(merchants.map((row) => row.username));
    // The money seed opens every merchant's wallet and hold with the account (resolution identity-platform-1), owned by `('account', id)`;
    // a retail account has none (its store balance opens with its first posting).
    const owned = (await db.select().from(s.ledgerAccounts)).filter((row) => row.ownerType !== null);
    expect(owned.every((row) => row.ownerType === 'account' || row.ownerType === 'supplier')).toBe(true);
    for (const kind of ['client_wallet', 'client_hold']) {
      const owners = owned.filter((row) => row.kind === kind).map((row) => row.ownerId!);
      expect(new Set(owners).size).toBe(20);
      expect(owners.every((id) => id <= 20)).toBe(true);
    }
    expect(owned.filter((row) => row.kind === 'customer_wallet')).toEqual([]);
  });

  it('writes the thirty demo customers as retail accounts 101 to 130, with the guests of the demo and of the left checkouts', async () => {
    const { db } = await testDb();
    const demo = await loadDemoState();
    await runSeed(db, demo);
    const rows = await db.select().from(s.clients).orderBy(s.clients.id);
    const [retail] = await db.select().from(s.clientGroups).where(eq(s.clientGroups.kind, 'b2c_retail'));

    const customers = rows.filter((row) => row.id > 100 && row.id < INVENTED_ACCOUNT_ID_FIRST);
    expect(customers.map((row) => row.id)).toEqual(Array.from({ length: 30 }, (_, index) => index + 101));
    expect(customers.every((row) => row.groupId === retail!.id)).toBe(true);
    expect(customers[0]).toMatchObject({
      id: 101,
      name: 'Daniel Whitmore',
      email: 'daniel.whitmore@mail.example',
      country: 'GB',
      currency: 'GBP',
      hasAccount: true,
      status: 'active',
      createdBy: null,
      passwordHash: null,
    });
    // A retail account has no username and no referral code; the demo customers who never made an account are guest rows (no sign-in).
    expect(customers.every((row) => row.username === null && row.referralCode === null)).toBe(true);
    expect(customers.filter((row) => row.hasAccount)).toHaveLength(10);
    expect(customers.filter((row) => !row.hasAccount)).toHaveLength(20);
    expect(
      customers.filter((row) => !row.hasAccount).every((row) => row.passwordHash === null && !row.twofaEnabled),
    ).toBe(true);
    expect(customers.filter((row) => row.status === 'blocked').map((row) => row.id)).toEqual([119]);
    expect(customers.filter((row) => row.status === 'suspended').map((row) => row.id)).toEqual([118]);

    // The guests of the left checkouts: one guest row per address, from 900 000, with no name and no sign-in.
    const guests = rows.filter((row) => row.id >= INVENTED_ACCOUNT_ID_FIRST);
    const leftAddresses = new Set(demoRows<{ email: string }>(demo, 'checkouts').map((row) => row.email.toLowerCase()));
    expect(guests).toHaveLength(leftAddresses.size);
    expect(guests.every((row) => !row.hasAccount && row.name === '' && row.groupId === retail!.id)).toBe(true);
    // The rest of the table is the 20 merchants: the accounts are the only rows the seed makes for a person.
    expect(rows).toHaveLength(20 + 30 + leftAddresses.size);

    // The next account somebody makes follows the demo ones: the ids of the guests above do not drag the sequence along.
    const [next] = await db
      .insert(s.clients)
      .values({ username: 'new', email: 'new@example.com', name: 'New', groupId: 1, referralCode: 'GSMNEW' })
      .returning({ id: s.clients.id });
    expect(next!.id).toBe(131);
  });

  it('keeps every old number in the legacy id map: merchant n is account n, customer n is account 100 + n', async () => {
    const { db } = await testDb();
    await runSeed(db, await loadDemoState());
    const rows = await db.select().from(s.accountLegacyIds).orderBy(s.accountLegacyIds.id);
    const clients = rows.filter((row) => row.legacyType === 'client');
    const customers = rows.filter((row) => row.legacyType === 'customer');
    expect(rows).toHaveLength(50);
    expect(clients.map((row) => [row.legacyId, row.accountId])).toEqual(
      Array.from({ length: 20 }, (_, index) => [index + 1, index + 1]),
    );
    expect(customers.map((row) => [row.legacyId, row.accountId])).toEqual(
      Array.from({ length: 30 }, (_, index) => [index + 1, index + 101]),
    );
    expect(rows.every((row) => !row.merged)).toBe(true);
    // The old customer number 7 finds the retail account, and the merchant with the same number is another person.
    const names = new Map((await db.select().from(s.clients)).map((row) => [row.id, row.name]));
    const customerSeven = customers.find((row) => row.legacyId === 7)!;
    const merchantSeven = clients.find((row) => row.legacyId === 7)!;
    expect(customerSeven.accountId).toBe(107);
    expect(names.get(customerSeven.accountId)).not.toBe(names.get(merchantSeven.accountId));
  });

  it('writes no old type word in a mutable column, and none in a row a writer makes now', async () => {
    const { db } = await testDb();
    await runSeed(db, await loadDemoState());
    // Mutable columns hold the one word `account`; the append-only ones refuse the old words in a new row (the NOT VALID current checks).
    const columns: ReadonlyArray<readonly [string, string, readonly string[]]> = [
      ['ledger_accounts', 'owner_type', ['client', 'customer']],
      ['notifications', 'recipient_type', ['client', 'customer']],
      ['notification_inbox', 'recipient_type', ['client', 'customer']],
      ['support_tickets', 'requester_type', ['client', 'customer']],
      ['ticket_messages', 'author_type', ['client', 'customer']],
      ['consent_records', 'subject_type', ['client', 'customer']],
      ['files', 'owner_type', ['client', 'customer']],
      ['refunds', 'requested_by_type', ['client', 'customer']],
      ['sessions', 'subject_type', ['client', 'customer']],
      ['ledger_transactions', 'ref_type', ['client', 'customer']],
      ['ledger_transactions', 'created_by_type', ['client', 'customer']],
      ['order_events', 'actor_type', ['client', 'customer']],
      ['audit_logs', 'actor_type', ['client', 'customer']],
      ['audit_logs', 'entity_type', ['client', 'customer', 'merchant']],
    ];
    for (const [table, column, words] of columns) {
      const found = await countOf(
        sql`select count(*)::int as n from ${sql.identifier(table)} where ${sql.identifier(column)} in (${sql.join(
          words.map((word) => sql`${word}`),
          sql`, `,
        )})`,
      );
      expect(found, `${table}.${column}`).toBe(0);
    }
    // And the words are there: the seed does write rows of accounts in each of the tables that name a person.
    for (const [table, column] of [
      ['ledger_accounts', 'owner_type'],
      ['notifications', 'recipient_type'],
      ['notification_inbox', 'recipient_type'],
      ['support_tickets', 'requester_type'],
      ['ticket_messages', 'author_type'],
      ['consent_records', 'subject_type'],
      ['refunds', 'requested_by_type'],
      ['order_events', 'actor_type'],
    ] as const) {
      const found = await countOf(
        sql`select count(*)::int as n from ${sql.identifier(table)} where ${sql.identifier(column)} = 'account'`,
      );
      expect(found, `${table}.${column}`).toBeGreaterThan(0);
    }
    // The books are the same as before the merge: nothing is out of balance.
    expect(await findBalanceDifferences(db)).toEqual([]);
  });

  it('puts every row about a person under the account number of that person', async () => {
    const { db } = await testDb();
    await runSeed(db, await loadDemoState());
    // Orders: a shop order belongs to a retail account (101 to 130) and has no merchant column; every other door belongs to a merchant
    // account (1 to 20) and repeats it in the old column.
    expect(await countOf(sql`select count(*)::int as n from orders where source = 'store'`)).toBe(104);
    expect(
      await countOf(
        sql`select count(*)::int as n from orders where source = 'store' and (account_id not between 101 and 130 or client_id is not null)`,
      ),
    ).toBe(0);
    expect(
      await countOf(
        sql`select count(*)::int as n from orders where source <> 'store' and (account_id not between 1 and 20 or client_id is distinct from account_id)`,
      ),
    ).toBe(0);
    // Money: the receipts, payments, refunds and disputes of the shop name the shopper's account; the merchants' top-ups and manual
    // invoices name the merchant's, with the wallet they fill.
    expect(await countOf(sql`select count(*)::int as n from refunds`)).toBe(11);
    expect(
      await countOf(
        sql`select count(*)::int as n from refunds where account_id not between 101 and 130 or account_id is null`,
      ),
    ).toBe(0);
    expect(await countOf(sql`select count(*)::int as n from disputes where account_id not between 101 and 130`)).toBe(
      0,
    );
    expect(
      await countOf(
        sql`select count(*)::int as n from invoices where kind in ('topup', 'manual') and (account_id not between 1 and 20 or wallet_kind <> 'client_wallet' or client_id is distinct from account_id)`,
      ),
    ).toBe(0);
    expect(
      await countOf(
        sql`select count(*)::int as n from invoices where kind = 'receipt' and (account_id not between 101 and 130 or wallet_kind is not null)`,
      ),
    ).toBe(0);
    expect(
      await countOf(
        sql`select count(*)::int as n from payments where (purpose = 'topup' and account_id not between 1 and 20) or (purpose = 'order' and account_id not between 101 and 130)`,
      ),
    ).toBe(0);
    // The checkouts: those that made a shop order are the shoppers', the ones that were left belong to the guest of their address.
    expect(
      await countOf(
        sql`select count(*)::int as n from checkout_sessions where (order_id is not null and account_id not between 101 and 130) or (order_id is null and (account_id is null or account_id < ${INVENTED_ACCOUNT_ID_FIRST}))`,
      ),
    ).toBe(0);
    // Support, risk and notices: the requester of a ticket is an account (customer c28 is 128, merchant m2 is 2).
    const tickets = await db
      .select()
      .from(s.supportTickets)
      .where(sql`${s.supportTickets.id} in (4202, 4214)`)
      .orderBy(s.supportTickets.id);
    expect(tickets.map((row) => [row.id, row.requesterType, row.requesterId, row.token === null])).toEqual([
      [4202, 'account', 128, false],
      [4214, 'account', 2, true],
    ]);
    const requests = await db.select().from(s.dataRequests).orderBy(s.dataRequests.id);
    expect(requests.map((row) => row.accountId)).toEqual([104, 116]);
    expect(
      await countOf(
        sql`select count(*)::int as n from notifications where dedupe_key like 'seed:customer:%' and recipient_id not between 101 and 130`,
      ),
    ).toBe(0);
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
    // A second run does not move the accounts' sequence to the guests that the left checkouts made (from 900 000).
    await runSeed(db, await loadDemoState());
    const [account] = await db
      .insert(s.clients)
      .values({ username: 'later', email: 'later@example.com', name: 'Later', groupId: 1, referralCode: 'GSMLATER' })
      .returning({ id: s.clients.id });
    expect(account!.id).toBe(131);
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

  it('grants the Accounts area as one: clients, wallet, groups and API keys, and the privacy permission last', () => {
    const accountAreas = ['clients', 'wallet', 'groups', 'api_keys'];
    // The roles that manage the area (Admin, Support) hold the four wildcards and the privacy permission, in the area's order, then the
    // next area's. `customers:*` is granted to nobody any more.
    for (const key of ['admin', 'support'] as const) {
      const granted = permissionsOf(key);
      const start = granted.indexOf('clients:*');
      expect(granted.slice(start, start + 5), key).toEqual([
        ...accountAreas.map((area) => `${area}:*`),
        'customers:privacy',
      ]);
    }
    // The roles that only look (Finance, Risk reviewer, Read only) hold the four reads and no privacy permission.
    for (const key of ['finance', 'risk', 'viewer'] as const) {
      const granted = permissionsOf(key);
      for (const area of accountAreas) expect(granted, `${key} ${area}`).toContain(`${area}:read`);
      expect(granted, key).not.toContain('customers:privacy');
    }
    for (const role of ROLES) {
      expect(permissionsOf(role.key), role.key).not.toContain('customers:*');
      expect(permissionsOf(role.key), role.key).not.toContain('customers:read');
    }
    expect(permissionsOf('owner')).toEqual(['*']);
  });

  it('matches the frontend mock implementation when it can be imported', async () => {
    // The frontend the seed reads (FRONTEND_DIR), not a fixed folder beside this repo.
    const mock = join(frontendDir(), 'src/mocks/roles.ts');
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
  withEmptyDatabase();
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
  withEmptyDatabase();

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
