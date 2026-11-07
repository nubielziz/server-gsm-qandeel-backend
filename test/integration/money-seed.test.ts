// The money seed with the demo merchants present: wallets are opened with the demo credit limits, and the demo's whole
// ledger history is replayed through postTransaction. The wallet figures must equal the demo's own (`wallet`, `hold`).
// The identity feature seeds the merchants in the real seed; this test inserts them with the demo ids and groups itself.
import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { schema as s } from '../../src/infra/db';
import { findBalanceDifferences } from '../../src/modules/money/infra/ledger-read.repository';
import { demoNumericId, demoRows, demoStatePath, loadDemoState, toMoney } from '../../scripts/seed/demo-state';
import { insertRows } from '../../scripts/seed/helpers';
import { runSeed } from '../../scripts/seed/run';
import { closeTestDb, resetDb, testDb } from '../support/db';

beforeEach(resetDb);
afterAll(async () => {
  await resetDb();
  await closeTestDb();
});

interface DemoMerchant {
  id: string;
  name: string;
  group: 'std' | 'whl' | 'vip';
  credit: number;
  email: string;
}

/** The demo's three groups: standard has no credit (rule 2), wholesale and VIP do. */
const GROUPS = {
  std: { id: 1, overdraft: false },
  whl: { id: 2, overdraft: true },
  vip: { id: 3, overdraft: true },
} as const;

async function insertDemoMerchants(demo: Awaited<ReturnType<typeof loadDemoState>>): Promise<DemoMerchant[]> {
  const { db } = await testDb();
  const merchants = demoRows<DemoMerchant>(demo, 'merchants');
  await insertRows(
    db,
    s.clientGroups,
    Object.entries(GROUPS).map(([key, group]) => ({
      id: group.id,
      name: key,
      isDefault: key === 'std',
      overdraftAllowed: group.overdraft,
    })),
  );
  await insertRows(
    db,
    s.clients,
    merchants.map((merchant) => ({
      id: demoNumericId(merchant.id),
      username: merchant.id,
      email: merchant.email,
      name: merchant.name,
      groupId: GROUPS[merchant.group].id,
      referralCode: `REF-${merchant.id}`,
      status: 'active' as const,
    })),
  );
  return merchants;
}

describe.skipIf(!existsSync(demoStatePath()))('the money seed with the demo merchants', () => {
  it('opens their wallets and replays the whole demo ledger to the demo balances', async () => {
    const { db } = await testDb();
    const demo = await loadDemoState();
    const merchants = await insertDemoMerchants(demo);
    const reports = await runSeed(db, demo);

    const journals = demoRows<{ id: string }>(demo, 'journals');
    expect(reports.find((report) => report.table === 'ledger_transactions')).toMatchObject({
      inserted: journals.length,
      existing: 0,
    });
    // The first run on an empty database numbers the journals as the demo does: JRN-00025 is journal 25.
    const [first, last] = await Promise.all([
      db.select().from(s.ledgerTransactions).orderBy(s.ledgerTransactions.id).limit(1),
      db
        .select()
        .from(s.ledgerTransactions)
        .orderBy(sql`${s.ledgerTransactions.id} desc`)
        .limit(1),
    ]);
    expect([first[0]!.id, last[0]!.id]).toEqual([1, journals.length]);

    const accounts = await db.select().from(s.ledgerAccounts);
    const figure = (kind: string, clientId: number) =>
      accounts.find((row) => row.kind === kind && row.ownerType === 'client' && row.ownerId === clientId);
    const wallets = demo.state.wallet as Record<string, number>;
    const holds = demo.state.hold as Record<string, number>;
    for (const merchant of merchants) {
      const clientId = demoNumericId(merchant.id);
      // The demo kept floats; the ledger keeps four decimals, so compare at two.
      expect(Number(figure('client_wallet', clientId)!.balance)).toBeCloseTo(wallets[merchant.id] ?? 0, 2);
      expect(Number(figure('client_hold', clientId)!.balance)).toBeCloseTo(holds[merchant.id] ?? 0, 2);
      // Credit limits follow rule 2: only the groups that allow credit keep the demo's limit.
      expect(figure('client_wallet', clientId)!.overdraftLimit).toBe(
        GROUPS[merchant.group].overdraft ? toMoney(merchant.credit) : '0.0000',
      );
    }

    const [totals] = await db
      .select({ sum: sql<string>`coalesce(sum(${s.ledgerEntries.amount}), 0)::numeric(18,4)::text` })
      .from(s.ledgerEntries);
    expect(totals!.sum).toBe('0.0000');
    expect(await findBalanceDifferences(db)).toEqual([]);
  }, 60_000);

  it('is idempotent: a second run posts nothing and leaves every balance and version alone', async () => {
    const { db } = await testDb();
    const demo = await loadDemoState();
    await insertDemoMerchants(demo);
    await runSeed(db, demo);
    const snapshot = async () => JSON.stringify(await db.select().from(s.ledgerAccounts).orderBy(s.ledgerAccounts.id));
    const before = await snapshot();
    const second = await runSeed(db, await loadDemoState({ now: Date.parse('2026-11-02T10:00:00.000Z') }));
    expect(second.find((report) => report.table === 'ledger_transactions')).toMatchObject({ inserted: 0 });
    expect(await snapshot()).toBe(before);
  }, 60_000);
});
