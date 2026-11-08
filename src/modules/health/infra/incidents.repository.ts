// Drizzle queries on `incidents` (health module, feature 12b): the list and one incident with the staff names, the lock, insert and change,
// and the check that an alert exists. Staff names come from `staff_users` (identity owns it) with plain joins, like the alert reads.
import { eq, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { ParsedListQuery } from '../../../common/contract';
import { type DbExecutor, type ListColumns, listOrderBy, listWhere, schema as s } from '../../../infra/db';
import { type Incident, type NewIncident, alertEvents, incidents } from '../db/schema';

/** The fields `GET /admin/incidents` can sort, filter and search on. */
export type IncidentListField = 'id' | 'startedAt' | 'severity' | 'status';

/** An incident with the names of the staff members who declared and closed it. */
export interface IncidentRow {
  readonly incident: Incident;
  readonly createdBy: { readonly id: number; readonly name: string } | null;
  readonly resolvedBy: { readonly id: number; readonly name: string } | null;
}

const COLUMNS: ListColumns = {
  id: incidents.id,
  startedAt: incidents.startedAt,
  severity: incidents.severity,
  status: incidents.status,
  // `open=true` is every status but resolved (ANSWERS Q9).
  open: sql`(${incidents.status} <> 'resolved')`,
  title: incidents.title,
  summary: incidents.summary,
};

const creator = alias(s.staffUsers, 'creator');
const closer = alias(s.staffUsers, 'closer');

const withNames = (db: DbExecutor) =>
  db
    .select({
      incident: incidents,
      creatorId: creator.id,
      creatorName: creator.name,
      closerId: closer.id,
      closerName: closer.name,
    })
    .from(incidents)
    .leftJoin(creator, eq(creator.id, incidents.createdBy))
    .leftJoin(closer, eq(closer.id, incidents.resolvedBy));

const ref = (id: number | null, name: string | null) => (id === null || name === null ? null : { id, name });

const toRow = (row: {
  incident: Incident;
  creatorId: number | null;
  creatorName: string | null;
  closerId: number | null;
  closerName: string | null;
}): IncidentRow => ({
  incident: row.incident,
  createdBy: ref(row.creatorId, row.creatorName),
  resolvedBy: ref(row.closerId, row.closerName),
});

/**
 * Lists incidents.
 *
 * @param db the database or a transaction
 * @param query the parsed list request
 * @returns the page of incidents and the exact total
 */
export async function listIncidentRows(
  db: DbExecutor,
  query: ParsedListQuery<IncidentListField>,
): Promise<{ rows: IncidentRow[]; total: number }> {
  const where = listWhere(query, COLUMNS);
  const [rows, [count]] = await Promise.all([
    withNames(db)
      .where(where)
      .orderBy(...listOrderBy(query.sort, COLUMNS, incidents.id))
      .limit(query.range.limit)
      .offset(query.range.start),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(incidents)
      .where(where),
  ]);
  return { rows: rows.map(toRow), total: count?.total ?? 0 };
}

/**
 * Finds one incident with its staff names.
 *
 * @param db the database or a transaction
 * @param id the incident id
 * @returns the incident, or `undefined`
 */
export async function findIncidentRow(db: DbExecutor, id: number): Promise<IncidentRow | undefined> {
  const [row] = await withNames(db).where(eq(incidents.id, id)).limit(1);
  return row ? toRow(row) : undefined;
}

/**
 * Locks an incident for the rest of the transaction.
 *
 * @param tx the transaction
 * @param id the incident id
 * @returns the incident, or `undefined`
 */
export async function lockIncident(tx: DbExecutor, id: number): Promise<Incident | undefined> {
  const [row] = await tx.select().from(incidents).where(eq(incidents.id, id)).for('update').limit(1);
  return row;
}

/**
 * Inserts an incident.
 *
 * @param db the transaction
 * @param values the incident
 * @returns the new row
 */
export async function insertIncident(db: DbExecutor, values: NewIncident): Promise<Incident> {
  const [row] = await db.insert(incidents).values(values).returning();
  if (!row) throw new Error('Inserting an incident returned no row.');
  return row;
}

/**
 * Changes an incident.
 *
 * @param db the transaction that holds the lock
 * @param id the incident id
 * @param changes the columns to change
 * @returns the updated row
 */
export async function updateIncidentRow(db: DbExecutor, id: number, changes: Partial<NewIncident>): Promise<Incident> {
  const [row] = await db.update(incidents).set(changes).where(eq(incidents.id, id)).returning();
  if (!row) throw new Error('Updating an incident returned no row.');
  return row;
}

/**
 * Whether an alert exists, and the incident already declared from it.
 *
 * @param db the database or a transaction
 * @param alertId the alert id
 * @returns `undefined` for no such alert; otherwise the incident id declared from it, or `null`
 */
export async function incidentOfAlert(
  db: DbExecutor,
  alertId: number,
): Promise<{ incidentId: number | null } | undefined> {
  const [row] = await db
    .select({ id: alertEvents.id, incidentId: incidents.id })
    .from(alertEvents)
    .leftJoin(incidents, eq(incidents.alertEventId, alertEvents.id))
    .where(eq(alertEvents.id, alertId))
    .limit(1);
  return row ? { incidentId: row.incidentId } : undefined;
}
