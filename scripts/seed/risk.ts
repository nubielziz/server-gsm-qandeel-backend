// Seeder of the risk module (feature 18): the demo's risk rules and policies, blocklist, data requests and the risk
// assessments of the storefront orders the rules held, mapped as the frontend mocks map them (src/features/risk/mocks/seed.ts and
// src/features/accounts/mocks/seed.ts of the frontend): the same ids, kinds, displays, reasons and statuses. A demo customer `cN` is the
// account `100 + N`, so the buyers of the held orders and the accounts of the data requests carry those numbers (decision 064). Runs after the
// customers, storefront and b2c seeders (the retail accounts, the TAC catalogue and the storefront orders the assessments point at).
import { and, inArray, ne, or, sql } from 'drizzle-orm';
import type { AppConfig } from '../../src/config';
import { TokenService } from '../../src/infra/crypto';
import { schema as s, type DbExecutor } from '../../src/infra/db';
import {
  type RiskRuleId,
  RISK_RULE_IDS,
  blockDisplay,
  blockHashInput,
  normalizeBlockValue,
} from '../../src/modules/risk';
import { accountIdOfDemo } from './account-ids';
import { type DemoSeed, demoNumericId, demoRows, toDate } from './demo-state';
import { type SeedReport, insertRows, syncIdentity } from './helpers';

/** A blocklist entry of the demo (`S.risk.block`). */
interface DemoBlock {
  id: string;
  kind: 'email' | 'card' | 'domain' | 'imei' | 'country';
  display: string;
  reason: string;
  source: 'manual' | 'auto' | 'chargeback';
  by: string;
  ts: number;
}
/** A rule of the demo (`S.risk.rules`). */
interface DemoRule {
  id: string;
  on: boolean;
  value: number | null;
}
/** A data request of the demo (`S.dsr`). */
interface DemoRequest {
  id: string;
  cid: string;
  kind: 'export' | 'erasure';
  status: 'open' | 'done';
  requested: number;
  due: number;
  done: number | null;
}
interface DemoAdmin {
  id: string;
  name: string;
}
/** A storefront order of the demo with the risk block the console's Risk page reads (`S.orders[].risk`). */
interface DemoRiskOrder {
  id: string;
  cid?: string;
  created: number;
  events: Array<{ ts: number; k: string }>;
  risk: {
    score: number;
    decision: 'allow' | 'review';
    signals: string[];
    reviewedBy: string | null;
    reviewedAt: number | null;
    outcome: 'approved' | 'refunded' | null;
  };
}

/** The demo's rr2..rr8 become the console's rule ids (the frontend mock's mapping; its rr1, the blacklisted-IMEI rule, has no rule here). */
const RULE_IDS: Readonly<Record<string, RiskRuleId>> = {
  rr2: 'reviewThreshold',
  rr3: 'blockThreshold',
  rr4: 'maxOrdersPerEmail',
  rr5: 'reviewFirstOrderAbove',
  rr6: 'require3ds',
  rr7: 'reviewIpCountryMismatch',
  rr8: 'blockDisposableEmail',
};

/** The country the demo's masked "Region under sanctions" entry stands for. */
const SANCTIONED_COUNTRY = 'KP';

/**
 * Seeds the risk rules, the blocklist, the data requests and the assessments of the held and decided orders.
 *
 * Why: the console pointed at the real API should show the risk pages it knew from its mock. The rules go under the `riskRules`
 * setting (and `require3ds` is the storefront policy of the same name). Blocklist values are stored hashed: an IMEI and a domain get their real hash (so they block), the masked
 * email and card of the demo have no readable value and hash their display text behind a `seed:` prefix, so they never match a real
 * one. The Risk page's queue and recent decisions are the demo's storefront orders whose rules said `review`: the unreviewed ones stay
 * held (dispatch state `held`) and the reviewed ones carry who decided and how. The orders the rules allowed get no row (the page does
 * not list them). Idempotent: rows that exist are skipped. Without `config` (no token pepper) the blocklist is left out.
 *
 * @param db the transaction to write with
 * @param demo the loaded frontend demo state
 * @param config the application configuration (the token pepper and the encryption keys)
 * @returns one report per table
 */
export async function seedRisk(db: DbExecutor, demo: DemoSeed, config?: AppConfig): Promise<SeedReport[]> {
  const reports: SeedReport[] = [];
  const demoState = demo.state as { risk?: { rules?: DemoRule[] }; settings?: { policies?: Record<string, unknown> } };
  const staffIds = new Map(demoRows<DemoAdmin>(demo, 'admins').map((admin) => [admin.name, demoNumericId(admin.id)]));

  // Rules and policies: the rules the risk module stores and `require3ds` as the policy.
  const rules = Object.fromEntries(
    (demoState.risk?.rules ?? []).flatMap((rule) => {
      const id = RULE_IDS[rule.id];
      return id === undefined || id === 'require3ds' ? [] : [[id, { on: rule.on, value: rule.value }]];
    }),
  );
  const policies = demoState.settings?.policies ?? {};
  const require3ds = (demoState.risk?.rules ?? []).find((rule) => RULE_IDS[rule.id] === 'require3ds')?.on;
  const settings = [
    ...(Object.keys(rules).length === RISK_RULE_IDS.length - 1 ? [{ key: 'riskRules', value: rules }] : []),
    ...(typeof (require3ds ?? policies.require3ds) === 'boolean'
      ? [{ key: 'require3ds', value: require3ds ?? policies.require3ds }]
      : []),
  ];
  reports.push(await insertRows(db, s.settings, settings));
  await syncIdentity(db, s.settings);

  if (config) {
    const tokens = new TokenService(config);
    reports.push(await seedBlocklist(db, demo, tokens, staffIds));
  }
  reports.push(await seedDataRequests(db, demo, staffIds));
  reports.push(await seedAssessments(db, demo, staffIds));
  return reports;
}

/**
 * Seeds the risk assessments of the demo's reviewed-by-rules storefront orders.
 *
 * Why: the console's Risk page lists the orders whose newest assessment says `review` and nobody decided, and the six latest decisions.
 * The ids are the demo's: the assessment of `SF-20490` is 20490 (the frontend mock's `id` too). An order that was not seeded (its account
 * or service is missing) is skipped. A held assessment puts its order in the review queue (`pending` and `held`), but only on the run that
 * inserts it, so a decision made later in a development database is not undone by seeding again.
 */
async function seedAssessments(
  db: DbExecutor,
  demo: DemoSeed,
  staffIds: ReadonlyMap<string, number>,
): Promise<SeedReport> {
  const reviewed = demoRows<DemoRiskOrder>(demo, 'orders').filter(
    (order) => order.cid !== undefined && order.risk?.decision === 'review',
  );
  const orderIds = reviewed.map((order) => demoNumericId(order.id));
  const stored = new Map(
    orderIds.length === 0
      ? []
      : (
          await db
            .select({ id: s.orders.id, accountId: s.orders.accountId })
            .from(s.orders)
            .where(inArray(s.orders.id, orderIds))
        ).map((row) => [row.id, row.accountId]),
  );
  const had = new Set(
    orderIds.length === 0
      ? []
      : (
          await db
            .select({ id: s.riskAssessments.id })
            .from(s.riskAssessments)
            .where(inArray(s.riskAssessments.id, orderIds))
        ).map((row) => row.id),
  );
  const rows = reviewed.flatMap((order) => {
    const id = demoNumericId(order.id);
    if (stored.get(id) !== accountIdOfDemo(order.cid!)) return [];
    // The assessment is made when the payment is captured, like the order's `paid` line.
    const at = toDate(order.events.find((event) => event.k === 'paid')?.ts ?? order.created + 2000)!;
    const decidedAt = toDate(order.risk.reviewedAt);
    return [
      {
        id,
        checkoutSessionId: id,
        orderId: id,
        accountId: accountIdOfDemo(order.cid!),
        score: order.risk.score,
        decision: 'review' as const,
        signals: order.risk.signals,
        provider: 'internal',
        reviewedBy: order.risk.reviewedBy === null ? null : (staffIds.get(order.risk.reviewedBy) ?? null),
        reviewedAt: decidedAt,
        outcome: order.risk.outcome,
        createdAt: at,
        updatedAt: decidedAt ?? at,
      },
    ];
  });
  const report = await insertRows(db, s.riskAssessments, rows);
  // The unreviewed ones wait in the queue: held, never sent to a supplier (the b2c seed already holds orders the demo shows in review).
  const newlyHeld = rows.filter((row) => row.reviewedAt === null && !had.has(row.id)).map((row) => row.orderId);
  if (newlyHeld.length > 0) {
    await db
      .update(s.orders)
      .set({ status: 'pending', dispatchState: 'held', updatedAt: sql`${s.orders.updatedAt}` })
      .where(
        and(inArray(s.orders.id, newlyHeld), or(ne(s.orders.dispatchState, 'held'), ne(s.orders.status, 'pending'))),
      );
  }
  await syncIdentity(db, s.riskAssessments);
  return report;
}

async function seedBlocklist(
  db: DbExecutor,
  demo: DemoSeed,
  tokens: TokenService,
  staffIds: ReadonlyMap<string, number>,
): Promise<SeedReport> {
  const block = (demo.state.risk as { block?: DemoBlock[] } | undefined)?.block ?? [];
  const entries = block.map((entry) => {
    // A value the display shows in full has a real hash; a masked one cannot be hashed back.
    const real =
      entry.kind === 'domain'
        ? normalizeBlockValue('domain', entry.display)
        : entry.kind === 'imei'
          ? normalizeBlockValue('imei', entry.display)
          : entry.kind === 'country'
            ? normalizeBlockValue('country', SANCTIONED_COUNTRY)
            : { ok: false as const, message: '' };
    const hash = real.ok
      ? tokens.lookupHash(blockHashInput(entry.kind, real.value))
      : tokens.lookupHash(`seed:${entry.id}:${entry.display}`);
    const at = toDate(entry.ts)!;
    return {
      id: demoNumericId(entry.id),
      kind: entry.kind,
      valueHash: hash,
      display: real.ok && entry.kind !== 'country' ? blockDisplay(entry.kind, real.value) : entry.display,
      reason: entry.reason,
      source: entry.source,
      createdBy: staffIds.get(entry.by) ?? null,
      createdAt: at,
      updatedAt: at,
    };
  });
  const report = await insertRows(db, s.blocklistEntries, entries);
  await syncIdentity(db, s.blocklistEntries);
  return report;
}

async function seedDataRequests(
  db: DbExecutor,
  demo: DemoSeed,
  staffIds: ReadonlyMap<string, number>,
): Promise<SeedReport> {
  // The customers seeder wrote the demo's retail accounts under their numbers (`c4` is account 104); a request needs its account.
  const existing = new Set((await db.select({ id: s.clients.id }).from(s.clients)).map((row) => row.id));
  const handler = staffIds.get('Rami K.') ?? null;
  const requests = demoRows<DemoRequest>(demo, 'dsr').filter((request) => existing.has(accountIdOfDemo(request.cid)));
  const report = await insertRows(
    db,
    s.dataRequests,
    requests.map((request) => ({
      id: demoNumericId(request.id),
      accountId: accountIdOfDemo(request.cid),
      kind: request.kind,
      // The demo says `done`, the API says `completed` (B51).
      status: request.status === 'done' ? ('completed' as const) : ('open' as const),
      requestedAt: toDate(request.requested)!,
      dueAt: toDate(request.due)!,
      completedAt: toDate(request.done),
      handledBy: request.status === 'done' ? handler : null,
      createdAt: toDate(request.requested)!,
      updatedAt: toDate(request.done ?? request.requested)!,
    })),
  );
  await syncIdentity(db, s.dataRequests);
  return report;
}
