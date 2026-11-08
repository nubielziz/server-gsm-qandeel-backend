// Helpers for the alert, incident and integrity tests (feature 12b): rules, suppliers with calls, and alerts inserted the way the evaluator
// leaves them, so the read routes can be tested without running the evaluator.
import { type Database, schema as s } from '../../src/infra/db';
import type { AlertNotice } from '../../src/modules/health';
import type { AlertEvent, AlertRule, NewAlertEvent, NewAlertRule } from '../../src/modules/health/db/schema';

let counter = 0;

/** Inserts an alert rule (default: supplier timeouts over 20 % for 3 minutes, critical, Telegram and email). */
export async function insertRule(db: Database, overrides: Partial<NewAlertRule> = {}): Promise<AlertRule> {
  counter += 1;
  const [row] = await db
    .insert(s.alertRules)
    .values({
      key: `rule_${counter}`,
      name: `Rule ${counter}`,
      metric: 'supplier.timeout_rate',
      comparator: 'gt',
      threshold: '20.0000',
      windowSeconds: 180,
      severity: 'critical',
      channels: ['telegram', 'email'],
      ...overrides,
    })
    .returning();
  return row!;
}

/** Inserts a supplier (default active, balance read). */
export async function insertSupplier(
  db: Database,
  name: string,
  options: { status?: 'active' | 'disabled' | 'paused'; balance?: string; balanceCheckedAt?: Date | null } = {},
): Promise<number> {
  const [row] = await db
    .insert(s.suppliers)
    .values({
      name,
      driver: 'dhru',
      baseUrl: 'https://supplier.example',
      paramFormat: 'dhru_xml',
      status: options.status ?? 'active',
      ...(options.balance === undefined ? {} : { balance: options.balance }),
      ...(options.balanceCheckedAt === undefined ? {} : { balanceCheckedAt: options.balanceCheckedAt }),
    })
    .returning({ id: s.suppliers.id });
  return row!.id;
}

/** Adds call-log rows of a supplier at a moment. */
export async function addCalls(
  db: Database,
  supplierId: number,
  outcomes: Array<'ok' | 'error' | 'timeout'>,
  at: Date,
): Promise<void> {
  await db
    .insert(s.supplierApiLogs)
    .values(
      outcomes.map((outcome) => ({ supplierId, action: 'placeimeiorder', outcome, durationMs: 400, createdAt: at })),
    );
}

/** Inserts an alert of a rule as the evaluator writes it: the rule's snapshot, the value and the subject. */
export async function insertAlert(
  db: Database,
  rule: AlertRule,
  overrides: Partial<NewAlertEvent> & { startedAt: Date },
): Promise<AlertEvent> {
  const subjectType = overrides.subjectType ?? 'system';
  const [row] = await db
    .insert(s.alertEvents)
    .values({
      ruleId: rule.id,
      ruleName: rule.name,
      metric: rule.metric,
      comparator: rule.comparator,
      threshold: rule.threshold,
      windowSeconds: rule.windowSeconds,
      unit: 'percent',
      severity: rule.severity,
      value: '23.4000',
      subjectType,
      subjectId: overrides.subjectId ?? null,
      subjectKey:
        subjectType === 'system' ? 'system' : `${subjectType}:${overrides.subjectId ?? overrides.subjectLabel}`,
      ...overrides,
    })
    .returning();
  return row!;
}

/** Copies only the named fields of an object, so an assertion prints and compares plain values (never a transaction or another huge object). */
export function pick<T extends object, K extends keyof T>(source: T, keys: readonly K[]): Pick<T, K> {
  const copy = {} as Pick<T, K>;
  for (const key of keys) copy[key] = source[key];
  return copy;
}

/**
 * The notice of one call of a spy on the alert notifier (`fired`, `reminded`, `resolved`).
 *
 * The notifier's first argument is the database transaction, the notice is the second: a failing assertion on the transaction once printed its whole
 * object graph and ran a test process out of memory, so tests read the notice here and compare plain fields of it with {@link pick}.
 */
export function noticeOfCall(spy: { mock: { calls: unknown[][] } }, index = 0): AlertNotice {
  const call = spy.mock.calls[index];
  if (!call) throw new Error(`The notifier was called ${spy.mock.calls.length} time(s), not ${index + 1}.`);
  return call[1] as AlertNotice;
}
