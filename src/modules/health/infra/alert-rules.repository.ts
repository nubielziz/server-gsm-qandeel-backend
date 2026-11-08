// Drizzle queries on `alert_rules` (health module, feature 12b): the rule list with its computed `open` flag, one rule, the key check,
// insert, change and soft delete, and the rules the evaluator runs. A deleted rule keeps its row (`deleted_at`, B102, B116) so the alerts
// it fired keep their rule.
import { and, eq, sql } from 'drizzle-orm';
import type { ParsedListQuery } from '../../../common/contract';
import { type DbExecutor, type ListColumns, listOrderBy, listWhere } from '../../../infra/db';
import { type AlertRule, type NewAlertRule, alertRules } from '../db/schema';

/** The fields `GET /admin/alert-rules` can sort and search on. */
export type AlertRuleListField = 'id' | 'name' | 'key' | 'severity' | 'createdAt';

/** A rule with whether one of its alerts is firing or acknowledged right now. */
export interface AlertRuleRow {
  readonly rule: AlertRule;
  readonly open: boolean;
}

const COLUMNS: ListColumns = {
  id: alertRules.id,
  name: alertRules.name,
  key: alertRules.key,
  severity: alertRules.severity,
  createdAt: alertRules.createdAt,
  metric: alertRules.metric,
  isActive: alertRules.isActive,
};

/**
 * `exists` an alert of the rule that is not resolved: the rule's `open` flag, computed (endpoint doc).
 *
 * Written with table names, not column objects: Drizzle leaves the table off a column of a single-table select, which would make `id` in
 * the subquery the alert's own id.
 */
const isOpen = sql<boolean>`exists (select 1 from alert_events ae where ae.rule_id = alert_rules.id and ae.status <> 'resolved')`;

/**
 * Lists the rules that are not deleted.
 *
 * @param db the database or a transaction
 * @param query the parsed list request
 * @returns the page of rules and the exact total
 */
export async function listRuleRows(
  db: DbExecutor,
  query: ParsedListQuery<AlertRuleListField>,
): Promise<{ rows: AlertRuleRow[]; total: number }> {
  const where = listWhere(query, COLUMNS, sql`${alertRules.deletedAt} is null`);
  const [rows, [count]] = await Promise.all([
    db
      .select({ rule: alertRules, open: isOpen })
      .from(alertRules)
      .where(where)
      .orderBy(...listOrderBy(query.sort, COLUMNS, alertRules.id))
      .limit(query.range.limit)
      .offset(query.range.start),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(alertRules)
      .where(where),
  ]);
  return { rows, total: count?.total ?? 0 };
}

/**
 * Finds a rule that is not deleted, with its `open` flag.
 *
 * @param db the database or a transaction
 * @param id the rule id
 * @returns the rule, or `undefined` for an unknown or deleted one
 */
export async function findRuleRow(db: DbExecutor, id: number): Promise<AlertRuleRow | undefined> {
  const [row] = await db
    .select({ rule: alertRules, open: isOpen })
    .from(alertRules)
    .where(and(eq(alertRules.id, id), sql`${alertRules.deletedAt} is null`))
    .limit(1);
  return row;
}

/**
 * Locks a rule that is not deleted for the rest of the transaction.
 *
 * @param tx the transaction
 * @param id the rule id
 * @returns the rule, or `undefined`
 */
export async function lockRule(tx: DbExecutor, id: number): Promise<AlertRule | undefined> {
  const [row] = await tx
    .select()
    .from(alertRules)
    .where(and(eq(alertRules.id, id), sql`${alertRules.deletedAt} is null`))
    .for('update')
    .limit(1);
  return row;
}

/**
 * Locks a rule for sharing if it is still switched on and not deleted.
 *
 * Why: the evaluator opens an alert from a copy of the rule it read earlier in the run. Taking this lock in the transaction that inserts the alert
 * orders it with a change of the rule (which locks the row `for update`): either the alert is committed first and the change then resolves it
 * (`resolveOpenAlertsOfRule`), or the change commits first and this finds the rule off, deleted or edited and the evaluator opens nothing.
 *
 * @param tx the transaction
 * @param id the rule id
 * @returns the rule as it is now, or `undefined` when it was switched off or deleted
 */
export async function lockActiveRuleForShare(tx: DbExecutor, id: number): Promise<AlertRule | undefined> {
  const [row] = await tx
    .select()
    .from(alertRules)
    .where(and(eq(alertRules.id, id), eq(alertRules.isActive, true), sql`${alertRules.deletedAt} is null`))
    .for('share')
    .limit(1);
  return row;
}

/**
 * Whether another rule that is not deleted already uses a key.
 *
 * @param db the database or a transaction
 * @param key the key
 * @param exceptId a rule to leave out (the one being changed)
 * @returns true when the key is taken
 */
export async function ruleKeyTaken(db: DbExecutor, key: string, exceptId?: number): Promise<boolean> {
  const [row] = await db
    .select({ id: alertRules.id })
    .from(alertRules)
    .where(
      and(
        eq(alertRules.key, key),
        sql`${alertRules.deletedAt} is null`,
        exceptId === undefined ? undefined : sql`${alertRules.id} <> ${exceptId}`,
      ),
    )
    .limit(1);
  return row !== undefined;
}

/**
 * Inserts a rule.
 *
 * @param db the database or a transaction
 * @param values the rule
 * @returns the new row
 */
export async function insertRule(db: DbExecutor, values: NewAlertRule): Promise<AlertRule> {
  const [row] = await db.insert(alertRules).values(values).returning();
  if (!row) throw new Error('Inserting an alert rule returned no row.');
  return row;
}

/**
 * Changes a rule.
 *
 * @param db the transaction that holds the lock
 * @param id the rule id
 * @param changes the columns to change
 * @returns the updated row
 */
export async function updateRuleRow(db: DbExecutor, id: number, changes: Partial<NewAlertRule>): Promise<AlertRule> {
  const [row] = await db.update(alertRules).set(changes).where(eq(alertRules.id, id)).returning();
  if (!row) throw new Error('Updating an alert rule returned no row.');
  return row;
}

/**
 * Soft-deletes a rule: it stops alerting and disappears from the list, its alerts keep it.
 *
 * @param db the transaction that holds the lock
 * @param id the rule id
 * @param now the clock's time
 * @param staffId the staff member who deleted it
 */
export async function softDeleteRule(db: DbExecutor, id: number, now: Date, staffId: number): Promise<void> {
  await db.update(alertRules).set({ deletedAt: now, updatedBy: staffId }).where(eq(alertRules.id, id));
}

/**
 * The rules the evaluator runs: switched on and not deleted (a muted rule is still evaluated, it only fires nothing new).
 *
 * @param db the database
 * @returns the rules by id
 */
export async function activeRules(db: DbExecutor): Promise<AlertRule[]> {
  return db
    .select()
    .from(alertRules)
    .where(and(eq(alertRules.isActive, true), sql`${alertRules.deletedAt} is null`))
    .orderBy(alertRules.id);
}
