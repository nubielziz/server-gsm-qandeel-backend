// Seeder of the commissions module: the demo's two plans (plus the rebate plan the frontend mock adds), the plan of each demo agent as an
// assignment, and the demo's accruals linked to the seeded orders and, once approved, to their `commission` journals (the money seed
// replays the demo's journals first). The demo's referral links (`referred_by_id`) are seeded with the merchants by the identity seeder.
// Mapped exactly as the frontend mock maps them (src/features/commissions/mocks/seed.ts of the frontend).
import { and, eq, inArray } from 'drizzle-orm';
import { schema as s, type DbExecutor } from '../../src/infra/db';
import { type DemoSeed, demoNumericId, demoRows, toDate, toMoney } from './demo-state';
import { type SeedReport, insertRows, syncIdentity } from './helpers';

type DemoPlan = { id: string; name: string; basis: string; rate: number; minPayout: number };
type DemoAccrual = {
  id: string;
  agent: string;
  mid: string;
  orderId: string;
  base: number;
  rate: number;
  amount: number;
  created: number;
  status: 'accrued' | 'approved';
  approvedAt?: number;
};
type DemoMerchant = { id: string; plan: string | null; isAgent: boolean; joined: number };

const DAY_MS = 86_400_000;

/** A demo rate is a fraction (0.03); the API's percent is 3, with 4 decimals. */
const percentOf = (fraction: number): string => toMoney(Math.round(fraction * 1_000_000) / 10_000);

/**
 * Seeds the demo's commission plans, assignments and accruals.
 *
 * Why: seed = frontend mocks (decision 014): the console's Commissions page reads the demo's plans, agents and accruals through the real
 * API. Idempotent: rows with the demo's ids are skipped. An accrual whose order or merchants are not seeded is skipped with one log
 * line (the orders seeder runs first and creates every merchant order of the demo).
 *
 * @param db the transaction to write with
 * @param demo the loaded frontend demo state
 * @returns one report per table
 */
export async function seedCommissions(db: DbExecutor, demo: DemoSeed): Promise<SeedReport[]> {
  const now = demo.now;
  const demoPlans = demoRows<DemoPlan>(demo, 'plans');
  const planIds = new Set<number>();

  const planRows: Array<typeof s.commissionPlans.$inferInsert & { id: number }> = demoPlans.map((plan) => {
    const id = demoNumericId(plan.id);
    planIds.add(id);
    return {
      id,
      name: plan.name,
      kind: 'referral',
      basis: plan.basis,
      percent: percentOf(plan.rate),
      // The demo's minimum payout, and for the Partner plan its note ("agents who refer 3+ active merchants") as a condition.
      tiers:
        id === 2 ? { minPayout: toMoney(plan.minPayout), minReferrals: 3 } : { minPayout: toMoney(plan.minPayout) },
      period: 'monthly',
      isActive: true,
      createdAt: toDate(now - 400 * DAY_MS)!,
      updatedAt: toDate(now - 40 * DAY_MS)!,
    };
  });
  // The demo has no rebate plan; the console's mock makes one up (nobody is on it), and so does the seed, so both show the same plans.
  const rebateId = Math.max(0, ...planIds) + 1;
  planRows.push({
    id: rebateId,
    name: 'Volume rebate',
    kind: 'rebate',
    basis: 'Own order revenue of the merchant',
    percent: '1.5000',
    tiers: {
      brackets: [
        { from: '1000', percent: '1.0' },
        { from: '5000', percent: '1.5' },
      ],
    },
    period: 'monthly',
    isActive: true,
    createdAt: toDate(now - 30 * DAY_MS)!,
    updatedAt: toDate(now - 30 * DAY_MS)!,
  });

  const clientRows = await db.select({ id: s.clients.id }).from(s.clients);
  const clients = new Set(clientRows.map((row) => row.id));
  const agentPlan = new Map<number, number>();
  const assignmentRows: Array<typeof s.commissionAssignments.$inferInsert & { id: number }> = [];
  for (const merchant of demoRows<DemoMerchant>(demo, 'merchants').filter((m) => m.isAgent && m.plan)) {
    const beneficiaryId = demoNumericId(merchant.id);
    const planId = demoNumericId(merchant.plan!);
    if (!clients.has(beneficiaryId) || !planIds.has(planId)) continue;
    agentPlan.set(beneficiaryId, planId);
    const since = toDate(now - merchant.joined * DAY_MS)!;
    assignmentRows.push({
      id: assignmentRows.length + 1,
      planId,
      beneficiaryId,
      scope: 'referrals',
      startsAt: since,
      createdAt: since,
      updatedAt: since,
    });
  }

  const demoAccruals = demoRows<DemoAccrual>(demo, 'accruals');
  const orderIds = new Set(
    (
      await db
        .select({ id: s.orders.id })
        .from(s.orders)
        .where(
          inArray(
            s.orders.id,
            demoAccruals.map((accrual) => demoNumericId(accrual.orderId)),
          ),
        )
    ).map((row) => row.id),
  );
  // Each approved accrual has its own `commission` journal in the demo (reference = the accrual id): its ledger transaction is the
  // accrual's `ledger_tx_id`.
  const journals = await db
    .select({ id: s.ledgerTransactions.id, refId: s.ledgerTransactions.refId })
    .from(s.ledgerTransactions)
    .where(and(eq(s.ledgerTransactions.refType, 'accrual'), eq(s.ledgerTransactions.kind, 'commission')));
  const ledgerOf = new Map(journals.map((row) => [row.refId, row.id]));

  const accrualRows: Array<typeof s.commissionAccruals.$inferInsert & { id: number }> = [];
  let skipped = 0;
  for (const accrual of demoAccruals) {
    const id = demoNumericId(accrual.id);
    const beneficiaryId = demoNumericId(accrual.agent);
    const orderId = demoNumericId(accrual.orderId);
    const planId = agentPlan.get(beneficiaryId);
    if (planId === undefined || !orderIds.has(orderId) || !clients.has(demoNumericId(accrual.mid))) {
      skipped += 1;
      continue;
    }
    const approved = accrual.status === 'approved';
    accrualRows.push({
      id,
      planId,
      beneficiaryId,
      orderId,
      period: toDate(accrual.created)!.toISOString().slice(0, 7),
      basisAmount: toMoney(accrual.base),
      percent: percentOf(accrual.rate),
      amount: toMoney(accrual.amount),
      status: accrual.status,
      approvedAt: approved ? toDate(accrual.approvedAt ?? accrual.created) : null,
      ledgerTxId: approved ? (ledgerOf.get(id) ?? null) : null,
      createdAt: toDate(accrual.created)!,
      updatedAt: toDate(accrual.approvedAt ?? accrual.created)!,
    });
  }
  if (skipped > 0) {
    console.log(`  commissions skipped ${skipped} demo accruals of orders or merchants that are not seeded`);
  }

  const reports = [
    await insertRows(db, s.commissionPlans, planRows),
    await insertRows(db, s.commissionAssignments, assignmentRows),
    await insertRows(db, s.commissionAccruals, accrualRows),
  ];
  for (const table of [s.commissionPlans, s.commissionAssignments, s.commissionAccruals]) {
    await syncIdentity(db, table);
  }
  return reports;
}
