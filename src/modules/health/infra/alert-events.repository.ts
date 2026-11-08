// Drizzle queries on `alert_events` (health module, feature 12b): the alert list and one alert with the rule key, the staff name and the
// incident, the acknowledge, and the evaluator's guarded insert and resolve. Staff names come from `staff_users` (identity owns it) and the
// rule key from `alert_rules` with plain joins: identity exports no reader of staff names, and the alert rule is this module's own table.
import { and, eq, inArray, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { ParsedListQuery } from '../../../common/contract';
import { type DbExecutor, type ListColumns, listOrderBy, listWhere, schema as s } from '../../../infra/db';
import { type AlertEvent, type NewAlertEvent, alertEvents, alertRules, incidents } from '../db/schema';

/** The fields `GET /admin/alerts` can sort, filter and search on. */
export type AlertListField = 'id' | 'startedAt' | 'severity' | 'status';

/** An alert with what the wire adds: the rule's key, who acknowledged it and the incident declared from it. */
export interface AlertRow {
  readonly alert: AlertEvent;
  readonly ruleKey: string;
  readonly acknowledgedBy: { readonly id: number; readonly name: string } | null;
  readonly incidentId: number | null;
}

const COLUMNS: ListColumns = {
  id: alertEvents.id,
  startedAt: alertEvents.startedAt,
  severity: alertEvents.severity,
  status: alertEvents.status,
  // `open=true` is "firing or acknowledged" (ANSWERS Q28): a boolean filter over this expression.
  open: sql`(${alertEvents.status} <> 'resolved')`,
  'rule.name': alertEvents.ruleName,
  subjectLabel: alertEvents.subjectLabel,
  note: alertEvents.note,
};

const acknowledger = alias(s.staffUsers, 'acknowledger');

const withNames = (db: DbExecutor) =>
  db
    .select({
      alert: alertEvents,
      ruleKey: alertRules.key,
      staffId: acknowledger.id,
      staffName: acknowledger.name,
      incidentId: incidents.id,
    })
    .from(alertEvents)
    .innerJoin(alertRules, eq(alertRules.id, alertEvents.ruleId))
    .leftJoin(acknowledger, eq(acknowledger.id, alertEvents.acknowledgedBy))
    .leftJoin(incidents, eq(incidents.alertEventId, alertEvents.id));

const toRow = (row: {
  alert: AlertEvent;
  ruleKey: string;
  staffId: number | null;
  staffName: string | null;
  incidentId: number | null;
}): AlertRow => ({
  alert: row.alert,
  ruleKey: row.ruleKey,
  acknowledgedBy: row.staffId === null || row.staffName === null ? null : { id: row.staffId, name: row.staffName },
  incidentId: row.incidentId,
});

/**
 * Lists alerts.
 *
 * @param db the database or a transaction
 * @param query the parsed list request
 * @returns the page of alerts and the exact total
 */
export async function listAlertRows(
  db: DbExecutor,
  query: ParsedListQuery<AlertListField>,
): Promise<{ rows: AlertRow[]; total: number }> {
  const where = listWhere(query, COLUMNS);
  const [rows, [count]] = await Promise.all([
    withNames(db)
      .where(where)
      .orderBy(...listOrderBy(query.sort, COLUMNS, alertEvents.id))
      .limit(query.range.limit)
      .offset(query.range.start),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(alertEvents)
      .where(where),
  ]);
  return { rows: rows.map(toRow), total: count?.total ?? 0 };
}

/**
 * Finds one alert with its names.
 *
 * @param db the database or a transaction
 * @param id the alert id
 * @returns the alert, or `undefined`
 */
export async function findAlertRow(db: DbExecutor, id: number): Promise<AlertRow | undefined> {
  const [row] = await withNames(db).where(eq(alertEvents.id, id)).limit(1);
  return row ? toRow(row) : undefined;
}

/**
 * Locks an alert for the rest of the transaction.
 *
 * @param tx the transaction
 * @param id the alert id
 * @returns the alert, or `undefined`
 */
export async function lockAlert(tx: DbExecutor, id: number): Promise<AlertEvent | undefined> {
  const [row] = await tx.select().from(alertEvents).where(eq(alertEvents.id, id)).for('update').limit(1);
  return row;
}

/**
 * Acknowledges a firing alert.
 *
 * Why: the update is guarded by `status = 'firing'`, so two clicks (or two staff members) acknowledge once; the loser changes nothing.
 *
 * @param tx the transaction
 * @param id the alert id
 * @param staffId who acknowledged
 * @param note the note, or `null`
 * @param now the clock's time
 * @returns the acknowledged alert, or `undefined` when it was no longer firing
 */
export async function acknowledgeAlert(
  tx: DbExecutor,
  id: number,
  staffId: number,
  note: string | null,
  now: Date,
): Promise<AlertEvent | undefined> {
  const [row] = await tx
    .update(alertEvents)
    .set({ status: 'acknowledged', acknowledgedBy: staffId, acknowledgedAt: now, note })
    .where(and(eq(alertEvents.id, id), eq(alertEvents.status, 'firing')))
    .returning();
  return row;
}

/** An alert that is firing or acknowledged, as the evaluator needs it. */
export interface OpenAlertRef {
  readonly id: number;
  readonly ruleId: number;
  readonly subjectKey: string;
}

/**
 * The alerts that are not resolved, for some rules.
 *
 * @param db the database
 * @param ruleIds the rules
 * @returns the open alerts (at most one per rule and subject: the partial unique index)
 */
export async function openAlertsOfRules(db: DbExecutor, ruleIds: readonly number[]): Promise<OpenAlertRef[]> {
  if (ruleIds.length === 0) return [];
  return db
    .select({ id: alertEvents.id, ruleId: alertEvents.ruleId, subjectKey: alertEvents.subjectKey })
    .from(alertEvents)
    .where(and(inArray(alertEvents.ruleId, [...ruleIds]), sql`${alertEvents.status} <> 'resolved'`));
}

/**
 * Opens an alert unless the rule already has an open one for the subject.
 *
 * Why: "one open alert per rule and subject, never paged twice": the partial unique index `alert_events_open_uq` decides, so two
 * overlapping evaluation runs (a schedule tick and a manual run) open it once and only the winner notifies.
 *
 * @param db the database or a transaction
 * @param values the alert, with the rule's snapshot
 * @returns the new alert, or `undefined` when one was already open
 */
export async function insertAlertIfNoOpen(db: DbExecutor, values: NewAlertEvent): Promise<AlertEvent | undefined> {
  const [row] = await db
    .insert(alertEvents)
    .values(values)
    .onConflictDoNothing({
      target: [alertEvents.ruleId, alertEvents.subjectKey],
      where: sql`${alertEvents.status} <> 'resolved'`,
    })
    .returning();
  return row;
}

/**
 * Resolves one open alert.
 *
 * @param db the database or a transaction
 * @param id the alert id
 * @param now the clock's time
 * @returns the resolved alert, or `undefined` when it was already resolved
 */
export async function resolveAlertRow(db: DbExecutor, id: number, now: Date): Promise<AlertEvent | undefined> {
  const [row] = await db
    .update(alertEvents)
    .set({ status: 'resolved', resolvedAt: now })
    .where(and(eq(alertEvents.id, id), sql`${alertEvents.status} <> 'resolved'`))
    .returning();
  return row;
}

/**
 * The alerts of some rules that are firing (not acknowledged, not resolved): the ones whose message is repeated.
 *
 * @param db the database
 * @param ruleIds the rules
 * @returns the firing alerts, oldest first
 */
export async function firingAlertsOfRules(db: DbExecutor, ruleIds: readonly number[]): Promise<AlertEvent[]> {
  if (ruleIds.length === 0) return [];
  return db
    .select()
    .from(alertEvents)
    .where(and(inArray(alertEvents.ruleId, [...ruleIds]), eq(alertEvents.status, 'firing')))
    .orderBy(alertEvents.startedAt, alertEvents.id);
}

/**
 * Resolves every open alert of a rule (the rule was switched off, deleted or now watches another metric).
 *
 * @param db the database or a transaction
 * @param ruleId the rule
 * @param now the clock's time
 * @returns the alerts that were closed (the caller sends their "resolved" messages in the same transaction)
 */
export async function resolveOpenAlertsOfRule(db: DbExecutor, ruleId: number, now: Date): Promise<AlertEvent[]> {
  return db
    .update(alertEvents)
    .set({ status: 'resolved', resolvedAt: now })
    .where(and(eq(alertEvents.ruleId, ruleId), sql`${alertEvents.status} <> 'resolved'`))
    .returning();
}
