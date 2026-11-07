// Integration tests of the nightly merchant group promotion (feature 4a, user rule 1): MerchantSpend over the real ledger, the
// promotion on a worker-like module graph, its schedule and its job_runs row. Spend is posted with postTransaction and the
// `order` and `complete` money event builders; reversals use the `reverse:<id>` key convention of decision 024.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { Money } from '../../src/common/money';
import { CacheModule } from '../../src/infra/cache';
import { CryptoModule } from '../../src/infra/crypto';
import { DbModule, DbService, type Database, schema as s } from '../../src/infra/db';
import { MetricsModule } from '../../src/infra/metrics';
import { JobSchedulerRegistry, QueueWorkers, QueueWorkersModule, QueuesModule } from '../../src/infra/queues';
import { RedisModule, RedisService } from '../../src/infra/redis';
import {
  GROUP_PROMOTION_JOB,
  GROUP_PROMOTION_SCHEDULER,
  GroupPromotion,
  GroupPromotionModule,
  PROMOTION_BATCH_SIZE,
  SessionService,
} from '../../src/modules/identity';
import { GroupPromotionProcessor } from '../../src/modules/identity/jobs/group-promotion.processor';
import {
  MerchantAccounts,
  MerchantSpend,
  b2cDeliver,
  complete,
  creditLine,
  debitLine,
  deposit,
  order,
  postTransaction,
} from '../../src/modules/money';
import { AuditService } from '../../src/modules/platform';
import { ClientGroupDirectory } from '../../src/modules/catalog';
import { MerchantWallets } from '../../src/modules/money';
import { insertMerchant } from '../support/auth';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { insertUsd } from '../support/fixtures';
import { createInfra, type InfraHarness } from '../support/infra';
import { deleteBullKeys, testBullPrefix } from '../support/queues';

const prefix = testBullPrefix();
let harness: InfraHarness;
let promotion: GroupPromotion;
let db: Database;

beforeAll(async () => {
  harness = await createInfra({
    modules: [
      MetricsModule,
      RedisModule,
      CacheModule,
      CryptoModule,
      DbModule,
      QueuesModule,
      QueueWorkersModule,
      GroupPromotionModule,
    ],
    env: { BULL_PREFIX: prefix },
  });
  await harness.get(QueueWorkers).whenReady();
  promotion = harness.get(GroupPromotion);
  db = (await testDb()).db;
});
beforeEach(resetDb);
afterAll(async () => {
  await resetDb();
  await harness.close();
  const cleaner = await createInfra({ modules: [MetricsModule, RedisModule] });
  await deleteBullKeys(cleaner.get(RedisService).queue, prefix);
  await cleaner.close();
  await closeTestDb();
});

interface Groups {
  standard: number;
  wholesale: number;
  vip: number;
  elite: number;
  retail: number;
}

/** Standard (default), Wholesale at 5000, VIP at 25000, Elite at 50000 without overdraft, and the storefront group. */
async function insertGroups(): Promise<Groups> {
  const [standard, wholesale, vip, elite, retail] = await db
    .insert(s.clientGroups)
    .values([
      { name: 'Standard', isDefault: true, sort: 1 },
      { name: 'Wholesale', earnThreshold: '5000', overdraftAllowed: true, sort: 2 },
      { name: 'VIP', earnThreshold: '25000', overdraftAllowed: true, sort: 3 },
      { name: 'Elite', earnThreshold: '50000', overdraftAllowed: false, sort: 4 },
      { name: 'Storefront retail', kind: 'b2c_retail', earnThreshold: '1', sort: 5 },
    ])
    .returning({ id: s.clientGroups.id });
  return { standard: standard!.id, wholesale: wholesale!.id, vip: vip!.id, elite: elite!.id, retail: retail!.id };
}

let refCounter = 0;
const SYSTEM = { type: 'system', id: null } as const;

async function post(posting: ReturnType<typeof order>, key: string, refId: number) {
  return db.transaction((tx) =>
    postTransaction(tx, { ...posting, refId, idempotencyKey: key, currency: 'USD', createdBy: SYSTEM }, new Date()),
  );
}

/** Funds the wallet, holds the price and completes the order: the merchant's completed spend rises by `price`. */
async function settleOrder(clientId: number, price: string): Promise<number> {
  const amount = Money.of(price);
  const id = ++refCounter;
  await post(deposit({ clientId, amount }), `fund:${id}`, id);
  await post(order({ clientId, amount }), `hold:${id}`, id);
  return (await post(complete({ clientId, price: amount }), `settle:${id}`, id)).id;
}

/** Reverses a settlement the way a reopen does: the revenue goes back to the hold, under the key `reverse:<id>`. */
async function reverseSettlement(clientId: number, settleTxId: number, price: string): Promise<void> {
  const amount = Money.of(price);
  await db.transaction((tx) =>
    postTransaction(
      tx,
      {
        kind: 'order_reopen',
        refType: 'order',
        refId: settleTxId,
        idempotencyKey: `reverse:${settleTxId}`,
        currency: 'USD',
        createdBy: SYSTEM,
        lines: [
          ...debitLine({ kind: 'revenue' }, amount),
          ...creditLine({ kind: 'client_hold', ownerType: 'client', ownerId: clientId }, amount),
        ],
      },
      new Date(),
    ),
  );
}

async function merchantIn(groupId: number, values: Partial<typeof s.clients.$inferInsert> = {}): Promise<number> {
  await insertUsd(db);
  const id = await insertMerchant(db, { groupId, ...values });
  await new MerchantAccounts().open(db, {
    clientId: id,
    currency: 'USD',
    creditLimit: '0.0000',
    overdraftAllowed: false,
  });
  return id;
}

const groupOf = async (clientId: number) =>
  (await db.select({ groupId: s.clients.groupId }).from(s.clients).where(eq(s.clients.id, clientId)))[0]!.groupId;
const promotionAudits = async () =>
  (await db.select().from(s.auditLogs).orderBy(s.auditLogs.id)).filter(
    // The nightly job is the only system actor that changes a merchant's group.
    (row) => row.action === 'changed group of' && row.actorType === 'system',
  );

describe('MerchantSpend.completedSpend', () => {
  it('sums the order_settle debits on each merchant hold, leaves reversed settlements out and ignores other kinds', async () => {
    const groups = await insertGroups();
    const a = await merchantIn(groups.standard);
    const b = await merchantIn(groups.standard);
    const idle = await merchantIn(groups.standard);
    await settleOrder(a, '100');
    const reversed = await settleOrder(a, '40');
    await settleOrder(a, '2.5');
    await settleOrder(b, '7');
    await reverseSettlement(a, reversed, '40');
    // A B2C delivery posts the same kind but debits customer_funds, never a merchant hold.
    await post(b2cDeliver({ net: Money.of('900') }), 'b2c:1', 1);
    // An order held but not completed is not spend.
    await post(deposit({ clientId: b, amount: Money.of('50') }), 'fund-b', 77);
    await post(order({ clientId: b, amount: Money.of('50') }), 'hold-b', 77);

    const spend = await new MerchantSpend().completedSpend(db, [a, b, idle, 999999]);
    expect(spend.get(a)!.toWire()).toBe('102.5000');
    expect(spend.get(b)!.toWire()).toBe('7.0000');
    expect(spend.get(idle)!.toWire()).toBe('0.0000');
    expect(spend.get(999999)!.toWire()).toBe('0.0000');
    expect((await new MerchantSpend().completedSpend(db, [])).size).toBe(0);
  });
});

describe('GroupPromotion.run', () => {
  it('promotes each merchant to the highest group its spend reaches, and audits it as the system', async () => {
    const groups = await insertGroups();
    const low = await merchantIn(groups.standard);
    const mid = await merchantIn(groups.standard);
    const high = await merchantIn(groups.standard);
    await settleOrder(low, '4999.9999');
    await settleOrder(mid, '5000');
    await settleOrder(high, '30000');

    const summary = await promotion.run();
    expect(summary).toEqual({ checked: 3, promoted: 2, skipped: 0 });
    expect(await groupOf(low)).toBe(groups.standard);
    expect(await groupOf(mid)).toBe(groups.wholesale);
    expect(await groupOf(high)).toBe(groups.vip);

    const audits = await promotionAudits();
    expect(audits).toHaveLength(2);
    expect(audits[0]).toMatchObject({
      actorType: 'system',
      actorId: null,
      entityType: 'merchant',
      entityId: mid,
      before: { groupId: groups.standard, group: 'Standard' },
      after: { groupId: groups.wholesale, group: 'Wholesale', spend: '5000.0000', earnThreshold: '5000.0000' },
    });
  });

  it('never demotes and never promotes into the storefront group or a zero-threshold group', async () => {
    const groups = await insertGroups();
    const inVip = await merchantIn(groups.vip);
    const inWholesale = await merchantIn(groups.wholesale);
    await db.insert(s.clientGroups).values({ name: 'Free', earnThreshold: '0' });
    await settleOrder(inWholesale, '6000');
    expect(await promotion.run()).toEqual({ checked: 2, promoted: 0, skipped: 0 });
    expect(await groupOf(inVip)).toBe(groups.vip);
    expect(await groupOf(inWholesale)).toBe(groups.wholesale);
    expect(await promotionAudits()).toEqual([]);
  });

  it('is idempotent: a second run promotes nobody and writes no second audit row', async () => {
    const groups = await insertGroups();
    const id = await merchantIn(groups.standard);
    await settleOrder(id, '26000');
    expect((await promotion.run()).promoted).toBe(1);
    expect(await promotion.run()).toEqual({ checked: 1, promoted: 0, skipped: 0 });
    expect(await groupOf(id)).toBe(groups.vip);
    expect(await promotionAudits()).toHaveLength(1);
  });

  it('promotes once when two runs overlap', async () => {
    const groups = await insertGroups();
    const ids = [
      await merchantIn(groups.standard),
      await merchantIn(groups.standard),
      await merchantIn(groups.standard),
    ];
    for (const id of ids) await settleOrder(id, '6000');
    const [one, two] = await Promise.all([promotion.run(), promotion.run()]);
    expect(one.promoted + two.promoted).toBe(3);
    for (const id of ids) expect(await groupOf(id)).toBe(groups.wholesale);
    expect(await promotionAudits()).toHaveLength(3);
  });

  it('counts a reversed settlement for nothing', async () => {
    const groups = await insertGroups();
    const id = await merchantIn(groups.standard);
    await settleOrder(id, '3000');
    const refunded = await settleOrder(id, '3000');
    expect((await promotion.run()).promoted).toBe(1);
    await db.update(s.clients).set({ groupId: groups.standard }).where(eq(s.clients.id, id));
    await reverseSettlement(id, refunded, '3000');
    expect(await promotion.run()).toEqual({ checked: 1, promoted: 0, skipped: 0 });
    expect(await groupOf(id)).toBe(groups.standard);
  });

  it('skips a promotion the credit rule refuses (target without overdraft, merchant with credit) and logs it', async () => {
    const groups = await insertGroups();
    // Elite has no overdraft; VIP allows it, so the merchant starts in VIP with a credit limit.
    const id = await merchantIn(groups.vip);
    await db.update(s.ledgerAccounts).set({ overdraftLimit: '500.0000' }).where(eq(s.ledgerAccounts.ownerId, id));
    await settleOrder(id, '60000');
    const refused = await promotion.run();
    expect(refused).toEqual({ checked: 1, promoted: 0, skipped: 1 });
    expect(await groupOf(id)).toBe(groups.vip);
    expect(await promotionAudits()).toEqual([]);

    await db.update(s.ledgerAccounts).set({ overdraftLimit: '0.0000' }).where(eq(s.ledgerAccounts.ownerId, id));
    expect(await promotion.run()).toEqual({ checked: 1, promoted: 1, skipped: 0 });
    expect(await groupOf(id)).toBe(groups.elite);
  });

  it('looks only at active merchants', async () => {
    const groups = await insertGroups();
    const active = await merchantIn(groups.standard);
    const suspended = await merchantIn(groups.standard, { status: 'suspended' });
    const pending = await merchantIn(groups.standard, { status: 'pending' });
    for (const id of [active, suspended, pending]) await settleOrder(id, '6000');
    expect(await promotion.run()).toEqual({ checked: 1, promoted: 1, skipped: 0 });
    expect(await groupOf(suspended)).toBe(groups.standard);
    expect(await groupOf(pending)).toBe(groups.standard);
  });

  it('does nothing without a group that has a threshold above zero', async () => {
    await db.insert(s.clientGroups).values({ name: 'Standard', isDefault: true });
    const id = await insertMerchant(db);
    void id;
    expect(await promotion.run()).toEqual({ checked: 0, promoted: 0, skipped: 0 });
  });

  it('reads every merchant across batches', async () => {
    const groups = await insertGroups();
    const total = PROMOTION_BATCH_SIZE * 2 + 37;
    await db.insert(s.clients).values(
      Array.from({ length: total }, (_, i) => ({
        username: `bulk-${i}`,
        email: `bulk-${i}@example.com`,
        name: `Bulk ${i}`,
        groupId: groups.standard,
        referralCode: `BULK-${i}`,
        status: 'active' as const,
      })),
    );
    const ids = (await db.select({ id: s.clients.id }).from(s.clients).orderBy(s.clients.id)).map((row) => row.id);
    const first = ids[0]!;
    const last = ids.at(-1)!;
    const middle = ids[PROMOTION_BATCH_SIZE + 5]!;
    await insertUsd(db);
    for (const id of [first, middle, last]) {
      await new MerchantAccounts().open(db, {
        clientId: id,
        currency: 'USD',
        creditLimit: '0.0000',
        overdraftAllowed: false,
      });
      await settleOrder(id, '6000');
    }
    expect(await promotion.run()).toEqual({ checked: total, promoted: 3, skipped: 0 });
    for (const id of [first, middle, last]) expect(await groupOf(id)).toBe(groups.wholesale);
  }, 60_000);

  it('clears the cached session views of a promoted merchant', async () => {
    const groups = await insertGroups();
    const id = await merchantIn(groups.standard);
    await settleOrder(id, '6000');
    const calls: Array<[string, number]> = [];
    const spy = {
      invalidateSubject: (type: string, subject: number) => (calls.push([type, subject]), Promise.resolve()),
    };
    const job = new GroupPromotion(
      harness.get(DbService),
      harness.get(ClientGroupDirectory),
      harness.get(MerchantSpend),
      harness.get(MerchantWallets),
      harness.get(AuditService),
      spy as unknown as SessionService,
    );
    expect((await job.run()).promoted).toBe(1);
    expect(calls).toEqual([['client', id]]);
  });
});

describe('the nightly job on a worker', () => {
  it('is scheduled at 03:30 UTC on the maintenance queue and its run is recorded in job_runs', async () => {
    expect(harness.get(JobSchedulerRegistry).list()).toContainEqual(
      expect.objectContaining({
        id: GROUP_PROMOTION_SCHEDULER,
        queue: 'maintenance',
        jobName: GROUP_PROMOTION_JOB,
        pattern: '30 3 * * *',
      }),
    );
    const groups = await insertGroups();
    const id = await merchantIn(groups.standard);
    await settleOrder(id, '6000');
    const processor = harness.get(GroupPromotionProcessor);
    const result = await processor.process({ data: {} } as Parameters<GroupPromotionProcessor['process']>[0]);
    expect(result).toEqual({ checked: 1, promoted: 1, skipped: 0 });
    const runs = await db.select().from(s.jobRuns).where(eq(s.jobRuns.job, GROUP_PROMOTION_JOB));
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      trigger: 'schedule',
      status: 'succeeded',
      processed: 1,
      result: { checked: 1, promoted: 1, skipped: 0 },
    });
    // A second run promotes nobody and records itself again.
    expect(await processor.process({ data: {} } as Parameters<GroupPromotionProcessor['process']>[0])).toEqual({
      checked: 1,
      promoted: 0,
      skipped: 0,
    });
    expect(await db.select().from(s.jobRuns).where(eq(s.jobRuns.job, GROUP_PROMOTION_JOB))).toHaveLength(2);
  });
});
