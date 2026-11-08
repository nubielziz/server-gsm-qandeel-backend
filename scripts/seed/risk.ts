// Seeder of the risk module (feature 18): the demo's risk rules and policies, blocklist, IMEI check log, data requests and the risk
// assessments of the storefront orders the rules held, mapped as the frontend mocks map them (src/features/risk/mocks/seed.ts and
// src/features/customers/mocks/store.ts of the frontend): the same ids, kinds, displays, reasons and statuses. Runs after the customers,
// storefront and b2c seeders (the customers, the TAC catalogue and the storefront orders the assessments point at).
import { and, inArray, ne, or, sql } from 'drizzle-orm';
import type { AppConfig } from '../../src/config';
import { EncryptionService, TokenService } from '../../src/infra/crypto';
import { schema as s, type DbExecutor } from '../../src/infra/db';
import {
  IMEI_CHECK_AAD,
  type RiskRuleId,
  RISK_RULE_IDS,
  blockDisplay,
  blockHashInput,
  imeiHashInput,
  normalizeBlockValue,
} from '../../src/modules/risk';
import { type DemoSeed, demoNumericId, demoRows, toDate, toMoney } from './demo-state';
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
/** An IMEI check of the demo (`S.imeiChecks`). */
interface DemoCheck {
  id: string;
  ts: number;
  imei: string;
  brand: string;
  model: string;
  kind: 'blacklist' | 'basic' | 'icloud' | 'sim_lock';
  status: 'clean' | 'blacklisted' | 'locked' | 'unknown';
  source: 'pre_order' | 'storefront_free';
  country: string;
  cost: number;
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

/** The demo's rr1..rr8 become the console's rule ids (the frontend mock's mapping). */
const RULE_IDS: Readonly<Record<string, RiskRuleId>> = {
  rr1: 'blockBlacklistedImei',
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

/** The oldest checks the demo shows with their IMEI already erased (the mock hashes its six oldest). */
const ERASED_OLDEST = 6;

/** What a lookup returned, by kind (free-form on the real server). */
function resultOf(kind: DemoCheck['kind'], status: DemoCheck['status']): Record<string, unknown> {
  switch (kind) {
    case 'blacklist':
      return { blacklist: status === 'blacklisted' ? 'listed' : 'not listed' };
    case 'icloud':
      return { findMy: status === 'locked' ? 'on' : 'off' };
    case 'sim_lock':
      return { simLock: status === 'locked' ? 'locked' : status === 'clean' ? 'unlocked' : 'unknown' };
    case 'basic':
      return { stage: 'basic', checksum: 'valid', tac: 'known' };
  }
}

/**
 * Seeds the risk rules, the blocklist, the IMEI check log, the data requests and the assessments of the held and decided orders.
 *
 * Why: the console pointed at the real API should show the risk pages it knew from its mock. The rules go under the `riskRules`
 * setting (and `require3ds` is the storefront policy of the same name); the six oldest IMEI checks are erased like the retention job
 * would, so the mask shows. Blocklist values are stored hashed: an IMEI and a domain get their real hash (so they block), the masked
 * email and card of the demo have no readable value and hash their display text behind a `seed:` prefix, so they never match a real
 * one. The Risk page's queue and recent decisions are the demo's storefront orders whose rules said `review`: the unreviewed ones stay
 * held (dispatch state `held`) and the reviewed ones carry who decided and how. The orders the rules allowed get no row (the page does
 * not list them). Idempotent: rows that exist are skipped. Without `config` (no encryption keys) the IMEI checks are left out.
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

  // Rules and policies: the rules the risk module stores, `require3ds` as the policy, the retention days.
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
    ...(typeof policies.imeiRetentionDays === 'number'
      ? [{ key: 'imeiRetentionDays', value: policies.imeiRetentionDays }]
      : []),
  ];
  reports.push(await insertRows(db, s.settings, settings));
  await syncIdentity(db, s.settings);

  if (config) {
    const tokens = new TokenService(config);
    reports.push(await seedBlocklist(db, demo, tokens, staffIds));
    reports.push(await seedImeiChecks(db, demo, tokens, new EncryptionService(config)));
  }
  reports.push(await seedDataRequests(db, demo, staffIds));
  reports.push(await seedAssessments(db, demo, staffIds));
  return reports;
}

/**
 * Seeds the risk assessments of the demo's reviewed-by-rules storefront orders.
 *
 * Why: the console's Risk page lists the orders whose newest assessment says `review` and nobody decided, and the six latest decisions.
 * The ids are the demo's: the assessment of `SF-20490` is 20490 (the frontend mock's `id` too). An order that was not seeded (its customer
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
            .select({ id: s.orders.id, customerId: s.orders.customerId })
            .from(s.orders)
            .where(inArray(s.orders.id, orderIds))
        ).map((row) => [row.id, row.customerId]),
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
    if (stored.get(id) !== demoNumericId(order.cid!)) return [];
    // The assessment is made when the payment is captured, like the order's `paid` line.
    const at = toDate(order.events.find((event) => event.k === 'paid')?.ts ?? order.created + 2000)!;
    const decidedAt = toDate(order.risk.reviewedAt);
    return [
      {
        id,
        checkoutSessionId: id,
        orderId: id,
        customerId: demoNumericId(order.cid!),
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
      ? tokens.hash(blockHashInput(entry.kind, real.value))
      : tokens.hash(`seed:${entry.id}:${entry.display}`);
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

async function seedImeiChecks(
  db: DbExecutor,
  demo: DemoSeed,
  tokens: TokenService,
  encryption: EncryptionService,
): Promise<SeedReport> {
  const checks = demoRows<DemoCheck>(demo, 'imeiChecks');
  const tacs = new Set((await db.select({ tac: s.tacCatalog.tac }).from(s.tacCatalog)).map((row) => row.tac));
  const oldest = new Set(
    [...checks]
      .sort((a, b) => a.ts - b.ts)
      .slice(0, ERASED_OLDEST)
      .map((check) => check.id),
  );
  const report = await insertRows(
    db,
    s.imeiChecks,
    checks.map((check, index) => {
      const at = toDate(check.ts)!;
      const tac = check.imei.slice(0, 8);
      const erased = oldest.has(check.id);
      return {
        id: demoNumericId(check.id),
        imeiHash: erased ? null : tokens.hash(imeiHashInput(check.imei)),
        imeiEnc: erased ? null : encryption.encrypt(check.imei, IMEI_CHECK_AAD),
        tac: tacs.has(tac) ? tac : null,
        brand: check.brand,
        model: check.model,
        country: check.country,
        checkType: check.kind,
        status: check.status,
        result: resultOf(check.kind, check.status),
        source: check.source,
        cost: toMoney(check.cost),
        price: toMoney(0),
        ip: `203.0.113.${(index % 200) + 20}`,
        createdAt: at,
        updatedAt: at,
      };
    }),
  );
  await syncIdentity(db, s.imeiChecks);
  return report;
}

async function seedDataRequests(
  db: DbExecutor,
  demo: DemoSeed,
  staffIds: ReadonlyMap<string, number>,
): Promise<SeedReport> {
  // The customers seeder wrote the demo's customers by their demo ids; a request needs its customer.
  const existing = new Set((await db.select({ id: s.customers.id }).from(s.customers)).map((row) => row.id));
  const handler = staffIds.get('Rami K.') ?? null;
  const requests = demoRows<DemoRequest>(demo, 'dsr').filter((request) => existing.has(demoNumericId(request.cid)));
  const report = await insertRows(
    db,
    s.dataRequests,
    requests.map((request) => ({
      id: demoNumericId(request.id),
      customerId: demoNumericId(request.cid),
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
