// Seeder of the alert side of the health module (feature 12b): the ten alert rules, a month of resolved alerts, four resolved incidents and two
// weeks of nightly integrity runs, shaped like the frontend mock's calm story (src/features/system-health/mocks/seedRules.ts, seedAlerts.ts,
// seedIncidents.ts, seedIntegrity.ts). Nothing is open: the console opens on Operational.
//
// Each table is seeded only when it is empty (the evaluator's own alerts and the worker's own runs are the real data), and the integrity runs
// only when no integrity run exists, so a database seeded by feature 9 still gets them.
import { eq, sql } from 'drizzle-orm';
import { type DbExecutor, schema as s } from '../../src/infra/db';
import type {
  AlertChannel,
  AlertComparator,
  AlertSeverity,
  AlertSubjectType,
} from '../../src/modules/health/db/schema';
import { CHECK_KEYS, INTEGRITY_JOB, checkResult, integrityResult } from '../../src/modules/health/domain/integrity';
import { unitOf } from '../../src/modules/health/domain/metric-registry';
import type { DemoSeed } from './demo-state';
import { type SeedReport, insertRows, syncIdentity } from './helpers';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** The staff members the mock names, by the ids the identity seed gives the demo admins. */
const STAFF = { rami: 1, omar: 3, dana: 4 } as const;
const STAFF_NAMES: Readonly<Record<number, string>> = { 1: 'Rami K.', 3: 'Omar T.', 4: 'Dana M.' };

interface RuleSeed {
  key: string;
  name: string;
  metric: string;
  comparator: AlertComparator;
  threshold: number;
  windowSeconds: number;
  severity: AlertSeverity;
  channels: AlertChannel[];
  createdDaysAgo: number;
  isActive?: boolean;
  /** Muted for this many more hours. */
  mutedHours?: number;
}

/** The ten rules, ids 1 to 10 in this order (the mock's). */
const RULES: readonly RuleSeed[] = [
  {
    key: 'supplier_timeout_rate',
    name: 'Supplier timeouts',
    metric: 'supplier.timeout_rate',
    comparator: 'gt',
    threshold: 20,
    windowSeconds: 180,
    severity: 'critical',
    channels: ['telegram', 'email'],
    createdDaysAgo: 160,
  },
  {
    key: 'ledger_mismatch',
    name: 'Ledger mismatch',
    metric: 'ledger.mismatch_count',
    comparator: 'gt',
    threshold: 0,
    windowSeconds: 60,
    severity: 'critical',
    channels: ['telegram', 'email'],
    createdDaysAgo: 160,
  },
  {
    key: 'api_rate5xx',
    name: 'API 5xx rate',
    metric: 'api.rate5xx',
    comparator: 'gt',
    threshold: 2,
    windowSeconds: 300,
    severity: 'critical',
    channels: ['telegram', 'email'],
    createdDaysAgo: 140,
  },
  {
    key: 'api_p95_latency',
    name: 'API p95 latency',
    metric: 'api.p95',
    comparator: 'gt',
    threshold: 1500,
    windowSeconds: 300,
    severity: 'warning',
    channels: ['telegram'],
    createdDaysAgo: 140,
  },
  {
    key: 'queue_oldest_job',
    name: 'Oldest queued job',
    metric: 'queue.oldest_age',
    comparator: 'gt',
    threshold: 120,
    windowSeconds: 120,
    severity: 'warning',
    channels: ['telegram'],
    createdDaysAgo: 120,
  },
  {
    key: 'orders_past_sla',
    name: 'Orders past SLA',
    metric: 'orders.past_sla',
    comparator: 'gt',
    threshold: 20,
    windowSeconds: 300,
    severity: 'critical',
    channels: ['telegram', 'email'],
    createdDaysAgo: 120,
  },
  {
    key: 'db_connections',
    name: 'Database connections',
    metric: 'db.connection_usage',
    comparator: 'gt',
    threshold: 90,
    windowSeconds: 120,
    severity: 'critical',
    channels: ['telegram', 'email'],
    createdDaysAgo: 100,
  },
  {
    key: 'supplier_balance_low',
    name: 'Supplier balance low',
    metric: 'supplier.balance',
    comparator: 'lt',
    threshold: 150,
    windowSeconds: 3600,
    severity: 'warning',
    channels: ['email'],
    createdDaysAgo: 90,
    mutedHours: 20,
  },
  {
    key: 'redis_memory',
    name: 'Redis memory',
    metric: 'redis.memory_usage',
    comparator: 'gt',
    threshold: 85,
    windowSeconds: 300,
    severity: 'warning',
    channels: ['telegram'],
    createdDaysAgo: 60,
    isActive: false,
  },
  {
    key: 'webhook_failures',
    name: 'Webhook delivery',
    metric: 'webhooks.success_rate',
    comparator: 'lt',
    threshold: 95,
    windowSeconds: 600,
    severity: 'warning',
    channels: ['email'],
    createdDaysAgo: 45,
  },
];

interface Subject {
  type: AlertSubjectType;
  id: number | null;
  label: string | null;
}
const SYSTEM: Subject = { type: 'system', id: null, label: null };
const supplier = (id: number, label: string): Subject => ({ type: 'supplier', id, label });
const queue = (label: string): Subject => ({ type: 'queue', id: null, label });

interface AlertSeed {
  rule: string;
  subject: Subject;
  value: number;
  startedAgo: number;
  lasted: number;
  ackAfter?: number;
  ackBy?: keyof typeof STAFF;
  note?: string;
}

/** A month of resolved alerts, newest first here (written oldest first so the ids grow with time). */
const HISTORY: readonly AlertSeed[] = [
  { rule: 'api_p95_latency', subject: SYSTEM, value: 1720, startedAgo: 2 * DAY + 6 * HOUR, lasted: 11 * MINUTE },
  {
    rule: 'queue_oldest_job',
    subject: queue('orders.fetch'),
    value: 214,
    startedAgo: 3 * DAY + HOUR,
    lasted: 7 * MINUTE,
  },
  {
    rule: 'supplier_timeout_rate',
    subject: supplier(2, 'Gulf Server Hub'),
    value: 27.5,
    startedAgo: 6 * DAY + 14 * HOUR,
    lasted: 22 * MINUTE,
    ackAfter: 4 * MINUTE,
    ackBy: 'dana',
    note: 'Supplier is rate limiting us; they confirmed a fix.',
  },
  {
    rule: 'supplier_balance_low',
    subject: supplier(2, 'Gulf Server Hub'),
    value: 118.2,
    startedAgo: 8 * DAY,
    lasted: 2 * HOUR + 40 * MINUTE,
  },
  { rule: 'webhook_failures', subject: SYSTEM, value: 91.8, startedAgo: 10 * DAY + 3 * HOUR, lasted: 33 * MINUTE },
  { rule: 'api_rate5xx', subject: SYSTEM, value: 3.1, startedAgo: 12 * DAY + 9 * HOUR, lasted: 9 * MINUTE },
  { rule: 'db_connections', subject: SYSTEM, value: 93, startedAgo: 15 * DAY + 2 * HOUR, lasted: 14 * MINUTE },
  { rule: 'orders_past_sla', subject: SYSTEM, value: 26, startedAgo: 17 * DAY + 11 * HOUR, lasted: 38 * MINUTE },
  {
    rule: 'supplier_timeout_rate',
    subject: supplier(6, 'Bosphorus Unlock'),
    value: 21.8,
    startedAgo: 21 * DAY + 5 * HOUR,
    lasted: 17 * MINUTE,
  },
  // The ledger rule's subject is the platform (health-commissions-14): which wallet differed is in the integrity details, not on the alert.
  {
    rule: 'ledger_mismatch',
    subject: SYSTEM,
    value: 1,
    startedAgo: 27 * DAY + 4 * HOUR,
    lasted: 3 * HOUR + 5 * MINUTE,
    ackAfter: 12 * MINUTE,
    ackBy: 'omar',
    note: 'Reversing entry posted in Finance.',
  },
];

interface IncidentSeed {
  title: string;
  severity: 'minor' | 'major' | 'critical';
  components: string[];
  summary: string;
  startedAgo: number;
  /** Timeline lines: minutes after the start, status, text. The last is `resolved`. */
  lines: ReadonlyArray<readonly [number, 'investigating' | 'identified' | 'monitoring' | 'resolved', string]>;
  rootCause: string;
  by: keyof typeof STAFF;
}

const INCIDENTS: readonly IncidentSeed[] = [
  {
    title: 'Storefront checkout errors',
    severity: 'major',
    components: ['api', 'gateway:1'],
    summary: 'Card payments failed at the last step for about 25 minutes.',
    startedAgo: 41 * DAY,
    lines: [
      [0, 'investigating', 'Card payments fail at the last step. Looking at the gateway callbacks.'],
      [9, 'identified', 'The gateway changed its callback signature header.'],
      [18, 'monitoring', 'Callback check updated and deployed. Watching new payments.'],
      [26, 'resolved', 'Payments complete again. No money was lost; 14 paid orders were completed by hand.'],
    ],
    rootCause: 'The gateway renamed the signature header without notice. Our callback check now accepts both names.',
    by: 'rami',
  },
  {
    title: 'Order dispatch queue stalled',
    severity: 'major',
    components: ['workers'],
    summary: 'No orders were sent to suppliers for 1 hour 12 minutes.',
    startedAgo: 26 * DAY,
    lines: [
      [0, 'investigating', 'Orders wait in orders.dispatch and nothing is taken from the queue.'],
      [31, 'identified', 'Workers started with an old Redis key prefix after the last deploy.'],
      [58, 'monitoring', 'Workers restarted with the right prefix; the backlog is draining.'],
      [72, 'resolved', 'Backlog cleared. All delayed orders were sent.'],
    ],
    rootCause:
      'A deploy left the workers on an old Redis key prefix. The prefix now comes from one setting shared with the API.',
    by: 'dana',
  },
  {
    title: 'Gulf Server Hub rate limiting',
    severity: 'minor',
    components: ['supplier:2'],
    summary: 'The supplier answered 429 to about a third of our calls for two hours.',
    startedAgo: 17 * DAY,
    lines: [
      [0, 'investigating', 'Many 429 answers from Gulf Server Hub.'],
      [35, 'identified', 'The supplier lowered its limit to 30 calls a minute without telling us.'],
      [120, 'resolved', 'Our limit for this supplier is now 30 calls a minute.'],
    ],
    rootCause: 'The supplier changed its rate limit. We set our own limit per supplier to match.',
    by: 'dana',
  },
  {
    title: 'Card gateway callbacks delayed',
    severity: 'minor',
    components: ['gateway:1'],
    summary: 'Payment confirmations arrived up to ten minutes late.',
    startedAgo: 9 * DAY,
    lines: [
      [0, 'investigating', 'Payment confirmations are late.'],
      [20, 'identified', 'The gateway retries callbacks in bursts; our webhook worker was too slow.'],
      [47, 'resolved', 'Webhook worker concurrency raised; confirmations are on time.'],
    ],
    rootCause: 'The gateway sent callbacks in bursts and the webhook worker took one at a time.',
    by: 'rami',
  },
];

/** How many nightly integrity runs to seed: two weeks, as long as the other jobs' history. */
const INTEGRITY_NIGHTS = 14;

const isEmpty = async (
  db: DbExecutor,
  table: typeof s.alertRules | typeof s.alertEvents | typeof s.incidents,
): Promise<number> => (await db.select({ n: sql<number>`count(*)::int` }).from(table))[0]?.n ?? 0;

/** The ids of the named staff members that exist (a foreign key needs a real row), and their names as the identity seed has them. */
async function knownStaff(db: DbExecutor): Promise<Map<number, string>> {
  const rows = await db.select({ id: s.staffUsers.id, name: s.staffUsers.name }).from(s.staffUsers);
  return new Map(rows.map((row) => [row.id, row.name]));
}

/**
 * Seeds the ten alert rules and a month of resolved alerts.
 *
 * Why: the Alerts tab shows rules and history through the real API in the shape of the mock's calm story; every alert carries the snapshot of its rule
 * as the evaluator writes it (health-commissions-5) and the subject key the unique index uses.
 *
 * @param db the transaction to write with
 * @param demo the loaded demo state (its clock)
 * @param staff the staff members that exist
 * @returns one report per table; a table that already has rows is left alone
 */
async function seedRulesAndAlerts(db: DbExecutor, demo: DemoSeed, staff: Map<number, string>): Promise<SeedReport[]> {
  const reports: SeedReport[] = [];
  const staffId = (name: keyof typeof STAFF): number | null => (staff.has(STAFF[name]) ? STAFF[name] : null);

  const existingRules = await isEmpty(db, s.alertRules);
  if (existingRules > 0) reports.push({ table: 'alert_rules', inserted: 0, existing: existingRules });
  else {
    reports.push(
      await insertRows(
        db,
        s.alertRules,
        RULES.map((rule, index) => ({
          id: index + 1,
          key: rule.key,
          name: rule.name,
          metric: rule.metric,
          comparator: rule.comparator,
          threshold: rule.threshold.toFixed(4),
          windowSeconds: rule.windowSeconds,
          severity: rule.severity,
          channels: rule.channels,
          isActive: rule.isActive ?? true,
          mutedUntil: rule.mutedHours ? new Date(demo.now + rule.mutedHours * HOUR) : null,
          createdBy: staffId('rami'),
          createdAt: new Date(demo.now - rule.createdDaysAgo * DAY),
          updatedAt: new Date(demo.now - rule.createdDaysAgo * DAY),
        })),
      ),
    );
    await syncIdentity(db, s.alertRules);
  }

  const existingAlerts = await isEmpty(db, s.alertEvents);
  if (existingAlerts > 0) reports.push({ table: 'alert_events', inserted: 0, existing: existingAlerts });
  else {
    const rules = new Map((await db.select().from(s.alertRules)).map((rule) => [rule.key, rule]));
    const rows = [...HISTORY].reverse().flatMap((alert, index) => {
      const rule = rules.get(alert.rule);
      if (!rule) return [];
      const startedAt = new Date(demo.now - alert.startedAgo);
      const ackBy = alert.ackBy ? staffId(alert.ackBy) : null;
      return [
        {
          id: index + 1,
          ruleId: rule.id,
          ruleName: rule.name,
          metric: rule.metric,
          comparator: rule.comparator,
          threshold: rule.threshold,
          windowSeconds: rule.windowSeconds,
          unit: unitOf(rule.metric),
          status: 'resolved' as const,
          severity: rule.severity,
          value: alert.value.toFixed(4),
          subjectType: alert.subject.type,
          subjectId: alert.subject.id,
          subjectLabel: alert.subject.label,
          subjectKey:
            alert.subject.type === 'system'
              ? 'system'
              : alert.subject.type === 'queue'
                ? `queue:${alert.subject.label}`
                : `${alert.subject.type}:${alert.subject.id}`,
          startedAt,
          acknowledgedBy: ackBy,
          acknowledgedAt:
            alert.ackAfter !== undefined && ackBy !== null ? new Date(startedAt.getTime() + alert.ackAfter) : null,
          resolvedAt: new Date(startedAt.getTime() + alert.lasted),
          note: alert.note ?? null,
          createdAt: startedAt,
          updatedAt: new Date(startedAt.getTime() + alert.lasted),
        },
      ];
    });
    reports.push(await insertRows(db, s.alertEvents, rows));
    await syncIdentity(db, s.alertEvents);
  }
  return reports;
}

/**
 * Seeds four resolved incidents with their timelines.
 *
 * @param db the transaction to write with
 * @param demo the loaded demo state (its clock)
 * @param staff the staff members that exist
 * @returns one report; a table that already has rows is left alone
 */
async function seedIncidents(db: DbExecutor, demo: DemoSeed, staff: Map<number, string>): Promise<SeedReport> {
  const existing = await isEmpty(db, s.incidents);
  if (existing > 0) return { table: 'incidents', inserted: 0, existing };
  const rows = INCIDENTS.map((incident, index) => {
    const startedAt = demo.now - incident.startedAgo;
    const by = STAFF[incident.by];
    const actor = staff.has(by) ? { id: by, name: staff.get(by) ?? STAFF_NAMES[by] } : null;
    const last = incident.lines[incident.lines.length - 1]!;
    const lastAt = new Date(startedAt + last[0] * MINUTE);
    return {
      id: index + 1,
      title: incident.title,
      severity: incident.severity,
      status: 'resolved' as const,
      components: incident.components,
      summary: incident.summary,
      timeline: incident.lines.map(([minutes, status, text]) => ({
        at: new Date(startedAt + minutes * MINUTE).toISOString(),
        status,
        text,
        by: actor,
      })),
      rootCause: incident.rootCause,
      startedAt: new Date(startedAt),
      resolvedAt: lastAt,
      createdBy: actor?.id ?? null,
      resolvedBy: actor?.id ?? null,
      createdAt: new Date(startedAt),
      updatedAt: lastAt,
    };
  });
  const report = await insertRows(db, s.incidents, rows);
  await syncIdentity(db, s.incidents);
  return report;
}

/**
 * Seeds two weeks of clean nightly integrity runs.
 *
 * Why: the Integrity tab reads the last finished run of `ledger_integrity`; a fresh database has no run until the first night, and an empty tab
 * is a worse demo than a passing one. The counters are those of the seeded ledger now; the run's `result` has the shape the job writes (B99).
 * Written only when no integrity run exists, so the worker's own runs are never mixed with demo ones.
 *
 * @param db the transaction to write with
 * @param demo the loaded demo state (its clock)
 * @returns one report; a table that already has integrity runs is left alone
 */
async function seedIntegrityRuns(db: DbExecutor, demo: DemoSeed): Promise<SeedReport> {
  const [existing] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(s.jobRuns)
    .where(eq(s.jobRuns.job, INTEGRITY_JOB));
  if ((existing?.n ?? 0) > 0) return { table: 'job_runs', inserted: 0, existing: existing?.n ?? 0 };

  const count = async (
    table: typeof s.ledgerAccounts | typeof s.ledgerEntries | typeof s.ledgerTransactions,
  ): Promise<number> => (await db.select({ n: sql<number>`count(*)::int` }).from(table))[0]?.n ?? 0;
  const totals = {
    accountsChecked: await count(s.ledgerAccounts),
    entriesChecked: await count(s.ledgerEntries),
    transactionsChecked: await count(s.ledgerTransactions),
  };
  const checks = CHECK_KEYS.map((key) => checkResult(key, 0, [], null));
  const dueOffset = 2 * HOUR + 30 * MINUTE;
  const lastDue = Math.floor((demo.now - dueOffset) / DAY) * DAY + dueOffset;
  const rows = Array.from({ length: INTEGRITY_NIGHTS }, (_, index) => {
    const startedAt = new Date(lastDue - (INTEGRITY_NIGHTS - 1 - index) * DAY + 800 + ((index * 337) % 1200));
    const duration = 2_100 + ((index * 211) % 700);
    return { startedAt, duration };
  })
    .filter((night) => night.startedAt.getTime() < demo.now)
    .map((night) => ({
      job: INTEGRITY_JOB,
      trigger: 'schedule' as const,
      status: 'succeeded' as const,
      startedAt: night.startedAt,
      finishedAt: new Date(night.startedAt.getTime() + night.duration),
      durationMs: night.duration,
      processed: totals.accountsChecked,
      result: integrityResult(checks, totals),
      createdAt: night.startedAt,
      updatedAt: new Date(night.startedAt.getTime() + night.duration),
    }));
  const report = await insertRows(db, s.jobRuns, rows);
  await syncIdentity(db, s.jobRuns);
  return report;
}

/**
 * Seeds the alert rules, alerts, incidents and integrity runs of the health module.
 *
 * @param db the transaction to write with
 * @param demo the loaded frontend demo state
 * @returns one report per table written or skipped
 */
export async function seedHealthAlerts(db: DbExecutor, demo: DemoSeed): Promise<SeedReport[]> {
  const staff = await knownStaff(db);
  return [
    ...(await seedRulesAndAlerts(db, demo, staff)),
    await seedIncidents(db, demo, staff),
    await seedIntegrityRuns(db, demo),
  ];
}
