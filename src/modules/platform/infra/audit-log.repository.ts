// Drizzle queries of the audit log routes on `audit_logs` (platform module). The table is append-only: these are reads only;
// the writes are `AuditService.record`.
import { eq, sql } from 'drizzle-orm';
import type { ParsedListQuery } from '../../../common/contract';
import { type DbExecutor, type ListColumns, listOrderBy, listWhere } from '../../../infra/db';
import { type AuditLog, auditLogs } from '../db/schema';

const COLUMNS: ListColumns = {
  actorType: auditLogs.actorType,
  actorId: auditLogs.actorId,
  entityType: auditLogs.entityType,
  entityId: auditLogs.entityId,
  actorName: auditLogs.actorName,
  action: auditLogs.action,
  entityLabel: auditLogs.entityLabel,
  createdAt: auditLogs.createdAt,
  id: auditLogs.id,
};

const DAY_MS = 86_400_000;

/**
 * Lists audit entries for `GET /admin/audit-logs`.
 *
 * @param db the database or a transaction
 * @param query the parsed list request, with the `from` and `to` days (UTC, both included)
 * @returns the page of entries and the exact total for the filter
 */
export async function listAuditRows(
  db: DbExecutor,
  query: ParsedListQuery<'createdAt' | 'id', { from?: string | undefined; to?: string | undefined }>,
): Promise<{ rows: AuditLog[]; total: number }> {
  const { from, to } = query.extra;
  // `to` is a whole day: everything before the start of the next day.
  const where = listWhere(
    query,
    COLUMNS,
    from === undefined ? undefined : sql`${auditLogs.createdAt} >= ${new Date(`${from}T00:00:00.000Z`)}`,
    to === undefined
      ? undefined
      : sql`${auditLogs.createdAt} < ${new Date(Date.parse(`${to}T00:00:00.000Z`) + DAY_MS)}`,
  );
  const [rows, [count]] = await Promise.all([
    db
      .select()
      .from(auditLogs)
      .where(where)
      .orderBy(...listOrderBy(query.sort, COLUMNS, auditLogs.id))
      .limit(query.range.limit)
      .offset(query.range.start),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(auditLogs)
      .where(where),
  ]);
  return { rows, total: count?.total ?? 0 };
}

/**
 * Finds one audit entry.
 *
 * @param db the database or a transaction
 * @param id the entry id
 * @returns the entry, or `undefined`
 */
export async function findAuditRow(db: DbExecutor, id: number): Promise<AuditLog | undefined> {
  const [row] = await db.select().from(auditLogs).where(eq(auditLogs.id, id)).limit(1);
  return row;
}
